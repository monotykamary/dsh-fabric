import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import { createScope, scopeOf } from '@monotykamary/dsh-scope'
import type { Scope, ScopeKey } from '@monotykamary/dsh-scope'
import SystemPrompt from '@monotykamary/dsh-system-prompt'
import * as FabricSystemPrompt from '../src/index.ts'

/**
 * Mint a scope whose holders resolve the systemPrompt service — the same
 * pattern the harness's own scoped tests use: the scoped context resolves
 * services through the MINTING plugin's dependency chain, so the minter must
 * inject what scope holders will reach.
 */
async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

/** The key a test scope was minted with. */
function scopeKeyOf(scope: Scope): ScopeKey {
  return scopeOf(scope.ctx)!
}

describe('@dsh-fabric/system-prompt', () => {
  it('registers the Fabric operating prompt and keeps the declared identity', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FabricSystemPrompt)

    const assembly = await ctx.systemPrompt.assemble({})
    const names = assembly.sections.map(section => section.name)

    expect(names).toContain('harness:identity')
    expect(names).toContain('deployment:persona')
    expect(names).toContain('fabric:system-prompt')
    const fabric = assembly.sections.find(section => section.name === 'fabric:system-prompt')
    expect(fabric?.text).toContain('# Fabric operating rules')
    expect(fabric?.text).toContain('fabric_mesh')
    expect(fabric?.text).toContain('TOOL_OUTCOME_UNKNOWN')
  })

  it('minimizes native per-tool prose while preserving structural and dynamic sections', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FabricSystemPrompt)

    // Simulate native per-tool guidance (dropped) beside structural and
    // dynamic sections the minimization must preserve.
    ctx.systemPrompt.section({ name: 'tool:bash', order: 105, text: 'bash guidance' })
    ctx.systemPrompt.section({ name: 'tool:read', order: 100, text: 'read guidance' })
    ctx.systemPrompt.section({ name: 'tool:report', order: 130, text: 'report guidance' })
    ctx.systemPrompt.section({ name: 'plan:policy', order: 110, text: 'plan policy' })
    ctx.systemPrompt.section({ name: 'tools:sdk', order: 150, text: 'sdk body' })
    ctx.systemPrompt.section({ name: 'tools:code-only', order: 140, text: 'code only' })
    ctx.systemPrompt.section({ name: 'fabric:mesh-guidance', order: 120, text: 'mesh guidance' })

    const assembly = await ctx.systemPrompt.assemble({})
    const names = assembly.sections.map(section => section.name)

    expect(names).not.toContain('tool:bash')
    expect(names).not.toContain('tool:read')
    expect(names).toContain('tool:report')
    expect(names).toContain('plan:policy')
    expect(names).toContain('tools:sdk')
    expect(names).toContain('tools:code-only')
    expect(names).toContain('fabric:mesh-guidance')
    expect(names).toContain('fabric:system-prompt')
  })

  it('preserves prompt variables and the tool-schema channel untouched', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FabricSystemPrompt)

    ctx.systemPrompt.variable('model', () => 'probe-model')
    const assembly = await ctx.systemPrompt.assemble({})
    expect(assembly.variables.model).toBe('probe-model')
  })
})

describe('progressive disclosure wiring', () => {
  it('splices the assembled tools:sdk catalog down to core tools', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const section = readFileSync(fileURLToPath(new URL('./fixtures/tools-sdk-section.txt', import.meta.url)), 'utf8')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FabricSystemPrompt)
    ctx.systemPrompt.section({ name: 'tools:sdk', order: 150, text: section })

    const assembly = await ctx.systemPrompt.assemble({})
    const sdk = assembly.sections.find(entry => entry.name === 'tools:sdk')
    expect(sdk?.text).toContain('The available tools:')
    expect(sdk?.text).toContain('ask_user_question')
    expect(sdk?.text).not.toContain('subagent')
    expect(sdk?.text).not.toContain('fabric_mesh')
    expect(sdk?.text).not.toContain('workflow')
  })
})

describe('fabric-scoped overlay', () => {
  it('minimizes only the fabric scope and leaves foreign scopes untouched', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const section = readFileSync(fileURLToPath(new URL('./fixtures/tools-sdk-section.txt', import.meta.url)), 'utf8')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    // The host-plane @dsh-fabric/host row provides the catalog in production;
    // the test stands in for it so the plugin's consume path resolves.
    ctx.provide('fabricDisclosure', new FabricSystemPrompt.DisclosureStore())

    const fabric = await mintScope(ctx, 'fabric')
    const foreign = await mintScope(ctx, 'foreign')

    // The overlay mounts in the fabric scope only; both scopes carry the same
    // native sections so the only difference is the overlay's presence.
    await fabric.ctx.plugin(FabricSystemPrompt)
    for (const scope of [fabric, foreign]) {
      scope.ctx.systemPrompt.section({ name: 'tool:bash', order: 105, text: 'bash guidance' })
      scope.ctx.systemPrompt.section({ name: 'tools:sdk', order: 150, text: section })
    }

    // Foreign scope: full native prose, no fabric section, SDK unspliced.
    const foreignAssembly = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(foreign) })
    const foreignNames = foreignAssembly.sections.map(entry => entry.name)
    expect(foreignNames).toContain('tool:bash')
    expect(foreignNames).not.toContain('fabric:system-prompt')
    const foreignSdk = foreignAssembly.sections.find(entry => entry.name === 'tools:sdk')
    expect(foreignSdk?.text).toContain('subagent')
    expect(foreignSdk?.text).toContain('fabric_mesh')

    // Fabric scope: per-tool guidance dropped, fabric section present, SDK spliced.
    const fabricAssembly = await ctx.systemPrompt.assemble({ scope: scopeKeyOf(fabric) })
    const fabricNames = fabricAssembly.sections.map(entry => entry.name)
    expect(fabricNames).not.toContain('tool:bash')
    expect(fabricNames).toContain('fabric:system-prompt')
    const fabricSdk = fabricAssembly.sections.find(entry => entry.name === 'tools:sdk')
    expect(fabricSdk?.text).toContain('The available tools:')
    expect(fabricSdk?.text).not.toContain('subagent')
    expect(fabricSdk?.text).not.toContain('fabric_mesh')
  })
})
