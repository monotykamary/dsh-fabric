/** Source-backed selection for deterministic Fabric compaction. */
import { isCompactCheckpointSource } from '@monotykamary/dsh-compaction'
import type { Message } from '@monotykamary/dsh-llm'
import type { Session, SessionEvent } from '@monotykamary/dsh-session'
import type { SessionActivityInput } from './normalize.ts'

/** Raw messages and non-surface activity causally covered by one selected DSH surface region. */
export interface FabricCompactionSource {
  /** Original durable messages, with generated compaction checkpoints removed. */
  readonly messages: readonly Message[]
  /** Fabric/workflow records enclosed by turns represented in messages. */
  readonly activityEvents: readonly SessionActivityInput[]
  /** Latest durable timestamp represented by this source. */
  readonly lastTime?: number
  /** The source-event safety cap stopped older citation traversal. */
  readonly sourceTruncated?: true
}

export interface FabricCompactionSourceOptions {
  /** Citation-closure safety bound; primarily injectable for deterministic tests. */
  readonly maxSourceEvents?: number
}

/**
 * Reconstruct a selected surface region from immutable source events rather than
 * feeding a previous summary back into the next summary. Replacement nodes cite
 * every shadowed node through sourceEventSeqs; recursively following those
 * citations recovers the original messages even after repeated compactions.
 */
export function selectFabricCompactionSource(
  session: Session,
  selectedMessages: readonly Message[],
  options: FabricCompactionSourceOptions = {},
): FabricCompactionSource {
  const maxSourceEvents = options.maxSourceEvents ?? MAX_SOURCE_CLOSURE_EVENTS
  if (!Number.isSafeInteger(maxSourceEvents) || maxSourceEvents < 1) {
    throw new TypeError('maxSourceEvents must be a positive safe integer')
  }

  const events = session.events

  // One fold resolves message ids and turn placement together instead of
  // walking the whole durable log once per concern.
  const byMessageId = new Map<string, number>()
  const turnAtSeq = new Map<number, number>()
  let currentTurn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') currentTurn = event.data.turn
    if (currentTurn !== undefined) turnAtSeq.set(event.seq, currentTurn)
    const id = messageId(event)
    if (id !== undefined) byMessageId.set(id, event.seq)
    if (event.type === 'turn/end' && event.data.turn === currentTurn) currentTurn = undefined
  }

  const selectedSeqs: number[] = []
  const detachedMessages: Message[] = []
  for (const message of selectedMessages) {
    const seq = byMessageId.get(String(message.id))
    if (seq === undefined) detachedMessages.push(message)
    else selectedSeqs.push(seq)
  }
  if (selectedSeqs.length === 0) return fallback(events, selectedMessages)

  const closure = sourceClosure(events, selectedSeqs, maxSourceEvents)
  const covered = closure.covered

  const selectedTurns = new Set<number>()
  for (const seq of covered) {
    const turn = turnAtSeq.get(seq)
    if (turn !== undefined) selectedTurns.add(turn)
  }
  const selectedActivitySeqs = activitySelection(events, turnAtSeq, selectedTurns)

  const messages: Message[] = []
  const activityEvents: SessionActivityInput[] = []
  let lastTime: number | undefined
  // Events are dense seq-indexed log positions, so the output fold can skip
  // everything before the earliest cited or activity-selected position.
  let firstRelevantSeq = Number.POSITIVE_INFINITY
  for (const seq of covered) if (seq < firstRelevantSeq) firstRelevantSeq = seq
  for (const seq of selectedActivitySeqs) if (seq < firstRelevantSeq) firstRelevantSeq = seq
  if (Number.isFinite(firstRelevantSeq)) {
    for (let index = firstRelevantSeq; index < events.length; index += 1) {
      const event = events[index]
      if (event === undefined) continue
      if (covered.has(event.seq)) {
        const message = session.deriveEventMessage(event)
        if (message !== null && !isCompactCheckpointSource(message.source)) {
          messages.push(message)
          lastTime = maxTime(lastTime, event.time)
        }
      }
      if (selectedActivitySeqs.has(event.seq)) {
        activityEvents.push({ type: String(event.type), seq: event.seq, time: event.time, data: event.data })
        lastTime = maxTime(lastTime, event.time)
      }
    }
  }

  for (const message of detachedMessages) {
    if (!isCompactCheckpointSource(message.source)) messages.push(message)
  }

  return messages.length === 0 && activityEvents.length === 0
    ? fallback(events, selectedMessages, closure.truncated)
    : {
        messages,
        activityEvents,
        ...(lastTime === undefined ? {} : { lastTime }),
        ...(closure.truncated ? { sourceTruncated: true as const } : {}),
      }
}

const MAX_SOURCE_CLOSURE_EVENTS = 100_000

function sourceClosure(
  events: readonly SessionEvent[],
  selectedSeqs: readonly number[],
  maxSourceEvents: number,
): { covered: Set<number>; truncated: boolean } {
  const covered = new Set<number>()
  const pending = [...selectedSeqs].toReversed()
  let truncated = false
  while (pending.length > 0) {
    const seq = pending.pop()
    if (seq === undefined || covered.has(seq)) continue
    const event = events[seq]
    if (event === undefined || event.seq !== seq) continue
    if (covered.size >= maxSourceEvents) {
      truncated = true
      break
    }
    covered.add(seq)
    if (!('sourceEventSeqs' in event) || !Array.isArray(event.sourceEventSeqs)) continue
    for (let index = event.sourceEventSeqs.length - 1; index >= 0; index -= 1) {
      const sourceSeq = event.sourceEventSeqs[index]
      if (Number.isSafeInteger(sourceSeq) && (sourceSeq as number) >= 0) pending.push(sourceSeq as number)
    }
  }
  return { covered, truncated }
}

function messageId(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') return String(event.data.id)
  if (event.type === 'assistant/message') return String(event.data.message.id)
  if (event.type === 'tool/result') return String(event.data.message.id)
  return undefined
}

function activitySelection(
  events: readonly SessionEvent[],
  turnAtSeq: ReadonlyMap<number, number>,
  selectedTurns: ReadonlySet<number>,
): Set<number> {
  // One pass collects direct selections and, for correlated records, the full
  // member list plus whether any member sits in a selected turn. Lifecycle
  // widening then walks only those members instead of rescanning the log.
  const selected = new Set<number>()
  const workflowMembers = new Map<string, number[]>()
  const codeMembers = new Map<string, number[]>()
  const selectedWorkflows = new Set<string>()
  const selectedCodeCalls = new Set<string>()

  for (const event of events) {
    const turn = turnAtSeq.get(event.seq)
    if (turn === undefined || !isActivityEvent(event)) continue
    const correlation = activityCorrelation(event)
    if (correlation !== undefined) {
      const members = correlation.kind === 'workflow' ? workflowMembers : codeMembers
      const list = members.get(correlation.id)
      if (list === undefined) members.set(correlation.id, [event.seq])
      else list.push(event.seq)
      if (selectedTurns.has(turn)) {
        if (correlation.kind === 'workflow') selectedWorkflows.add(correlation.id)
        else selectedCodeCalls.add(correlation.id)
      }
    }
    if (selectedTurns.has(turn)) selected.add(event.seq)
  }

  for (const runId of selectedWorkflows) {
    for (const seq of workflowMembers.get(runId) ?? []) selected.add(seq)
  }
  for (const subCallId of selectedCodeCalls) {
    for (const seq of codeMembers.get(subCallId) ?? []) selected.add(seq)
  }
  return selected
}

function activityCorrelation(event: SessionEvent): { kind: 'workflow' | 'code'; id: string } | undefined {
  const type = String(event.type)
  if (!isRecord(event.data)) return undefined
  const data = event.data as Record<string, unknown>
  if (type.startsWith('tool-workflow/') && typeof data.runId === 'string') {
    return { kind: 'workflow', id: data.runId }
  }
  if ((type === 'tool/code-dispatch-start' || type === 'tool/code-dispatch')
    && typeof data.subCallId === 'string') {
    return { kind: 'code', id: data.subCallId }
  }
  return undefined
}

function isActivityEvent(event: SessionEvent): boolean {
  const type = String(event.type)
  if (type === 'fabric/activity' || type === 'tool/code-dispatch-start' || type === 'tool/code-dispatch') return true
  if (type.startsWith('tool-workflow/')) return true
  return event.type === 'tool/result' && isFabricMeta(event.data.meta)
}

function isFabricMeta(value: unknown): boolean {
  return isRecord(value) && value.kind === 'dsh-fabric.mesh-result'
}

function fallback(
  events: readonly SessionEvent[],
  messages: readonly Message[],
  sourceTruncated = false,
): FabricCompactionSource {
  const activityEvents = events
    .filter(isActivityEvent)
    .map(event => ({ type: String(event.type), seq: event.seq, time: event.time, data: event.data }))
  const lastTime = activityEvents.reduce<number | undefined>(
    (current, event) => maxTime(current, event.time),
    undefined,
  )
  return {
    messages: [...messages],
    activityEvents,
    ...(lastTime === undefined ? {} : { lastTime }),
    ...(sourceTruncated ? { sourceTruncated: true as const } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maxTime(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.max(current, next)
}
