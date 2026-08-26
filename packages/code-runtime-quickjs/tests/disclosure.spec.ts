import { describe, expect, it } from 'vitest'
import { compileQuickJsProgram, typeErrorRecoveryHint } from '../src/type-checker.ts'

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

  it('typechecks ToolRuntime-supplied discovery members as ordinary bindings', () => {
    const checked = compileQuickJsProgram('return await tools.describe("bash")', [
      { global: 'tools', functions: { describe: async () => null, call: async () => null } },
    ])
    expect('code' in checked).toBe(true)
  })
})
