/** QuickJS WASM implementation of DSH's existing CodeRuntime service. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CodeRuntime,
  DUNDER_MEMBER,
  PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS,
  RESERVED_ERROR_MEMBERS,
} from '@deepseek-ai/dsh-code-runtime'
import type {
  CodeBindingNamespace,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'
import { compileQuickJsProgram } from './type-checker.ts'
import { executeQuickJs } from './runtime.ts'

/** QuickJS runtime budgets. */
export interface Config {
  maxWallMs?: number
  memoryLimitBytes?: number
  maxStackBytes?: number
  maxOutputBytes?: number
}

type ResolvedConfig = Required<Config>
type LiveRun = { controller: AbortController; promise: Promise<CodeRunResult> }

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Fresh-context QuickJS provider with host-side TypeScript checking. */
export class QuickJsCodeRuntime extends CodeRuntime {
  static Config: z<Config> = z.object({
    maxWallMs: z.number().default(600_000),
    memoryLimitBytes: z.number().default(536_870_912),
    maxStackBytes: z.number().default(262_144),
    maxOutputBytes: z.number().default(67_108_864),
  })

  readonly language = 'typescript'
  readonly isolation = 'quickjs-wasm'

  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`dsh-fabric QuickJS config.${key} must be a positive safe integer`)
    }
    if (this.config.maxWallMs > 2_147_483_647) throw new TypeError('dsh-fabric QuickJS maxWallMs exceeds the Node timer maximum')
    if (this.config.memoryLimitBytes > 0xffff_ffff) throw new TypeError('dsh-fabric QuickJS memoryLimitBytes exceeds the WASM32 maximum')
    if (this.config.maxOutputBytes < 128) throw new TypeError('dsh-fabric QuickJS maxOutputBytes must be at least 128')
    ctx.effect(() => () => this.teardown(), 'dsh-fabric.quickjsTeardown')
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-fabric QuickJS run() after disposal')
    const bindings = validateBindings(request.bindings)
    if (request.signal?.aborted) return failure('abort', abortMessage(request.signal))

    let checked: ReturnType<typeof compileQuickJsProgram>
    try {
      checked = compileQuickJsProgram(request.program, request.bindings)
    } catch (error: unknown) {
      return failure('exception', `TypeScript check failed: ${messageOf(error)}`)
    }
    if ('errors' in checked) {
      const detail = checked.errors.map(error => `${error.line}:${error.column} ${error.message}`).join('\n')
      return failure('exception', `TypeScript check failed:\n${detail}`)
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const live: LiveRun = {
      controller,
      promise: executeQuickJs(checked.code, bindings, { ...this.config, signal: controller.signal })
        .catch((error: unknown) => failure('worker-exit', `QuickJS substrate failed: ${messageOf(error)}`)),
    }
    this.live.add(live)
    try {
      return await live.promise
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      this.live.delete(live)
    }
  }

  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.controller.abort(new Error('runtime disposed'))
    await Promise.allSettled(runs.map(run => run.promise))
  }
}

function validateBindings(namespaces: readonly CodeBindingNamespace[]): Map<string, CodeBindingNamespace> {
  const bindings = new Map<string, CodeBindingNamespace>()
  for (const namespace of namespaces) {
    usableIdentifier(namespace.global, 'binding global')
    if (RESERVED_BINDING_GLOBALS.has(namespace.global)) throw new Error(`dsh-fabric QuickJS reserved binding global ${JSON.stringify(namespace.global)}`)
    if (bindings.has(namespace.global)) throw new Error(`dsh-fabric QuickJS duplicate binding global ${JSON.stringify(namespace.global)}`)
    bindings.set(namespace.global, namespace)
  }
  const errorNames = new Set<string>()
  for (const namespace of namespaces) {
    const descriptor = namespace.errorClass
    if (descriptor === undefined) continue
    usableIdentifier(descriptor.name, 'binding error class')
    if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || bindings.has(descriptor.name) || errorNames.has(descriptor.name)) {
      throw new Error(`dsh-fabric QuickJS duplicate injected global ${JSON.stringify(descriptor.name)}`)
    }
    if (descriptor.memberNameProperty.length === 0
      || RESERVED_ERROR_MEMBERS.has(descriptor.memberNameProperty)
      || DUNDER_MEMBER.test(descriptor.memberNameProperty)) {
      throw new Error(`dsh-fabric QuickJS unusable binding error member ${JSON.stringify(descriptor.memberNameProperty)}`)
    }
    errorNames.add(descriptor.name)
  }
  return bindings
}

function usableIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value) || PORTABLE_RESERVED_WORDS.has(value)) {
    throw new Error(`dsh-fabric QuickJS ${label} ${JSON.stringify(value)} is not a usable identifier`)
  }
}

function failure(kind: CodeRunFailure['kind'], message: string): CodeRunResult {
  return { logs: [], error: { kind, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'execution aborted')
}

export default QuickJsCodeRuntime
