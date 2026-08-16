import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { QuickJsCodeRuntime } from '../src/index.ts'

const config = {
  maxWallMs: 1_000,
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

  it('interrupts a synchronous loop at the wall deadline', async () => {
    const { runtime, dispose } = await setup({ maxWallMs: 20 })
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
