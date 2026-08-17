import { Buffer } from 'node:buffer'
import releaseSyncVariant from '@jitl/quickjs-singlefile-mjs-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import { snapshotJsonValue } from '@monotykamary/dsh-session'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunResult,
} from '@monotykamary/dsh-code-runtime'

export interface QuickJsExecutionOptions {
  maxWallMs: number
  memoryLimitBytes: number
  maxStackBytes: number
  maxOutputBytes: number
  signal?: AbortSignal
}

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>
let modulePromise: Promise<QuickJsModule> | undefined

export const internals = {
  moduleLoader: (): Promise<QuickJsModule> => newQuickJSWASMModuleFromVariant(releaseSyncVariant),
  resetModule(): void { modulePromise = undefined },
}

const quickJsModule = (): Promise<QuickJsModule> =>
  (modulePromise ??= internals.moduleLoader())

class QuickJsModuleDeadlineError extends Error {
  override readonly name = 'QuickJsModuleDeadlineError'
}

const SETUP_SOURCE = `
(() => {
  const bridge = globalThis.__dshHostCall;
  const specs = globalThis.__dshNamespaces;
  delete globalThis.__dshHostCall;
  delete globalThis.__dshNamespaces;
  const args = [Object.freeze({ log: print, info: print, warn: print, error: print, debug: print })];
  for (const spec of specs) {
    let ErrorClass;
    if (spec.errorClass) {
      ErrorClass = class extends Error {
        constructor(message, member) {
          super(message);
          this.name = spec.errorClass.name;
          Object.defineProperty(this, spec.errorClass.memberNameProperty, { enumerable: true, value: member });
        }
      };
    }
    const namespace = Object.create(null);
    for (const member of spec.names) {
      Object.defineProperty(namespace, member, {
        enumerable: true,
        value: async (value) => {
          try {
            return await bridge(spec.global, member, value);
          } catch (error) {
            if (ErrorClass) throw new ErrorClass(error instanceof Error ? error.message : String(error), member);
            throw error;
          }
        },
      });
    }
    args.push(Object.freeze(namespace));
    if (ErrorClass) args.push(ErrorClass);
  }
  return Object.freeze(args);
})()
`

const HOST_SETTLE_GRACE_MS = 250
const QUICKJS_GC_LIST_ASSERTION = 'list_empty(&rt->gc_obj_list)'

/** Execute checked JavaScript inside one fresh QuickJS context. */
export async function executeQuickJs(
  code: string,
  bindings: ReadonlyMap<string, CodeBindingNamespace>,
  options: QuickJsExecutionOptions,
): Promise<CodeRunResult> {
  if (options.signal?.aborted) return boundedFailure([], { kind: 'abort', message: abortMessage(options.signal) }, options.maxOutputBytes)
  const deadline = Date.now() + options.maxWallMs
  let module: QuickJsModule
  try {
    module = await moduleBeforeDeadline(quickJsModule(), options.signal, deadline)
  } catch (error: unknown) {
    if (options.signal?.aborted) return boundedFailure([], { kind: 'abort', message: abortMessage(options.signal) }, options.maxOutputBytes)
    if (error instanceof QuickJsModuleDeadlineError) {
      return boundedFailure([], { kind: 'timeout', message: error.message }, options.maxOutputBytes)
    }
    throw error
  }
  if (Date.now() >= deadline) {
    return boundedFailure([], { kind: 'timeout', message: `wall-clock ceiling reached (${options.maxWallMs}ms)` }, options.maxOutputBytes)
  }
  const context = module.newContext()
  const runtime = context.runtime
  runtime.setMemoryLimit(options.memoryLimitBytes)
  runtime.setMaxStackSize(options.maxStackBytes)
  let interrupted = false
  runtime.setInterruptHandler(() => {
    if (options.signal?.aborted === true || Date.now() > deadline) {
      interrupted = true
      return true
    }
    return false
  })

  const logs: string[] = []
  let outputExceeded = false
  let closing = false
  const pendingPromises = new Set<any>()
  const hostTasks = new Set<Promise<void>>()
  const hostAbort = new AbortController()
  const jsonObject = context.getProp(context.global, 'JSON')
  const jsonParse = context.getProp(jsonObject, 'parse')
  let activeHandle: any
  let gate: any
  let setupArguments: any
  let mainFunction: any
  let raceFunction: any
  let pendingResolution: Promise<any> | undefined
  let timer: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined

  const pump = (): void => { runtime.executePendingJobs() }
  const rejectGate = (message: string): void => {
    if (gate?.alive === false) return
    const error = context.newError(message)
    gate?.reject(error)
    error.dispose()
    pump()
  }
  const abortHost = (reason: string): void => {
    if (!hostAbort.signal.aborted) hostAbort.abort(new Error(reason))
  }

  try {
    const hostFunction = context.newFunction('__dshHostCall', (globalHandle: any, nameHandle: any, argsHandle: any) => {
      const global = context.getString(globalHandle)
      const name = context.getString(nameHandle)
      const promise = context.newPromise()
      pendingPromises.add(promise)
      void promise.settled.then(() => pendingPromises.delete(promise))
      const namespace = bindings.get(global)
      const fn = namespace !== undefined && Object.hasOwn(namespace.functions, name)
        ? namespace.functions[name]
        : undefined
      if (typeof fn !== 'function') {
        const error = context.newError(`unknown binding ${JSON.stringify(`${global}.${name}`)}`)
        promise.reject(error)
        error.dispose()
        return promise.handle
      }
      const args = snapshotJsonValue(context.dump(argsHandle))
      if (args === undefined) {
        const error = context.newError('binding arguments must be lossless JSON')
        promise.reject(error)
        error.dispose()
        return promise.handle
      }
      const task = raceWithAbort(Promise.resolve().then(() => fn(args)), hostAbort.signal)
        .then((value) => {
          if (closing || promise.alive === false) return
          const snapshot = snapshotJsonValue(value)
          if (snapshot === undefined) throw new Error('binding resolution must be lossless JSON')
          const handle = jsonHandle(context, jsonObject, jsonParse, snapshot)
          promise.resolve(handle)
          handle.dispose()
        })
        .catch((error: unknown) => {
          if (closing || promise.alive === false) return
          const handle = context.newError(messageOf(error))
          promise.reject(handle)
          handle.dispose()
        })
        .finally(() => { if (!closing) pump() })
      hostTasks.add(task)
      void task.finally(() => hostTasks.delete(task))
      return promise.handle
    })
    context.setProp(context.global, '__dshHostCall', hostFunction)
    hostFunction.dispose()

    const printFunction = context.newFunction('print', (...handles: any[]) => {
      if (outputExceeded) return
      const line = handles.map(handle => formatDump(context.dump(handle))).join(' ')
      const candidate = [...logs, line]
      if (payloadBytes({ logs: candidate }) > options.maxOutputBytes) {
        outputExceeded = true
        rejectGate('output limit exceeded')
        return
      }
      logs.push(line)
    })
    context.setProp(context.global, 'print', printFunction)
    printFunction.dispose()

    const specs = jsonHandle(context, jsonObject, jsonParse, [...bindings].map(([global, namespace]) => ({
      global,
      names: Object.keys(namespace.functions),
      ...(namespace.errorClass === undefined ? {} : { errorClass: namespace.errorClass }),
    })))
    context.setProp(context.global, '__dshNamespaces', specs)
    specs.dispose()

    const setup = context.evalCode(SETUP_SOURCE, 'dsh-fabric-quickjs-setup.js')
    if (setup.error) {
      const message = formatDump(context.dump(setup.error))
      setup.error.dispose()
      return boundedFailure(logs, { kind: 'exception', message }, options.maxOutputBytes)
    }
    setupArguments = setup.value
    const parameterNames = guestParameterNames(bindings)
    const factory = context.evalCode(
      `${code}\n__dsh_main__`,
      'dsh-fabric-guest-factory.js',
    )
    if (factory.error) {
      const message = formatDump(context.dump(factory.error))
      factory.error.dispose()
      return boundedFailure(logs, { kind: 'exception', message }, options.maxOutputBytes)
    }

    const argumentHandles = parameterNames.map((_, index) => context.getProp(setupArguments, String(index)))
    const instantiated = context.callFunction(factory.value, context.undefined, ...argumentHandles)
    factory.value.dispose()
    for (const handle of argumentHandles) handle.dispose()
    setupArguments.dispose()
    setupArguments = undefined
    if (instantiated.error) {
      const message = formatDump(context.dump(instantiated.error))
      instantiated.error.dispose()
      return boundedFailure(logs, { kind: 'exception', message }, options.maxOutputBytes)
    }
    mainFunction = instantiated.value

    gate = context.newPromise()
    const remainingMs = Math.max(1, deadline - Date.now())
    timer = setTimeout(() => {
      abortHost(`wall-clock ceiling reached (${options.maxWallMs}ms)`)
      rejectGate(`wall-clock ceiling reached (${options.maxWallMs}ms)`)
    }, remainingMs)
    abortHandler = () => {
      abortHost(abortMessage(options.signal))
      rejectGate(abortMessage(options.signal))
    }
    options.signal?.addEventListener('abort', abortHandler, { once: true })
    if (options.signal?.aborted) abortHandler()

    const race = context.evalCode(
      '(() => { const race = Promise.race.bind(Promise); return (main, gate) => race([main(), gate]); })()',
      'dsh-fabric-quickjs-race.js',
    )
    if (race.error) {
      const message = formatDump(context.dump(race.error))
      race.error.dispose()
      return boundedFailure(logs, { kind: 'exception', message }, options.maxOutputBytes)
    }
    raceFunction = race.value
    const evaluation = context.callFunction(raceFunction, context.undefined, mainFunction, gate.handle)
    raceFunction.dispose()
    raceFunction = undefined
    mainFunction.dispose()
    mainFunction = undefined
    pump()
    if (evaluation.error) {
      const message = formatDump(context.dump(evaluation.error))
      evaluation.error.dispose()
      return boundedFailure(logs, classifyFailure(message, options.signal, interrupted, deadline), options.maxOutputBytes)
    }
    activeHandle = evaluation.value
    pendingResolution = context.resolvePromise(activeHandle)
    pump()
    const resolution = await pendingResolution
    pendingResolution = undefined
    activeHandle.dispose()
    activeHandle = undefined
    if (resolution.error) {
      const message = formatDump(context.dump(resolution.error))
      resolution.error.dispose()
      const failure = outputExceeded
        ? { kind: 'output-limit' as const, message: 'serialized logs exceeded the configured output limit' }
        : classifyFailure(message, options.signal, interrupted, deadline)
      return boundedFailure(logs, failure, options.maxOutputBytes)
    }
    const dumped = context.dump(resolution.value)
    resolution.value.dispose()
    if (dumped === undefined) return boundResult({ logs }, options.maxOutputBytes)
    const value = snapshotJsonValue(dumped)
    if (value === undefined) {
      return boundedFailure(logs, { kind: 'invalid-output', message: 'completion value must be lossless JSON' }, options.maxOutputBytes)
    }
    return boundResult({ logs, value: value as CodeJsonValue }, options.maxOutputBytes)
  } catch (error: unknown) {
    return boundedFailure(logs, classifyFailure(messageOf(error), options.signal, interrupted, deadline), options.maxOutputBytes)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortHandler !== undefined) options.signal?.removeEventListener('abort', abortHandler)
    abortHost('QuickJS run settled')
    if (hostTasks.size > 0) await settleWithin(hostTasks, HOST_SETTLE_GRACE_MS)
    closing = true
    if (pendingPromises.size > 0) {
      const error = context.newError('QuickJS run settled before its host calls')
      for (const promise of pendingPromises) {
        if (promise.alive !== false) promise.reject(error)
      }
      error.dispose()
      pump()
      await settleWithin([...pendingPromises].map(promise => promise.settled), HOST_SETTLE_GRACE_MS)
      for (const promise of pendingPromises) {
        if (promise.alive !== false) promise.dispose()
      }
    }
    if (pendingResolution !== undefined) await Promise.race([pendingResolution.catch(() => undefined), delay(250)])
    if (setupArguments?.alive !== false) setupArguments?.dispose()
    if (mainFunction?.alive !== false) mainFunction?.dispose()
    if (raceFunction?.alive !== false) raceFunction?.dispose()
    if (activeHandle?.alive !== false) activeHandle?.dispose()
    if (gate?.alive !== false) gate?.dispose()
    pump()
    jsonParse.dispose()
    jsonObject.dispose()
    disposeContext(context)
  }
}

function guestParameterNames(bindings: ReadonlyMap<string, CodeBindingNamespace>): string[] {
  const names = ['console']
  for (const [global, namespace] of bindings) {
    names.push(global)
    if (namespace.errorClass !== undefined) names.push(namespace.errorClass.name)
  }
  return names
}

function moduleBeforeDeadline(
  operation: Promise<QuickJsModule>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<QuickJsModule> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new QuickJsModuleDeadlineError('wall-clock ceiling reached during QuickJS initialization'))
  return new Promise<QuickJsModule>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new QuickJsModuleDeadlineError('wall-clock ceiling reached during QuickJS initialization'))), remaining)
    const onAbort = () => finish(() => reject(signal?.reason))
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function classifyFailure(
  message: string,
  signal: AbortSignal | undefined,
  interrupted: boolean,
  deadline: number,
): CodeRunFailure {
  if (signal?.aborted) return { kind: 'abort', message: abortMessage(signal) }
  if (interrupted || Date.now() >= deadline) return { kind: 'timeout', message }
  return { kind: 'exception', message }
}

function boundResult(result: CodeRunResult, maxBytes: number): CodeRunResult {
  return payloadBytes(result) <= maxBytes
    ? result
    : boundedFailure([], { kind: 'output-limit', message: 'serialized result exceeded the configured output limit' }, maxBytes)
}

function boundedFailure(logs: string[], error: CodeRunFailure, maxBytes: number): CodeRunResult {
  const candidate: CodeRunResult = { logs, error }
  if (payloadBytes(candidate) <= maxBytes) return candidate
  const minimal: CodeRunResult = { logs: [], error: { kind: 'output-limit', message: 'output limit exceeded' } }
  return minimal
}

function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function jsonHandle(context: any, jsonObject: any, jsonParse: any, value: unknown): any {
  if (value === undefined) return context.undefined
  if (value === null) return context.null
  if (typeof value === 'string') return context.newString(value)
  if (typeof value === 'boolean') return value ? context.true : context.false
  if (typeof value === 'number') return context.newNumber(value)
  const serialized = context.newString(JSON.stringify(value))
  try {
    return context.unwrapResult(context.callFunction(jsonParse, jsonObject, serialized))
  } finally {
    serialized.dispose()
  }
}

function formatDump(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const stack = typeof record.stack === 'string' ? record.stack : ''
    const message = typeof record.message === 'string' ? record.message : ''
    // Prefer the message when present and carry the stack after it, so a
    // guest error never degrades to a bare stack frame (the message is the
    // disclosure diagnostic: unknown tool names, binding failures, …).
    if (message.length > 0) return stack.length > 0 ? message + '\n' + stack : message
    if (stack.length > 0) return stack
  }
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortMessage(signal: AbortSignal | undefined): string {
  const reason = signal?.reason
  return reason instanceof Error ? reason.message : typeof reason === 'string' && reason !== '' ? reason : 'execution aborted'
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function settleWithin(operations: Iterable<PromiseLike<unknown>>, timeoutMs: number): Promise<boolean> {
  const pending = [...operations].map(operation => Promise.resolve(operation))
  if (pending.length === 0) return true
  return await Promise.race([
    Promise.allSettled(pending).then(() => true),
    delay(timeoutMs).then(() => false),
  ])
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function disposeContext(context: any): void {
  try {
    context.dispose()
  } catch (error: unknown) {
    const message = messageOf(error)
    if (message.includes(QUICKJS_GC_LIST_ASSERTION) && message.includes('JS_FreeRuntime')) return
    throw error
  }
}
