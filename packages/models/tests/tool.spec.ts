import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import SystemPrompt from '@monotykamary/dsh-system-prompt'
import ToolRuntime from '@monotykamary/dsh-tools'
import type { Agent, ModelSelection } from '@monotykamary/dsh-agent'
import type {
  ModelCatalogFailure,
  ModelProviderGroup,
  SessionModels,
  SessionModelTarget,
} from '@monotykamary/dsh-host-apiproxy'
import * as modelsTool from '../src/tool.ts'

let callNumber = 0
const AGENT = {} as Agent
const SIGNAL = new AbortController().signal

const GROUPS: ModelProviderGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  } as ModelProviderGroup,
  {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }],
  } as ModelProviderGroup,
]

class FakeSessionModels implements SessionModels {
  selection: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-chat' }
  readonly selections: string[] = []

  constructor(
    private readonly groups: readonly ModelProviderGroup[],
    private readonly available?: Set<string>,
  ) {}

  current(): ModelSelection {
    return { ...this.selection }
  }

  async catalog(): Promise<{ groups: ModelProviderGroup[]; failures: ModelCatalogFailure[] }> {
    return { groups: [...this.groups], failures: [] }
  }

  async select(_agent: Agent, target: SessionModelTarget): Promise<ModelSelection> {
    const key = `${target.provider}/${target.model}`
    const available = this.available
      ?? new Set(this.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`)))
    if (!available.has(key)) {
      throw new Error(`no adapter registered for provider "${target.provider}"`)
    }
    this.selection = {
      provider: target.provider,
      model: target.model,
      ...target.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: target.reasoningEffort as ModelSelection['reasoningEffort'] },
    }
    this.selections.push(key)
    return { ...this.selection }
  }
}

async function setup(options: {
  aliases?: Record<string, string | string[]>
  available?: Set<string>
  withService?: boolean
} = {}) {
  const { withService = true } = options
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const sessionModels = new FakeSessionModels(GROUPS, options.available)
  if (withService) ctx.provide('sessionModels', sessionModels)
  await ctx.plugin(modelsTool, { aliases: options.aliases ?? {} })

  async function execute(args: Record<string, unknown>) {
    return ctx.tools.execute({
      callId: `fabric-models-${String(++callNumber)}` as never,
      name: 'fabric_models',
      arguments: args,
      signal: SIGNAL,
      agent: AGENT,
    })
  }

  function text(result: Awaited<ReturnType<typeof execute>>): string {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content
    return content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('')
  }

  function value(result: Awaited<ReturnType<typeof execute>>): unknown {
    if ((result as { isError?: boolean }).isError) throw new Error(text(result))
    return JSON.parse(text(result))
  }

  return { ctx, execute, text, value, sessionModels }
}

describe('fabric_models', () => {
  it('registers the fabric_models schema with the three actions', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'fabric_models')
    expect(schema).toBeDefined()
    const action = (schema!.parameters as { properties: Record<string, { enum?: string[] }> }).properties.action
    expect(action.enum).toEqual(['current', 'list', 'select'])
  })

  it('reports the current selection', async () => {
    const { execute, value } = await setup()
    expect(await value(await execute({ action: 'current' }))).toEqual({
      current: { provider: 'deepseek-official', model: 'deepseek-chat' },
    })
  })

  it('lists the served catalog with configured alias names', async () => {
    const { execute, value } = await setup({ aliases: { cheap: 'openrouter/gemini-2.5-flash' } })
    const result = await value(await execute({ action: 'list' })) as {
      aliases: string[]
      groups: Array<{ id: string }>
    }
    expect(result.aliases).toEqual(['cheap'])
    expect(result.groups.map(group => group.id)).toEqual(['deepseek-official', 'openrouter'])
  })

  it('switches on an exact provider/model and reports the previous selection', async () => {
    const { execute, value } = await setup()
    const result = await value(await execute({ action: 'select', model: 'openrouter/gemini-2.5-flash' })) as {
      switched: boolean
      selected: ModelSelection
      previous: ModelSelection
    }
    expect(result.switched).toBe(true)
    expect(result.selected).toEqual({ provider: 'openrouter', model: 'gemini-2.5-flash' })
    expect(result.previous).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('keeps the selection when the target is already active', async () => {
    const { execute, value, sessionModels } = await setup()
    const result = await value(await execute({ action: 'select', model: 'deepseek-official/deepseek-chat' })) as {
      switched: boolean
    }
    expect(result.switched).toBe(false)
    expect(sessionModels.selections).toEqual([])
  })

  it('resolves aliases through fallback chains and records the alias used', async () => {
    const { execute, value } = await setup({
      aliases: { budget: ['missing/command-r', 'openrouter/gemini-2.5-flash'] },
    })
    const result = await value(await execute({ action: 'select', model: 'Budget' })) as {
      switched: boolean
      alias?: string
      selected: ModelSelection
    }
    expect(result).toMatchObject({
      switched: true,
      alias: 'budget',
      selected: { provider: 'openrouter', model: 'gemini-2.5-flash' },
    })
  })

  it('reports every tried target when an alias chain is exhausted', async () => {
    const { execute, text } = await setup({ aliases: { budget: ['missing/a', 'gone/b'] } })
    const result = await execute({ action: 'select', model: 'budget' })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text(result)).toContain('missing/a')
    expect(text(result)).toContain('gone/b')
  })

  it('resolves a unique search term through the catalog', async () => {
    const { execute, value } = await setup()
    const result = await value(await execute({ action: 'select', model: 'reasoner' })) as {
      switched: boolean
      selected: ModelSelection
      name?: string
    }
    expect(result.switched).toBe(true)
    expect(result.selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    expect(result.name).toBe('DeepSeek Reasoner')
  })

  it('rejects ambiguous search terms with the candidate list', async () => {
    const { execute, text } = await setup()
    const result = await execute({ action: 'select', model: 'deepseek-' })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text(result)).toContain('deepseek-official/deepseek-chat')
    expect(text(result)).toContain('deepseek-official/deepseek-reasoner')
  })

  it('rejects unknown selectors', async () => {
    const { execute, text } = await setup()
    const result = await execute({ action: 'select', model: 'nonexistent-model' })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text(result)).toContain('nonexistent-model')
  })

  it('surfaces adapter rejection for unserved exact targets', async () => {
    const { execute, text } = await setup()
    const result = await execute({ action: 'select', model: 'cohere/command-r' })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text(result)).toContain('no adapter registered')
  })

  it('requires a model selector for select', async () => {
    const { execute, text } = await setup()
    const result = await execute({ action: 'select' })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text(result)).toContain('requires a model')
  })

  it('passes reasoning_effort through a select', async () => {
    const { execute, value } = await setup()
    const result = await value(await execute({
      action: 'select',
      model: 'openrouter/gemini-2.5-flash',
      reasoning_effort: 'high',
    })) as { selected: ModelSelection }
    expect(result.selected).toEqual({
      provider: 'openrouter',
      model: 'gemini-2.5-flash',
      reasoningEffort: 'high',
    })
  })

  it('fails clearly without the API proxy host', async () => {
    const { execute, text } = await setup({ withService: false })
    const result = await execute({ action: 'current' })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(text(result)).toContain('requires the DSH API proxy host')
  })
})
