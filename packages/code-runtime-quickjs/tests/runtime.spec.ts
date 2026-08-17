import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import { QuickJsCodeRuntime } from '../src/index.ts'
import { executeQuickJs, internals } from '../src/runtime.ts'

const config = {
  maxWallMs: 10_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  maxOutputBytes: 1024 * 1024,
}

async function setup(overrides = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(QuickJsCodeRuntime, { ...config, ...overrides })
  return { runtime: ctx.codeRuntime, dispose: () => fiber.dispose() }
}

describe('QuickJsCodeRuntime', () => {
  it('rejects wall ceilings that Node timers cannot represent', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(QuickJsCodeRuntime, { ...config, maxWallMs: 2_147_483_648 })).rejects.toThrow('Node timer maximum')
  })
  it('typechecks and bridges lossless JSON calls', async () => {
    const { runtime, dispose } = await setup()
    const result = await runtime.run({
      program: 'console.log("running"); return await tools.echo({ value: 2 })',
      bindings: [{ global: 'tools', functions: { echo: async args => args as never } }],
    })
    expect(result).toEqual({ logs: ['running'], value: { value: 2 } })
    await dispose()
  })

  it('reports unknown members before starting QuickJS', async () => {
    const { runtime, dispose } = await setup()
    const result = await runtime.run({
      program: 'return await tools.missing({})',
      bindings: [{ global: 'tools', functions: { echo: async () => null } }],
    })
    expect(result.error).toMatchObject({ kind: 'exception' })
    expect(result.error?.message).toContain('TypeScript check failed')
    expect(result.error?.message).toContain('missing')
    await dispose()
  })

  it('includes cold WASM initialization in the wall deadline', async () => {
    const originalLoader = internals.moduleLoader
    internals.resetModule()
    let loaderCalled = false
    internals.moduleLoader = () => {
      loaderCalled = true
      return new Promise(() => {})
    }
    try {
      const result = await executeQuickJs('', new Map(), {
        maxWallMs: 20,
        memoryLimitBytes: config.memoryLimitBytes,
        maxStackBytes: config.maxStackBytes,
        maxOutputBytes: config.maxOutputBytes,
      })
      expect(result.error?.kind).toBe('timeout')
      expect(loaderCalled).toBe(true)
    } finally {
      internals.moduleLoader = originalLoader
      internals.resetModule()
    }
  })

  it('keeps the deadline gate private from guest global mutation', async () => {
    const { runtime, dispose } = await setup()
    const controller = new AbortController()
    const run = runtime.run({
      program: '(globalThis as any).__dshExecutionGate = new Promise(() => {}); return await new Promise(() => {})',
      bindings: [],
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error('private gate abort')), 10)
    const result = await run
    expect(result.error).toMatchObject({ kind: 'abort', message: 'private gate abort' })
    await dispose()
  })

  it('supports every portable binding global even when it resembles a JS runtime slot', async () => {
    const { runtime, dispose } = await setup()
    const names = ['Promise', 'print', 'globalThis', '__dshMain', '__dshExecutionGate', 'Object', 'Error']
    const result = await runtime.run({
      program: `return [
        await Promise.value(null), await print.value(null), await globalThis.value(null),
        await __dshMain.value(null), await __dshExecutionGate.value(null),
        await Object.value(null), await Error.value(null),
      ]`,
      bindings: names.map(global => ({
        global,
        functions: { value: async () => global },
      })),
    })
    expect(result.value).toEqual(names)
    await dispose()
  })

  it('rejects oversized compiler input before TypeScript parsing', async () => {
    const { runtime, dispose } = await setup({ maxSourceBytes: 128 })
    const result = await runtime.run({ program: `return ${JSON.stringify('x'.repeat(256))}`, bindings: [] })
    expect(result.error).toMatchObject({ kind: 'exception' })
    expect(result.error?.message).toContain('configured source limit')
    await dispose()
  })

  it('charges TypeScript checking to the wall deadline', async () => {
    const { runtime, dispose } = await setup({ maxWallMs: 1 })
    const result = await runtime.run({ program: 'return null', bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('TypeScript checking')
    await dispose()
  })

  it('interrupts a synchronous loop at the wall deadline', async () => {
    const { runtime, dispose } = await setup({ maxWallMs: 500 })
    const result = await runtime.run({ program: 'while (true) {}', bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    await dispose()
  })

  it('aborts an asynchronous binding wait', async () => {
    const { runtime, dispose } = await setup()
    const controller = new AbortController()
    const run = runtime.run({
      program: 'return await tools.wait(null)',
      bindings: [{ global: 'tools', functions: { wait: async () => await new Promise<never>(() => {}) } }],
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error('cancelled by test')), 10)
    const result = await run
    expect(result.error).toMatchObject({ kind: 'abort', message: 'cancelled by test' })
    await dispose()
  })


  it('does not resolve guest imports through the host filesystem', async () => {
    const { runtime, dispose } = await setup()
    const result = await runtime.run({ program: 'return await import("node:fs")', bindings: [] })
    expect(result.error).toMatchObject({ kind: 'exception' })
    expect(result.error?.message).toContain('Cannot find')
    await dispose()
  })

  it('does not retain guest globals between runs', async () => {
    const { runtime, dispose } = await setup()
    const first = await runtime.run({
      program: '(globalThis as any).leak = 1; return typeof (globalThis as any).process',
      bindings: [],
    })
    const second = await runtime.run({
      program: 'return (globalThis as any).leak ?? null',
      bindings: [],
    })
    expect(first.value).toBe('undefined')
    expect(second.value).toBeNull()
    await dispose()
  })

  it('materializes declared binding rejection classes inside the guest', async () => {
    const { runtime, dispose } = await setup()
    const result = await runtime.run({
      program: 'try { await tools.fail(null) } catch (error) { return { name: (error as Error).name, toolName: (error as ToolCallError).toolName } }',
      bindings: [{
        global: 'tools',
        functions: { fail: async () => { throw new Error('denied') } },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      }],
    })
    expect(result.value).toEqual({ name: 'ToolCallError', toolName: 'fail' })
    await dispose()
  })

  it('supports a portable rejection class whose name resembles a JS built-in', async () => {
    const { runtime, dispose } = await setup()
    const result = await runtime.run({
      program: 'try { await tools.fail(null) } catch (error) { return { matched: error instanceof Promise, member: (error as Promise).toolName } }',
      bindings: [{
        global: 'tools',
        functions: { fail: async () => { throw new Error('denied') } },
        errorClass: { name: 'Promise', memberNameProperty: 'toolName' },
      }],
    })
    expect(result.value).toEqual({ matched: true, member: 'fail' })
    await dispose()
  })

  it('fails closed when the serialized completion exceeds the output cap', async () => {
    const { runtime, dispose } = await setup({ maxOutputBytes: 128 })
    const result = await runtime.run({ program: 'return "x".repeat(1_000)', bindings: [] })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.value).toBeUndefined()
    await dispose()
  })

  it('aborts and drains an in-flight run when its provider fiber disposes', async () => {
    const { runtime, dispose } = await setup()
    const run = runtime.run({
      program: 'return await tools.wait(null)',
      bindings: [{ global: 'tools', functions: { wait: async () => await new Promise<never>(() => {}) } }],
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    await dispose()
    await expect(run).resolves.toMatchObject({ error: { kind: 'abort', message: 'runtime disposed' } })
  })

  it('rejects malformed binding namespaces as caller misuse', async () => {
    const { runtime, dispose } = await setup()
    await expect(runtime.run({
      program: 'return null',
      bindings: [{ global: 'console', functions: {} }],
    })).rejects.toThrow(/reserved binding global/)
    await dispose()
  })
})
