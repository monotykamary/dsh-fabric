import { Buffer } from 'node:buffer'
import releaseSyncVariant from '@jitl/quickjs-singlefile-mjs-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'

export interface QuickJsExecutionOptions {
  maxWallMs: number
  memoryLimitBytes: number
  maxStackBytes: number
  maxOutputBytes: number
  signal?: AbortSignal
}

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>
let modulePromise: Promise<QuickJsModule> | undefined

const quickJsModule = (): Promise<QuickJsModule> =>
  (modulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant))

const SETUP_SOURCE = `
(() => {
  const bridge = globalThis.__dshHostCall;
  const specs = globalThis.__dshNamespaces;
  delete globalThis.__dshHostCall;
  delete globalThis.__dshNamespaces;
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
      Object.defineProperty(globalThis, spec.errorClass.name, { configurable: true, value: ErrorClass });
    }
    const namespace = Object.create(null);
    for (const member of spec.names) {
      Object.defineProperty(namespace, member, {
        enumerable: true,
        value: async (args) => {
          try {
            return await bridge(spec.global, member, args);
          } catch (error) {
            if (ErrorClass) throw new ErrorClass(error instanceof Error ? error.message : String(error), member);
            throw error;
          }
        },
      });
    }
    Object.defineProperty(globalThis, spec.global, { configurable: true, value: Object.freeze(namespace) });
  }
  globalThis.console = Object.freeze({ log: print, info: print, warn: print, error: print, debug: print });
})();
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
  const module = await quickJsModule()
  const context = module.newContext()
  const runtime = context.runtime
  runtime.setMemoryLimit(options.memoryLimitBytes)
  runtime.setMaxStackSize(options.maxStackBytes)
  const deadline = Date.now() + options.maxWallMs
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
    setup.value.dispose()

    gate = context.newPromise()
    context.setProp(context.global, '__dshExecutionGate', gate.handle)
    timer = setTimeout(() => {
      abortHost(`wall-clock ceiling reached (${options.maxWallMs}ms)`)
      rejectGate(`wall-clock ceiling reached (${options.maxWallMs}ms)`)
    }, options.maxWallMs)
    abortHandler = () => {
      abortHost(abortMessage(options.signal))
      rejectGate(abortMessage(options.signal))
    }
    options.signal?.addEventListener('abort', abortHandler, { once: true })

    const evaluation = context.evalCode(
      `${code}\nPromise.race([globalThis.__dshMain(), globalThis.__dshExecutionGate])`,
      'dsh-fabric-guest.js',
    )
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
    if (activeHandle?.alive !== false) activeHandle?.dispose()
    if (gate?.alive !== false) gate?.dispose()
    pump()
    jsonParse.dispose()
    jsonObject.dispose()
    disposeContext(context)
  }
}

function classifyFailure(
  message: string,
  signal: AbortSignal | undefined,
  interrupted: boolean,
  deadline: number,
): CodeRunFailure {
  if (signal?.aborted) return { kind: 'abort', message: abortMessage(signal) }
  if (interrupted || Date.now() > deadline) return { kind: 'timeout', message }
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
    if (typeof record.stack === 'string') return record.stack
    if (typeof record.message === 'string') return record.message
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
