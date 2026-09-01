/** DSH message normalization for deterministic Fabric compaction. */
import { isCompactCheckpointSource } from '@monotykamary/dsh-compaction'
import { projectFabricMeshActivity, readFabricMeshResultMeta } from 'dsh-fabric-protocol'
import type { FabricActivityRecord, FabricJsonValue } from 'dsh-fabric-protocol'
import type { ContentBlock, Message } from '@monotykamary/dsh-llm'
import { resolveRunCodeDisplay } from '@monotykamary/dsh-tools'
import { clipUtf8 } from './bounds.ts'

export type FabricTraceJsonValue = null | boolean | number | string | FabricTraceJsonValue[] | { [key: string]: FabricTraceJsonValue }
export type FabricExecutionOutcomeV1 = 'succeeded' | 'failed' | 'aborted' | 'timed_out'
export type FabricProjectionSource = 'trace' | 'legacy'

interface EventBase {
  index: number
  entryId: string
  sourceEntryId: string
}

interface UserEvent extends EventBase {
  kind: 'user'
  text: string
}

interface AssistantTextEvent extends EventBase {
  kind: 'assistantText'
  text: string
}

interface CustomMessageEvent extends EventBase {
  kind: 'customMessage'
  customType: string
  text: string
  display: boolean
  details?: FabricTraceJsonValue
}

export interface ToolCallEvent extends EventBase {
  kind: 'toolCall'
  toolCallId: string
  name: string
  args: Record<string, unknown>
}

interface ToolResultEvent extends EventBase {
  kind: 'toolResult'
  toolCallId: string
  toolName: string
  isError: boolean
  text: string
  result?: FabricTraceJsonValue
}

interface BashEvent extends EventBase {
  kind: 'bash'
  toolCallId: string
  command: string
  isError: boolean
  exitCode: number | null
  error?: string
}

interface FabricPhaseEvent extends EventBase {
  kind: 'fabricPhase'
  subordinal: string
  address: string
  phase: string
}

export interface FabricRunEvent extends EventBase {
  kind: 'fabricRun'
  toolCallId: string
  subordinal: string
  address: string
  name: string
  description?: string
  outcome: FabricExecutionOutcomeV1
  source: FabricProjectionSource | 'result' | 'branch'
}

interface FabricOperationEvent extends EventBase {
  kind: 'fabricOperation'
  subordinal: string
  address: string
  ref: string
  provider?: string
  action?: string
  tool: string
  args: Record<string, FabricTraceJsonValue>
  outcome: FabricExecutionOutcomeV1
  error?: string
  result?: FabricTraceJsonValue
  source: FabricProjectionSource | 'branch'
}

export type CompactionEvent =
  | UserEvent
  | AssistantTextEvent
  | CustomMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | BashEvent
  | FabricPhaseEvent
  | FabricRunEvent
  | FabricOperationEvent

const MAX_EVENT_TEXT_BYTES = 8 * 1024
const MAX_JSON_DEPTH = 10
const MAX_JSON_NODES = 256
const MAX_JSON_COLLECTION = 64
const MAX_JSON_STRING_BYTES = 2048

/** Minimal durable session envelope consumed without coupling the compiler to host adapters. */
export interface SessionActivityInput {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** Convert selected DSH messages, durable activity, and a prior typed snapshot into one addressed stream. */
export function normalizeMessages(
  messages: readonly Message[],
  prior: readonly CompactionEvent[] = [],
  activityEvents: readonly SessionActivityInput[] = [],
): CompactionEvent[] {
  const output: CompactionEvent[] = prior.map(event => ({ ...event }))
  appendSessionActivities(output, activityEvents, new Set(output.map(event => event.entryId)))
  const calls = new Map<string, ToolCallEvent>()
  const runDisplays = new Map<string, { name: string; description?: string }>()
  for (const event of output) {
    if (event.kind !== 'toolCall') continue
    calls.set(event.toolCallId, event)
    if (event.name === 'run_code' && typeof event.args.code === 'string') {
      runDisplays.set(event.toolCallId, resolveRunCodeDisplay({
        code: event.args.code,
        display: event.args.display,
        ...(typeof event.args.description === 'string' ? { description: event.args.description } : {}),
      }))
    }
  }

  for (const message of messages) {
    if (isCompactCheckpointSource(message.source)) continue
    const sourceEntryId = String(message.id)
    for (const [blockIndex, block] of message.content.entries()) {
      const entryId = `${sourceEntryId}:${blockIndex}`
      if (block.type === 'reasoning' || block.type === 'image') continue
      if (block.type === 'text') {
        const text = clipUtf8(block.text, MAX_EVENT_TEXT_BYTES)
        if (text.trim().length === 0) continue
        if (message.role === 'assistant') {
          output.push(base({ kind: 'assistantText', text }, entryId, sourceEntryId))
        } else if (message.source.kind === 'user') {
          output.push(base({ kind: 'user', text }, entryId, sourceEntryId))
        } else {
          const source = message.source as { kind: string; plugin?: unknown }
          output.push(base({
            kind: 'customMessage',
            customType: typeof source.plugin === 'string' ? source.plugin : source.kind,
            text,
            display: true,
          }, entryId, sourceEntryId))
        }
        continue
      }
      if (block.type === 'tool-call') {
        const rawArgs = unboundedArguments(block.arguments)
        const event = base({
          kind: 'toolCall',
          toolCallId: String(block.id),
          name: block.name,
          args: boundedArguments(rawArgs),
        }, entryId, sourceEntryId)
        output.push(event)
        calls.set(event.toolCallId, event)
        if (block.name === 'run_code' && typeof rawArgs.code === 'string') {
          runDisplays.set(event.toolCallId, resolveRunCodeDisplay({
            code: rawArgs.code,
            display: rawArgs.display,
            ...(typeof rawArgs.description === 'string' ? { description: rawArgs.description } : {}),
          }))
        }
        continue
      }
      if (block.type === 'tool-result') {
        const toolCallId = String(block.toolCallId)
        const call = calls.get(toolCallId)
        const text = clipUtf8(contentText(block.content), MAX_EVENT_TEXT_BYTES)
        const isError = block.isError === true
        const toolName = call?.name ?? 'unknown'
        if (toolName === 'bash' || toolName === 'tool-bash') {
          output.push(base({
            kind: 'bash',
            toolCallId,
            command: commandFrom(call?.args),
            isError,
            exitCode: null,
            ...(isError && text.length > 0 ? { error: text } : {}),
          }, entryId, sourceEntryId))
        } else {
          const result = parseRenderedJson(block.content)
          output.push(base({
            kind: 'toolResult', toolCallId, toolName, isError, text,
            ...(result === undefined ? {} : { result }),
          }, entryId, sourceEntryId))
          const runDisplay = toolName === 'run_code' ? runDisplays.get(toolCallId) : undefined
          if (runDisplay !== undefined && call !== undefined) {
            const subordinal = `call:${toolCallId}`
            output.push(base({
              kind: 'fabricRun',
              toolCallId,
              subordinal,
              address: `${call.entryId}/${subordinal}`,
              name: clipUtf8(runDisplay.name, MAX_EVENT_TEXT_BYTES),
              ...(runDisplay.description === undefined
                ? {}
                : { description: clipUtf8(runDisplay.description, MAX_EVENT_TEXT_BYTES) }),
              outcome: isError ? 'failed' : 'succeeded',
              source: 'result',
            }, call.entryId, sourceEntryId))
          }
        }
      }
    }
  }

  return output.map((event, index) => ({ ...event, index: index + 1 }))
}

function appendSessionActivities(
  output: CompactionEvent[],
  sourceEvents: readonly SessionActivityInput[],
  seen: Set<string>,
): void {
  const workflows = new Map<string, string>()
  const members = new Map<string, { label: string; phase?: string }>()
  const codeCalls = new Map<string, { name: string; args: Record<string, unknown>; sourceEntryId: string }>()
  const settledCodeCalls = new Set<string>()
  const push = (event: CompactionEvent): void => {
    if (seen.has(event.entryId)) return
    seen.add(event.entryId)
    output.push(event)
  }
  const pushCodeCall = (source: SessionActivityInput, data: Record<string, unknown>, suffix: string): string | undefined => {
    const subCallId = stringField(data, 'subCallId')
    const name = stringField(data, 'name')
    if (subCallId === undefined || name === undefined) return undefined
    const sourceEntryId = `session:${source.seq}`
    const existing = codeCalls.get(subCallId)
    if (existing === undefined) {
      const args = parseArguments(data.arguments)
      codeCalls.set(subCallId, { name, args, sourceEntryId })
      push(base({ kind: 'toolCall', toolCallId: subCallId, name, args }, `${sourceEntryId}:${suffix}`, sourceEntryId))
    }
    return subCallId
  }

  for (const source of sourceEvents) {
    if (!Number.isSafeInteger(source.seq) || source.seq < 0 || !isRecord(source.data)) continue
    const sourceEntryId = `session:${source.seq}`
    if (source.type === 'fabric/activity') {
      const activity = source.data.activity
      if (isFabricActivity(activity)) push(projectActivity(source, activity, 'fabric'))
      continue
    }
    if (source.type === 'tool/result') {
      const activity = readFabricMeshResultMeta(source.data.meta)?.activity
      if (activity !== undefined) push(projectActivity(source, activity, 'mesh-result'))
      continue
    }
    if (source.type === 'tool/code-dispatch-start') {
      pushCodeCall(source, source.data, 'code-call')
      continue
    }
    if (source.type === 'tool/code-dispatch') {
      const subCallId = pushCodeCall(source, source.data, 'code-call-synthesized')
      if (subCallId === undefined || settledCodeCalls.has(subCallId)) continue
      settledCodeCalls.add(subCallId)
      const call = codeCalls.get(subCallId)
      if (call === undefined) continue
      const text = clipUtf8(contentTextUnknown(source.data.content), MAX_EVENT_TEXT_BYTES)
      const isError = source.data.isError === true
      const result = parseRenderedJson(source.data.content)
      if (call.name === 'bash' || call.name === 'tool-bash') {
        push(base({
          kind: 'bash',
          toolCallId: subCallId,
          command: commandFrom(call.args),
          isError,
          exitCode: null,
          ...(isError && text.length > 0 ? { error: text } : {}),
        }, `${sourceEntryId}:code-result`, sourceEntryId))
      } else {
        push(base({
          kind: 'toolResult', toolCallId: subCallId, toolName: call.name, isError, text,
          ...(result === undefined ? {} : { result }),
        }, `${sourceEntryId}:code-result`, sourceEntryId))
      }
      if (call.name === 'fabric_mesh' && !isError && result !== undefined) {
        const activity = projectFabricMeshActivity(call.args, result, source.time)?.activity
        if (activity !== undefined) push(projectActivity(source, activity, 'mesh-dispatch'))
      }
      continue
    }

    if (source.type === 'tool-workflow/run-start') {
      const runId = stringField(source.data, 'runId')
      if (runId !== undefined) workflows.set(runId, stringField(source.data, 'name') ?? runId)
      continue
    }
    if (source.type === 'tool-workflow/agent-start') {
      const runId = stringField(source.data, 'runId')
      const sequence = numberField(source.data, 'seq')
      if (runId === undefined || sequence === undefined) continue
      const label = stringField(source.data, 'label') ?? `Agent ${sequence}`
      const phase = stringField(source.data, 'phase')
      members.set(workflowMemberKey(runId, sequence), { label, ...(phase === undefined ? {} : { phase }) })
      if (phase !== undefined) {
        push(base({
          kind: 'fabricPhase',
          subordinal: String(sequence),
          address: `workflow:${clipUtf8(runId, MAX_JSON_STRING_BYTES)}:phase:${clipUtf8(phase, MAX_JSON_STRING_BYTES)}`,
          phase: clipUtf8(phase, MAX_EVENT_TEXT_BYTES),
        }, `${sourceEntryId}:workflow-phase`, sourceEntryId))
      }
      continue
    }
    if (source.type === 'tool-workflow/agent-end') {
      const runId = stringField(source.data, 'runId')
      const sequence = numberField(source.data, 'seq')
      const outcome = workflowOutcome(source.data.outcome)
      if (runId === undefined || sequence === undefined || outcome === undefined) continue
      const member = members.get(workflowMemberKey(runId, sequence))
      push(base({
        kind: 'fabricRun',
        toolCallId: `workflow:${runId}:agent:${sequence}`,
        subordinal: String(sequence),
        address: `workflow:${clipUtf8(runId, MAX_JSON_STRING_BYTES)}:agent:${sequence}`,
        name: clipUtf8(member?.label ?? `Agent ${sequence}`, MAX_EVENT_TEXT_BYTES),
        ...(member?.phase === undefined ? {} : { description: clipUtf8(member.phase, MAX_EVENT_TEXT_BYTES) }),
        outcome,
        source: 'branch',
      }, `${sourceEntryId}:workflow-agent`, sourceEntryId))
      continue
    }
    if (source.type === 'tool-workflow/run-end') {
      const runId = stringField(source.data, 'runId')
      const outcome = workflowOutcome(source.data.stopReason)
      if (runId === undefined || outcome === undefined) continue
      push(base({
        kind: 'fabricRun',
        toolCallId: `workflow:${runId}`,
        subordinal: String(source.seq),
        address: `workflow:${clipUtf8(runId, MAX_JSON_STRING_BYTES)}`,
        name: clipUtf8(workflows.get(runId) ?? runId, MAX_EVENT_TEXT_BYTES),
        outcome,
        source: 'branch',
      }, `${sourceEntryId}:workflow-run`, sourceEntryId))
    }
  }

  for (const [subCallId, call] of codeCalls) {
    if (settledCodeCalls.has(subCallId)) continue
    push(base({
      kind: 'toolResult',
      toolCallId: subCallId,
      toolName: call.name,
      isError: true,
      text: 'Nested tool dispatch has no settlement in the selected durable source.',
    }, `${call.sourceEntryId}:code-result-missing`, call.sourceEntryId))
  }
}

function projectActivity(
  source: SessionActivityInput,
  activity: FabricActivityRecord,
  suffix: string,
): CompactionEvent {
  const sourceEntryId = 'session:' + source.seq
  const entryId = sourceEntryId + ':' + suffix
  const address = activity.nodeId === undefined || activity.nodeId === ''
    ? entryId
    : clipUtf8(activity.nodeId, MAX_JSON_STRING_BYTES)
  if (activity.kind === 'phase') {
    return base({
      kind: 'fabricPhase',
      subordinal: String(source.seq),
      address,
      phase: clipUtf8(activity.label, MAX_EVENT_TEXT_BYTES),
    }, entryId, sourceEntryId)
  }
  if (activity.kind === 'workflow') {
    return base({
      kind: 'fabricRun',
      toolCallId: entryId,
      subordinal: String(source.seq),
      address,
      name: clipUtf8(activity.label, MAX_EVENT_TEXT_BYTES),
      ...(activity.detail === undefined ? {} : { description: clipUtf8(activity.detail, MAX_EVENT_TEXT_BYTES) }),
      outcome: activityOutcome(activity.status),
      source: 'trace',
    }, entryId, sourceEntryId)
  }
  const argsValue = boundedJson({
    label: activity.label,
    ...(activity.nodeId === undefined ? {} : { nodeId: activity.nodeId }),
    ...(activity.detail === undefined ? {} : { detail: activity.detail }),
  }, { nodes: 0 }, 0)
  return base({
    kind: 'fabricOperation',
    subordinal: String(source.seq),
    address,
    ref: clipUtf8('fabric.' + activity.kind + '.' + activity.action, MAX_JSON_STRING_BYTES),
    provider: 'dsh-fabric',
    action: clipUtf8(activity.action, MAX_JSON_STRING_BYTES),
    tool: meshActivityKind(activity.kind) ? 'fabric_mesh' : 'fabric_activity',
    args: isRecord(argsValue) ? argsValue as Record<string, FabricTraceJsonValue> : {},
    outcome: activityOutcome(activity.status),
    source: 'trace',
  }, entryId, sourceEntryId)
}

function isFabricActivity(value: unknown): value is FabricActivityRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.action === 'string'
    && typeof value.label === 'string'
    && typeof value.status === 'string'
    && typeof value.updatedAt === 'number'
}

function parseRenderedJson(value: unknown): FabricJsonValue | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value.flatMap(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n')
  if (text === '') return undefined
  try {
    return boundedJson(JSON.parse(text), { nodes: 0 }, 0) as FabricJsonValue | undefined
  } catch {
    return undefined
  }
}

function activityOutcome(status: string): FabricExecutionOutcomeV1 {
  if (status === 'failed' || status === 'blocked') return 'failed'
  if (status === 'stopped') return 'aborted'
  return 'succeeded'
}

function workflowOutcome(value: unknown): FabricExecutionOutcomeV1 | undefined {
  if (value === 'completed') return 'succeeded'
  if (value === 'failed' || value === 'error') return 'failed'
  if (value === 'cancelled') return 'aborted'
  return undefined
}

function meshActivityKind(kind: string): boolean {
  return kind === 'mesh' || kind === 'topic' || kind === 'state' || kind === 'actor' || kind === 'message'
}

function workflowMemberKey(runId: string, sequence: number): string {
  return `${runId.length}:${runId}:${sequence}`
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

/** Count reasoning blocks deliberately erased from one summary source. */
export function firstLine(text: string): string {
  const trimmed = text.trimStart()
  const newline = trimmed.indexOf('\n')
  return newline < 0 ? trimmed : trimmed.slice(0, newline)
}

export function countReasoningBlocks(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total
    + message.content.filter(block => block.type === 'reasoning').length, 0)
}

function base<T extends Omit<CompactionEvent, keyof EventBase>>(
  event: T,
  entryId: string,
  sourceEntryId: string,
): T & EventBase {
  return { ...event, index: 0, entryId, sourceEntryId }
}

function unboundedArguments(source: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof source === 'string' ? JSON.parse(source) : source
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function boundedArguments(source: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundedJson(source, { nodes: 0 }, 0)
  return isRecord(bounded) ? bounded : {}
}

function parseArguments(source: unknown): Record<string, unknown> {
  return boundedArguments(unboundedArguments(source))
}

function contentTextUnknown(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const output: string[] = []
  const visit = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (!isRecord(item)) continue
      if (item.type === 'text' && typeof item.text === 'string') output.push(item.text)
      else if (item.type === 'tool-result' && Array.isArray(item.content)) visit(item.content)
    }
  }
  visit(value)
  return output.join('\n')
}

function contentText(blocks: readonly ContentBlock[]): string {
  const output: string[] = []
  const visit = (items: readonly ContentBlock[]): void => {
    for (const block of items) {
      if (block.type === 'text') output.push(block.text)
      else if (block.type === 'tool-result') visit(block.content)
    }
  }
  visit(blocks)
  return output.join('\n')
}

function commandFrom(args: Record<string, unknown> | undefined): string {
  const value = args?.command ?? args?.cmd
  return typeof value === 'string' ? clipUtf8(value, MAX_EVENT_TEXT_BYTES) : ''
}

function boundedJson(
  value: unknown,
  state: { nodes: number },
  depth: number,
): FabricTraceJsonValue | undefined {
  state.nodes += 1
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return clipUtf8(value, MAX_JSON_STRING_BYTES)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const output: FabricTraceJsonValue[] = []
    for (const item of value.slice(0, MAX_JSON_COLLECTION)) {
      const bounded = boundedJson(item, state, depth + 1)
      if (bounded !== undefined) output.push(bounded)
    }
    return output
  }
  if (!isRecord(value)) return undefined
  const output: Record<string, FabricTraceJsonValue> = Object.create(null)
  for (const key of Object.keys(value).sort().slice(0, MAX_JSON_COLLECTION)) {
    const bounded = boundedJson(value[key], state, depth + 1)
    const boundedKey = clipUtf8(key, MAX_JSON_STRING_BYTES)
    if (bounded !== undefined && !Object.hasOwn(output, boundedKey)) output[boundedKey] = bounded
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
