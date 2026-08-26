import { describe, expect, it, vi } from 'vitest'
import { Context } from '@monotykamary/cordis'
import AgentLoop from '@monotykamary/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@monotykamary/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@monotykamary/dsh-llm'
import { SessionId } from '@monotykamary/dsh-session'
import SubagentRuntime from '@monotykamary/dsh-subagent'
import * as spawn from '@monotykamary/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@monotykamary/dsh-workflow-worker-thread'
import * as delegation from '../src/tool.ts'

vi.setConfig({ testTimeout: 30_000 })

function response(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 11, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class RoutingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await new Promise(resolve => setTimeout(resolve, options.model.includes('slow') ? 30 : 5))
    yield * response('result from ' + options.provider + '/' + options.model)
  }
}

async function setup() {
  const ctx = new Context()
  const main = new RoutingAdapter()
  const cheap = new RoutingAdapter()
  const strong = new RoutingAdapter()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn', maxConcurrentAgents: 4 })
  ctx.llm.registerAdapter(['main'], main)
  ctx.llm.registerAdapter(['cheap'], cheap)
  ctx.llm.registerAdapter(['strong'], strong)
  await ctx.plugin(delegation, {
    aliases: {},
    mainModel: 'main/expensive',
    cheapModel: 'cheap/worker-slow',
    defaultModel: 'cheap/worker-fast',
    strongModel: 'strong/reviewer',
    validatorModel: 'strong/validator',
    maxParallelWorkers: 4,
    maxWorkersPerDelegation: 8,
    maxDelegationDepth: 1,
    autoPolicy: 'prefer',
  })
  const parent = ctx.agentLoop.create(SessionId('delegation-parent'), { provider: 'main', model: 'expensive' })
  const controller = new AbortController()
  const execute = (arguments_: Record<string, unknown>) => ctx.tools.execute({
    callId: 'delegation-call' as never,
    name: 'delegate',
    arguments: arguments_ as never,
    signal: controller.signal,
    agent: parent,
  })
  return { ctx, main, cheap, strong, parent, execute, controller }
}

describe('delegate over the real DSH workflow and spawn stack', () => {
  it('proves configured cheap routing from child request facts and runs independent workers together', async () => {
    const { ctx, main, cheap, parent, execute } = await setup()
    const starts: Array<{ childId: string; at: number }> = []
    const ends: Array<{ seq: number; at: number }> = []
    const observedRoutes: Array<[string, string]> = []
    ctx.on('workflow/agent-start', (_run, child) => { starts.push({ childId: String(child.childId), at: Date.now() }) })
    ctx.on('workflow/agent-end', (_run, child) => { ends.push({ seq: child.seq, at: Date.now() }) })
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'request/context' && event.data.provider === 'cheap') observedRoutes.push([event.data.provider, event.data.model])
    })

    const result = await execute({
      label: 'parallel inspection',
      tasks: [
        { label: 'scan', task: 'scan tests', tier: 'cheap' },
        { label: 'map', task: 'map API', tier: 'default' },
      ],
      parallel: true,
      max_parallel: 2,
    })

    expect(result.isError).toBe(false)
    const value = result.value as { workers: Array<Record<string, unknown>>; verificationRequired: boolean }
    expect(value.verificationRequired).toBe(true)
    expect((result.value as { orchestrator: unknown }).orchestrator).toEqual({
      requested: { provider: 'main', model: 'expensive' },
      actual: { provider: 'main', model: 'expensive' },
      routingVerified: true,
    })
    expect(value.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'scan', output: 'result from cheap/worker-slow' }),
      expect.objectContaining({ label: 'map', output: 'result from cheap/worker-fast' }),
      expect.objectContaining({ label: 'scan', requested: { provider: 'cheap', model: 'worker-slow' }, actual: { provider: 'cheap', model: 'worker-slow' }, routingVerified: true }),
      expect.objectContaining({ label: 'map', requested: { provider: 'cheap', model: 'worker-fast' }, actual: { provider: 'cheap', model: 'worker-fast' }, routingVerified: true }),
    ]))
    expect(main.requests).toHaveLength(0)
    expect(cheap.requests.map(request => request.model).sort()).toEqual(['worker-fast', 'worker-slow'])
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(Math.max(...starts.map(start => start.at))).toBeLessThanOrEqual(Math.min(...ends.map(end => end.at)))

    expect(observedRoutes.sort()).toEqual([
      ['cheap', 'worker-fast'],
      ['cheap', 'worker-slow'],
    ])
    expect(parent.session.events.filter(event => event.type === 'tool-workflow/agent-start')).toHaveLength(2)
  })

  it('rejects recursive delegation from a delegated child session', async () => {
    const { ctx } = await setup()
    const handle = await ctx.agents.create({
      sessionId: SessionId('delegation-child'),
      meta: { origin: 'subagent', parentSession: SessionId('delegation-parent'), delegationDepth: 1 },
      agentOptions: { provider: 'cheap', model: 'worker-fast' },
    })
    try {
      const result = await ctx.tools.execute({
        callId: 'recursive-delegation-call' as never,
        name: 'delegate',
        arguments: { tasks: [{ label: 'nested', task: 'delegate again', tier: 'cheap' }] },
        signal: new AbortController().signal,
        agent: handle.agent,
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('coordinator-only') })]))
      expect(handle.agent.session.events.some(event => event.type === 'tool-workflow/run-start')).toBe(false)
    } finally {
      await handle.dispose()
    }
  })

  it('keeps every configured worker visible when a budget stops later batches', async () => {
    const { execute } = await setup()
    const result = await execute({
      tasks: [
        { label: 'first', task: 'run first', tier: 'cheap' },
        { label: 'second', task: 'run second', tier: 'cheap' },
        { label: 'third', task: 'run third', tier: 'cheap' },
      ],
      parallel: false,
      token_budget: 1,
    })
    expect(result.isError).toBe(false)
    const value = result.value as { status: string; workers: Array<Record<string, unknown>> }
    expect(value.status).toBe('budget-exhausted')
    expect(value.workers).toHaveLength(3)
    expect(value.workers).toEqual([
      expect.objectContaining({ label: 'first', outcome: 'completed' }),
      expect.objectContaining({ label: 'second', outcome: 'cancelled', output: null }),
      expect.objectContaining({ label: 'third', outcome: 'cancelled', output: null }),
    ])
  })

  it('uses the configured validator route after workers settle', async () => {
    const { ctx, strong, execute } = await setup()
    const result = await execute({
      tasks: [{ label: 'inspect', task: 'inspect one API', tier: 'cheap' }],
      validate: true,
    })
    expect(result.isError).toBe(false)
    expect(strong.requests.map(request => request.model)).toEqual(['validator'])
    const value = result.value as { validation: unknown; validator: Record<string, unknown>; totalTokens: number }
    expect(value.validation).toContain('strong/validator')
    expect(value.validator).toEqual(expect.objectContaining({ label: 'validator', actual: { provider: 'strong', model: 'validator' }, routingVerified: true, outcome: 'completed' }))
    expect(value.totalTokens).toBeGreaterThan(0)
  })
})
