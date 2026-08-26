/** Fabric-native delegation Consumer over DSH workflow and session authorities. */
import type { Context } from '@monotykamary/cordis'
import z from '@monotykamary/schemastery'
import type { Agent } from '@monotykamary/dsh-agent'
import type { JsonValue, Session, SessionEventMap } from '@monotykamary/dsh-session'
import { snapshotJsonValue } from '@monotykamary/dsh-session'
import { defineTool } from '@monotykamary/dsh-tools'
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowRun, WorkflowRunInfo } from '@monotykamary/dsh-workflow'
import type {} from '@monotykamary/dsh-tool-workflow/types'
import { delegationGuidance, resolveWorkerRoute, routeForTier } from './policy.ts'
import type {
  FabricAutoDelegationPolicy,
  FabricDelegationResult,
  FabricDelegationTaskRecord,
  FabricDelegationWorkerResult,
  FabricObservedRoute,
  FabricWorkerTier,
} from './types.ts'

export const name = 'dsh-fabric-delegation'
export const inject = ['tools', 'systemPrompt', 'workflowEngine', 'sessions']

const TIERS = ['cheap', 'default', 'strong'] as const
const POLICIES = ['off', 'suggest', 'prefer'] as const
const WORKFLOW_SCRIPT = 'const results = await parallel(args.tasks.map((task) => async () => ({ index: task.index, output: await agent(task.prompt, { label: task.label, phase: "Workers", ...(task.provider === undefined ? {} : { provider: task.provider }), ...(task.model === undefined ? {} : { model: task.model }) }) }))); return results;'
const VALIDATOR_SCRIPT = 'phase("Validation"); return await agent(args.prompt, { label: "validator", phase: "Validation", provider: args.route.provider, model: args.route.model });'

export interface Config {
  aliases: Record<string, string | string[]>
  mainModel?: string
  cheapModel?: string
  defaultModel?: string
  strongModel?: string
  validatorModel?: string
  maxParallelWorkers: number
  maxWorkersPerDelegation: number
  maxDelegationDepth: number
  tokenBudget?: number
  autoPolicy: FabricAutoDelegationPolicy
}

export const Config: z<Config> = z.object({
  aliases: z.dict(z.union([z.string(), z.array(z.string())])).default({}),
  mainModel: z.string(),
  cheapModel: z.string(),
  defaultModel: z.string(),
  strongModel: z.string(),
  validatorModel: z.string(),
  maxParallelWorkers: z.number().step(1).min(1).default(6),
  maxWorkersPerDelegation: z.number().step(1).min(1).max(20).default(20),
  maxDelegationDepth: z.number().step(1).min(1).default(1),
  tokenBudget: z.number().step(1).min(1),
  autoPolicy: z.union(POLICIES.map(value => z.const(value))).default('suggest'),
})

type ResolvedConfig = Config & Required<Pick<Config, 'maxParallelWorkers' | 'maxWorkersPerDelegation' | 'maxDelegationDepth' | 'autoPolicy'>>
interface DelegateTaskInput { label: string; task: string; tier?: FabricWorkerTier }
interface DelegateArgs {
  label?: string
  tasks: DelegateTaskInput[]
  parallel?: boolean
  max_parallel?: number
  token_budget?: number
  validate?: boolean
}
interface WorkflowTask extends FabricDelegationTaskRecord { prompt: string }
interface ObservedChild { route?: FabricObservedRoute; tokens: number; output?: string }
interface RunRecord { tasks: readonly WorkflowTask[]; childIds: Map<number, string>; startedAt: Map<number, number> }

type AppendWorkflowEvent = <Type extends 'tool-workflow/run-start' | 'tool-workflow/agent-start' | 'tool-workflow/agent-end' | 'tool-workflow/run-end'>(
  type: Type,
  data: SessionEventMap[Type],
) => void

function json(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError('delegate produced a non-JSON value')
  return snapshot as JsonValue
}

function appendWorkflowEvent(session: Session): AppendWorkflowEvent {
  return session.append.bind(session) as AppendWorkflowEvent
}

function workflowName(kind: 'delegate' | 'validator', delegationId: string, offset = 0): string {
  return 'fabric-' + kind + '/' + encodeURIComponent(delegationId) + '/' + String(offset)
}

function taskPrompt(task: DelegateTaskInput): string {
  return task.task + '\n\nWork on this task directly. Do not delegate, spawn subagents, or start workflows. Return a concise, evidence-based result. Name exact files, commands, failures, and unresolved risks. Do not claim checks you did not run.'
}

function tokensFromSession(session: Session | undefined): number {
  if (session === undefined) return 0
  let total = 0
  for (const event of session.events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    const usage = event.data.usage
    total += usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.reasoningTokens ?? 0)
  }
  return total
}

function routeFromSession(session: Session | undefined): FabricObservedRoute | undefined {
  const context = session?.requestContext()
  if (context !== undefined) return { provider: context.provider, model: context.model }
  const config = session?.requestHeader()?.config
  return config?.provider === undefined || config.model === undefined ? undefined : { provider: config.provider, model: config.model }
}

function routeFromAgent(agent: Agent): FabricObservedRoute | undefined {
  return routeFromSession(agent.session)
    ?? (agent.options.provider === undefined || agent.options.model === undefined
      ? undefined
      : { provider: agent.options.provider, model: agent.options.model })
}

function finalAssistantText(session: Session | undefined): string | undefined {
  if (session === undefined) return undefined
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event?.type !== 'assistant/message') continue
    const text = event.data.message.content
      .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

function normalizeTasks(args: DelegateArgs, config: ResolvedConfig): WorkflowTask[] {
  if (args.tasks.length === 0) throw new Error('delegate requires at least one task')
  if (args.tasks.length > config.maxWorkersPerDelegation) {
    throw new Error('delegate received ' + String(args.tasks.length) + ' tasks; maxWorkersPerDelegation is ' + String(config.maxWorkersPerDelegation))
  }
  const labels = new Set<string>()
  return args.tasks.map((input, index) => {
    const label = input.label.trim()
    const task = input.task.trim()
    if (label === '' || task === '') throw new Error('delegate task ' + String(index + 1) + ' requires non-empty label and task')
    if (labels.has(label)) throw new Error('delegate task label "' + label + '" is duplicated')
    labels.add(label)
    const tier = input.tier ?? 'cheap'
    const route = routeForTier(tier, config)
    return { index, label, task, prompt: taskPrompt(input), tier, ...(route === undefined ? {} : route) }
  })
}

function observedRoute(observed: ReadonlyMap<string, ObservedChild>, childId: string, session: Session | undefined): FabricObservedRoute | undefined {
  return routeFromSession(session) ?? observed.get(childId)?.route
}

function observedTokens(observed: ReadonlyMap<string, ObservedChild>, childId: string, session: Session | undefined): number {
  const live = tokensFromSession(session)
  return live === 0 ? observed.get(childId)?.tokens ?? 0 : live
}

function registerObservers(
  ctx: Context,
  parent: Agent,
  runs: Map<string, RunRecord>,
  observed: Map<string, ObservedChild>,
): () => void {
  const append = appendWorkflowEvent(parent.session)
  const disposers = [
    ctx.on('session/event', (session, event) => {
      const childId = String(session.id)
      if (![...runs.values()].some(run => [...run.childIds.values()].includes(childId))) return
      const current = observed.get(childId) ?? { tokens: 0 }
      if (event.type === 'request/context') current.route = { provider: event.data.provider, model: event.data.model }
      if (event.type === 'assistant/message') {
        if (event.data.usage !== undefined) {
          const usage = event.data.usage
          current.tokens += usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.reasoningTokens ?? 0)
        }
        const text = event.data.message.content
          .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
          .join('\n')
          .trim()
        if (text !== '') current.output = text
      }
      observed.set(childId, current)
    }),
    ctx.on('workflow/agent-start', (info: WorkflowRunInfo, agent: WorkflowAgentInfo) => {
      const run = runs.get(String(info.id))
      const task = run?.tasks[agent.seq - 1]
      if (run === undefined || task === undefined) return
      const childId = String(agent.childId)
      run.childIds.set(agent.seq, childId)
      run.startedAt.set(agent.seq, Date.now())
      const session = ctx.sessions.get(agent.childId)
      const route = routeFromSession(session)
      const existing = observed.get(childId)
      observed.set(childId, {
        ...(existing ?? { tokens: 0 }),
        ...(route === undefined ? {} : { route }),
        tokens: tokensFromSession(session) || existing?.tokens || 0,
      })
      append('tool-workflow/agent-start', {
        runId: info.id,
        seq: agent.seq,
        label: task.label + ' · ' + task.tier + (task.model === undefined ? '' : ' · ' + task.model),
        phase: agent.phase ?? 'Workers',
        childId: agent.childId,
      })
    }),
    ctx.on('workflow/agent-end', (info: WorkflowRunInfo, agent: WorkflowAgentEndInfo) => {
      const run = runs.get(String(info.id))
      if (run === undefined || run.tasks[agent.seq - 1] === undefined) return
      append('tool-workflow/agent-end', { runId: info.id, seq: agent.seq, outcome: agent.outcome })
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

function workerResult(
  task: WorkflowTask,
  output: unknown,
  outcome: 'completed' | 'failed' | 'cancelled',
  seq: number,
  run: RunRecord,
  observed: ReadonlyMap<string, ObservedChild>,
  ctx: Context,
): FabricDelegationWorkerResult {
  const childId = run.childIds.get(seq)
  const session = childId === undefined ? undefined : ctx.sessions.get(childId as never)
  const actual = childId === undefined ? undefined : observedRoute(observed, childId, session)
  const tokens = childId === undefined ? 0 : observedTokens(observed, childId, session)
  const requested = task.provider === undefined || task.model === undefined ? undefined : { provider: task.provider, model: task.model }
  const sessionOutput = finalAssistantText(session) ?? (childId === undefined ? undefined : observed.get(childId)?.output)
  const resolvedOutput = output === undefined || output === null || output === '' ? sessionOutput ?? output : output
  return {
    index: task.index,
    label: task.label,
    task: task.task,
    tier: task.tier,
    ...(childId === undefined ? {} : { childId }),
    output: resolvedOutput ?? null,
    outcome,
    ...(requested === undefined ? {} : { requested }),
    ...(actual === undefined ? {} : { actual }),
    routingVerified: requested !== undefined
      && actual !== undefined
      && actual.provider === requested.provider
      && actual.model === requested.model,
    tokens,
    durationMs: Math.max(0, Date.now() - (run.startedAt.get(seq) ?? Date.now())),
  }
}

function collectResults(
  run: RunRecord,
  value: unknown,
  fallback: 'completed' | 'failed' | 'cancelled',
  observed: ReadonlyMap<string, ObservedChild>,
  ctx: Context,
): FabricDelegationWorkerResult[] {
  const rows = Array.isArray(value) ? value : []
  return run.tasks.map((task, offset) => {
    const row = rows.find(candidate => typeof candidate === 'object' && candidate !== null && (candidate as { index?: unknown }).index === task.index) as { output?: unknown } | undefined
    const childId = run.childIds.get(offset + 1)
    const session = childId === undefined ? undefined : ctx.sessions.get(childId as never)
    const hasOutput = row?.output !== undefined && row.output !== null && row.output !== '' || finalAssistantText(session) !== undefined || (childId !== undefined && observed.get(childId)?.output !== undefined)
    const outcome = hasOutput ? 'completed' : (fallback === 'completed' ? 'failed' : fallback)
    return workerResult(task, row?.output, outcome, offset + 1, run, observed, ctx)
  })
}

function stopOutcome(reason: 'completed' | 'cancelled' | 'error'): 'completed' | 'failed' | 'cancelled' {
  switch (reason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
  }
}

async function settleRun(
  run: WorkflowRun,
  record: RunRecord,
  append: AppendWorkflowEvent,
  runs: Map<string, RunRecord>,
): Promise<Awaited<WorkflowRun['result']>> {
  runs.set(String(run.id), record)
  append('tool-workflow/run-start', { runId: run.id, name: run.meta.name })
  const settled = await run.result
  try {
    await run.dispose()
  } finally {
    append('tool-workflow/run-end', { runId: run.id, stopReason: settled.stopReason })
    runs.delete(String(run.id))
  }
  return settled
}

/** Register the Fabric-native delegate tool and coordinator guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  for (const selector of [resolved.mainModel, resolved.cheapModel, resolved.defaultModel, resolved.strongModel, resolved.validatorModel]) {
    if (selector !== undefined) resolveWorkerRoute(selector, resolved.aliases)
  }
  ctx.systemPrompt.section({ name: 'fabric:delegation', order: 112, text: delegationGuidance(resolved) })
  ctx.tools.register(defineTool({
    name: 'delegate',
    description: 'Delegate a bounded set of independent tasks through native DSH workflows and subagents. Choose cheap for mechanical work, default for ordinary implementation, and strong for hard isolated reasoning. The result reports requested and observed child routes, token usage when available, and a mandatory parent-verification flag.',
    parameters: {
      label: { type: 'string', description: 'Short name for this delegation group.' },
      tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        label: { type: 'string', required: true, description: 'Short unique worker label.' },
        task: { type: 'string', required: true, description: 'Complete self-contained worker task.' },
        tier: { type: 'string', enum: TIERS, description: 'Worker routing tier; defaults to cheap.' },
      } } },
      parallel: { type: 'boolean', description: 'Run independent workers concurrently; defaults to true.' },
      max_parallel: { type: 'integer', description: 'Per-call concurrency cap bounded by deployment config.' },
      token_budget: { type: 'integer', description: 'Aggregate token budget checked between batches; an in-flight batch may cross it.' },
      validate: { type: 'boolean', description: 'Run one validator after task batches when validatorModel is configured.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => json({ kind: 'fabric-delegation', result: value }),
    },
    presentCall: args => ({ card: 'generic', title: 'delegate: ' + (args.label?.trim() || String(args.tasks.length) + ' workers'), rawInput: args.tasks }),
    presentResult: () => ({ card: 'generic' }),
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('delegate requires a DSH agent scope')
      const delegationDepth = parent.session.header.delegationDepth ?? 0
      if (delegationDepth >= resolved.maxDelegationDepth) {
        throw new Error('delegate is coordinator-only at delegation depth ' + String(delegationDepth) + '; complete the assigned task directly')
      }
      const tasks = normalizeTasks(args, resolved)
      const parallel = args.parallel ?? true
      const requestedParallel = args.max_parallel ?? resolved.maxParallelWorkers
      if (!Number.isSafeInteger(requestedParallel) || requestedParallel < 1 || requestedParallel > resolved.maxParallelWorkers) {
        throw new Error('delegate max_parallel must be between 1 and ' + String(resolved.maxParallelWorkers))
      }
      const maxParallel = parallel ? requestedParallel : 1
      const tokenBudget = args.token_budget ?? resolved.tokenBudget
      if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw new Error('delegate token_budget must be a positive integer')

      const delegationId = String(exec.callId)
      const label = args.label?.trim() || 'Delegation ' + delegationId.slice(-8)
      const started = Date.now()
      const append = appendWorkflowEvent(parent.session)
      const runs = new Map<string, RunRecord>()
      const observed = new Map<string, ObservedChild>()
      const disposeObservers = registerObservers(ctx, parent, runs, observed)
      const workers: FabricDelegationWorkerResult[] = []
      let validator: FabricDelegationWorkerResult | null = null
      let status: FabricDelegationResult['status'] = 'completed'
      try {
        for (let offset = 0; offset < tasks.length; offset += maxParallel) {
          const spent = workers.reduce((sum, worker) => sum + worker.tokens, 0)
          if (tokenBudget !== undefined && spent >= tokenBudget) { status = 'budget-exhausted'; break }
          const batch = tasks.slice(offset, offset + maxParallel)
          const native = ctx.workflowEngine.start({
            parent,
            signal: exec.signal,
            maxTotalAgents: batch.length,
            script: WORKFLOW_SCRIPT,
            meta: { name: workflowName('delegate', delegationId, offset), description: label, phases: [{ title: 'Workers' }] },
            args: { tasks: batch },
          })
          const record: RunRecord = { tasks: batch, childIds: new Map(), startedAt: new Map() }
          const settled = await settleRun(native, record, append, runs)
          const outcome = stopOutcome(settled.stopReason)
          workers.push(...collectResults(record, settled.value, outcome, observed, ctx))
          if (outcome !== 'completed') { status = outcome; break }
        }

        if (workers.length < tasks.length) {
          const settled = new Set(workers.map(worker => worker.index))
          const outcome = status === 'failed' ? 'failed' : 'cancelled'
          for (const task of tasks) {
            if (settled.has(task.index)) continue
            const requested = task.provider === undefined || task.model === undefined ? undefined : { provider: task.provider, model: task.model }
            workers.push({ index: task.index, label: task.label, task: task.task, tier: task.tier, output: null, outcome, ...(requested === undefined ? {} : { requested }), routingVerified: false, tokens: 0, durationMs: 0 })
          }
        }
        workers.sort((left, right) => left.index - right.index)

        let validation: unknown = null
        if (status === 'completed' && args.validate === true && resolved.validatorModel !== undefined) {
          const route = resolveWorkerRoute(resolved.validatorModel, resolved.aliases)
          if (route !== undefined) {
            const validatorTask: WorkflowTask = {
              index: tasks.length,
              label: 'validator',
              task: 'Validate the delegation results.',
              prompt: '',
              tier: 'strong',
              ...route,
            }
            const native = ctx.workflowEngine.start({
              parent,
              signal: exec.signal,
              maxTotalAgents: 1,
              script: VALIDATOR_SCRIPT,
              meta: { name: workflowName('validator', delegationId), description: 'Validate ' + label, phases: [{ title: 'Validation' }] },
              args: { route, prompt: 'Validate these worker results. Identify unsupported claims, disagreements, and exact checks Main must run.\n\n' + JSON.stringify(workers) },
            })
            const record: RunRecord = { tasks: [validatorTask], childIds: new Map(), startedAt: new Map() }
            const settled = await settleRun(native, record, append, runs)
            validator = collectResults(record, settled.value, stopOutcome(settled.stopReason), observed, ctx)[0] ?? null
            validation = validator?.output ?? null
            if (validator?.outcome !== 'completed') status = 'failed'
          }
        }

        const totalTokens = workers.reduce((sum, worker) => sum + worker.tokens, validator?.tokens ?? 0)
        const requestedOrchestrator = resolveWorkerRoute(resolved.mainModel, resolved.aliases)
        const actualOrchestrator = routeFromAgent(parent)
        const result: FabricDelegationResult = {
          delegationId,
          label,
          status,
          workers,
          validation,
          validator,
          orchestrator: {
            ...(requestedOrchestrator === undefined ? {} : { requested: requestedOrchestrator }),
            ...(actualOrchestrator === undefined ? {} : { actual: actualOrchestrator }),
            routingVerified: requestedOrchestrator !== undefined
              && actualOrchestrator !== undefined
              && actualOrchestrator.provider === requestedOrchestrator.provider
              && actualOrchestrator.model === requestedOrchestrator.model,
          },
          tokenBudget: tokenBudget ?? null,
          totalTokens,
          durationMs: Math.max(0, Date.now() - started),
          verificationRequired: true,
        }
        return json(result)
      } finally {
        disposeObservers()
      }
    },
  }))
}
