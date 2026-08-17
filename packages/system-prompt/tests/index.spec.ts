import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as FabricSystemPrompt from '../src/index.ts'

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
