import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import { DisclosureStore } from '@dsh-fabric/system-prompt'
import { QuickJsCodeRuntime } from '../src/index.ts'
import { compileQuickJsProgram, typeErrorRecoveryHint } from '../src/type-checker.ts'

const config = {
  maxWallMs: 10_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  maxOutputBytes: 1024 * 1024,
}

async function setup(store: DisclosureStore | undefined) {
  const ctx = new Context()
  if (store !== undefined) {
    await ctx.plugin({
      name: 'test-disclosure-provider',
      apply: (pluginCtx) => pluginCtx.provide('fabricDisclosure', store),
    })
  }
  const fiber = await ctx.plugin(QuickJsCodeRuntime, config)
  return { runtime: ctx.codeRuntime, dispose: () => fiber.dispose() }
}

describe('progressive-disclosure bindings', () => {
  it('tools.describe resolves the contract of a tool the prompt no longer lists', async () => {
    const store = new DisclosureStore()
    store.update('agent-1', [{ name: 'bash', description: 'Execute a bash command and return its output.', parameters: { command: { type: 'string' } } }])
    const { runtime, dispose } = await setup(store)
    const result = await runtime.run({
      program: 'return await tools.describe("bash")',
      bindings: [{ global: 'tools', functions: { read: async () => null } }],
    })
    expect(result).toEqual({
      logs: [],
      value: { name: 'bash', description: 'Execute a bash command and return its output.', parameters: { command: { type: 'string' } } },
    })
    await dispose()
  })

  it('tools.describe rejects unknown names with a diagnostic', async () => {
    const store = new DisclosureStore()
    const { runtime, dispose } = await setup(store)
    const result = await runtime.run({
      program: 'return await tools.describe("missing")',
      bindings: [{ global: 'tools', functions: { read: async () => null } }],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('unknown tool "missing"')
    await dispose()
  })

  it('tools.describe degrades cleanly when the disclosure catalog is absent', async () => {
    const { runtime, dispose } = await setup(undefined)
    const result = await runtime.run({
      program: 'return await tools.describe("bash")',
      bindings: [{ global: 'tools', functions: { read: async () => null } }],
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('does not list it')
    await dispose()
  })

  it('tools.call dispatches any bound tool through the ordinary binding map', async () => {
    const { runtime, dispose } = await setup(undefined)
    const result = await runtime.run({
      program: 'return await tools.call({ name: "echo", args: { value: 2 } })',
      bindings: [{ global: 'tools', functions: { echo: async (args) => args as never } }],
    })
    expect(result).toEqual({ logs: [], value: { value: 2 } })
    await dispose()
  })

  it('tools.call rejects unknown names', async () => {
    const { runtime, dispose } = await setup(undefined)
    const result = await runtime.run({
      program: 'return await tools.call({ name: "missing", args: null })',
      bindings: [{ global: 'tools', functions: { echo: async () => null } }],
    })
    expect(result.error?.message).toContain('unknown tool "missing"')
    await dispose()
  })

  it('keeps direct member calls untouched by the disclosure wrap', async () => {
    const { runtime, dispose } = await setup(undefined)
    const result = await runtime.run({
      program: 'return await tools.echo({ value: 7 })',
      bindings: [{ global: 'tools', functions: { echo: async (args) => args as never } }],
    })
    expect(result).toEqual({ logs: [], value: { value: 7 } })
    await dispose()
  })
})

describe('typeErrorRecoveryHint', () => {
  it('hints only for edit/write payload syntax failures', () => {
    const syntaxErrors = [{ line: 1, column: 1, message: "';' expected" }]
    expect(typeErrorRecoveryHint('return await tools.write({ path: "a", content: `x` })', syntaxErrors)).toContain('Recovery hint')
    expect(typeErrorRecoveryHint('const x = ;', syntaxErrors)).toBeUndefined()
    expect(typeErrorRecoveryHint('return await tools.write({ path: "a" })', [{ line: 1, column: 1, message: 'Type X is not assignable' }])).toBeUndefined()
  })

  it('appends the hint to a failing program check', () => {
    const checked = compileQuickJsProgram('const broken = ;\nreturn await tools.write({ path: "a", content: "b" })', [
      { global: 'tools', functions: { write: async () => null } },
    ])
    expect('errors' in checked).toBe(true)
    if ('errors' in checked) {
      expect(checked.errors.some(error => error.message.includes('Recovery hint'))).toBe(true)
    }
  })

  it('typechecks the disclosure members as ordinary bindings', () => {
    const checked = compileQuickJsProgram('return await tools.describe("bash")', [
      { global: 'tools', functions: { describe: async () => null, call: async () => null } },
    ])
    expect('code' in checked).toBe(true)
  })
})
