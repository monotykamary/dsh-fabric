/** Deterministic Fabric compaction compiler over DSH messages. */
import type { ContentBlock, Message } from '@monotykamary/dsh-llm'
import type { Session } from '@monotykamary/dsh-session'
import type {} from '@monotykamary/dsh-compaction'
import { utf8Bytes } from './bounds.ts'
import { countReasoningBlocks, normalizeMessages } from './normalize.ts'
import type { CompactionEvent, SessionActivityInput } from './normalize.ts'
import { projectWithMetadata } from './projections.ts'
import { renderSummary } from './render.ts'

const SNAPSHOT_PREFIX = '__dsh_fabric_compaction_snapshot_v1__:'
const SNAPSHOT_KIND = 'dsh-fabric.compaction-snapshot'
const SNAPSHOT_VERSION = 1
const MAX_SNAPSHOT_EVENTS = 512
const MAX_SNAPSHOT_BYTES = 64 * 1024
const MAX_SUMMARY_BYTES = 32 * 1024
const MAX_EVENT_TEXT_BYTES = 8 * 1024
const MAX_JSON_DEPTH = 10
const MAX_JSON_NODES = 256
const MAX_JSON_COLLECTION = 64
const MAX_JSON_STRING_BYTES = 2048

export const FABRIC_COMPACTION_PROVIDER = 'dsh-fabric-compaction'
export const FABRIC_COMPACTION_MODEL = 'deterministic-projection-v2'

export interface FabricCompactionSnapshotV1 {
  kind: typeof SNAPSHOT_KIND
  version: typeof SNAPSHOT_VERSION
  events: CompactionEvent[]
  omittedEvents: number
  reasoningBlocks: number
}

export interface CompileFabricSummaryOptions {
  /** Typed fallback for detached callers; the DSH adapter reconstructs from source events instead. */
  prior?: FabricCompactionSnapshotV1
  lastTimestamp?: string
  activityEvents?: readonly SessionActivityInput[]
  /** Current selected surface used only as the non-expansion byte budget. */
  budgetMessages?: readonly Message[]
  /** Source citation traversal reached its safety cap and omitted older facts. */
  sourceTruncated?: boolean
}

export interface CompiledFabricSummary {
  summary: string
  snapshot: FabricCompactionSnapshotV1
  rawOutput: ContentBlock[]
  omittedCounts: ReturnType<typeof projectWithMetadata>['omittedCounts']
}

/** Compile one deterministic, bounded summary from the selected DSH surface messages. */
export function compileFabricSummary(
  messages: readonly Message[],
  options: CompileFabricSummaryOptions = {},
): CompiledFabricSummary {
  const events = normalizeMessages(messages, options.prior?.events, options.activityEvents)
  if (events.length === 0) throw new Error('Fabric compaction source contains no typed text, tool, or activity events')
  const projection = projectWithMetadata(events)
  if (options.sourceTruncated) {
    projection.sections.status.unshift('Source recovery reached its event safety cap; older cited facts were omitted.')
  }
  const budgetMessages = options.budgetMessages ?? messages
  const budgetBytes = Math.max(1, budgetMessages.reduce((total, message) => total + messageBytes(message), 0))
  const maxBytes = Math.min(MAX_SUMMARY_BYTES, Math.max(256, Math.floor(budgetBytes * 0.5) - 256))
  const summary = renderSummary(projection.sections, {
    firstEntryId: events[0]?.sourceEntryId ?? '',
    lastEntryId: events.at(-1)?.sourceEntryId ?? '',
    lastTimestamp: options.lastTimestamp ?? '(unknown time)',
    maxBytes,
  })
  const snapshot = boundedSnapshot({
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    events,
    omittedEvents: options.prior?.omittedEvents ?? 0,
    reasoningBlocks: (options.prior?.reasoningBlocks ?? 0) + countReasoningBlocks(messages),
  })
  return {
    summary,
    snapshot,
    rawOutput: [
      { type: 'text', text: summary },
      { type: 'text', text: `${SNAPSHOT_PREFIX}${JSON.stringify(snapshot)}` },
    ],
    omittedCounts: projection.omittedCounts,
  }
}

/** Read the newest valid Fabric snapshot without consulting prior summary prose. */
export function readLatestFabricSnapshot(session: Session): FabricCompactionSnapshotV1 | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type !== 'compaction/summary'
      || event.data.provider !== FABRIC_COMPACTION_PROVIDER
      || event.data.model !== FABRIC_COMPACTION_MODEL) continue
    const block = event.data.rawOutput?.find(candidate => candidate.type === 'text' && candidate.text.startsWith(SNAPSHOT_PREFIX))
    if (block?.type !== 'text') return undefined
    const source = block.text.slice(SNAPSHOT_PREFIX.length)
    if (utf8Bytes(source) > MAX_SNAPSHOT_BYTES) return undefined
    try {
      const parsed: unknown = JSON.parse(source)
      return isSnapshot(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function boundedSnapshot(source: FabricCompactionSnapshotV1): FabricCompactionSnapshotV1 {
  let keep = Math.min(MAX_SNAPSHOT_EVENTS, source.events.length)
  while (keep >= 0) {
    const events = sample(source.events, keep).map((event, index) => ({ ...event, index: index + 1 }))
    const candidate: FabricCompactionSnapshotV1 = {
      ...source,
      events,
      omittedEvents: source.omittedEvents + source.events.length - events.length,
    }
    if (utf8Bytes(JSON.stringify(candidate)) <= MAX_SNAPSHOT_BYTES) return candidate
    if (keep === 0) break
    keep = Math.max(0, keep - Math.max(1, Math.ceil(keep / 8)))
  }
  return { ...source, events: [], omittedEvents: source.omittedEvents + source.events.length }
}

function sample<T>(values: readonly T[], keep: number): T[] {
  if (values.length <= keep) return [...values]
  if (keep <= 0) return []
  const earliest = Math.ceil(keep / 2)
  const latest = Math.floor(keep / 2)
  return [...values.slice(0, earliest), ...values.slice(values.length - latest)]
}

function messageBytes(message: Message): number {
  let total = 0
  const visit = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'text' || block.type === 'reasoning') total += utf8Bytes(block.text)
      else if (block.type === 'tool-call') total += utf8Bytes(block.name) + utf8Bytes(block.arguments)
      else if (block.type === 'tool-result') visit(block.content)
      else total += 64
    }
  }
  visit(message.content)
  return total
}

function isSnapshot(value: unknown): value is FabricCompactionSnapshotV1 {
  if (!isRecord(value)
    || value.kind !== SNAPSHOT_KIND
    || value.version !== SNAPSHOT_VERSION
    || !Number.isSafeInteger(value.omittedEvents)
    || (value.omittedEvents as number) < 0
    || !Number.isSafeInteger(value.reasoningBlocks)
    || (value.reasoningBlocks as number) < 0
    || !Array.isArray(value.events)
    || value.events.length > MAX_SNAPSHOT_EVENTS) return false
  return value.events.every((event, index) => isCompactionEvent(event, index + 1))
}

function isCompactionEvent(value: unknown, expectedIndex: number): value is CompactionEvent {
  if (!isRecord(value)
    || value.index !== expectedIndex
    || !boundedString(value.entryId, MAX_JSON_STRING_BYTES)
    || !boundedString(value.sourceEntryId, MAX_JSON_STRING_BYTES)
    || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'user':
    case 'assistantText':
      return boundedString(value.text, MAX_EVENT_TEXT_BYTES)
    case 'customMessage':
      return boundedString(value.customType, MAX_JSON_STRING_BYTES)
        && boundedString(value.text, MAX_EVENT_TEXT_BYTES)
        && typeof value.display === 'boolean'
        && optionalJson(value.details)
    case 'toolCall':
      return boundedString(value.toolCallId, MAX_JSON_STRING_BYTES)
        && boundedString(value.name, MAX_JSON_STRING_BYTES)
        && isBoundedJsonRecord(value.args)
    case 'toolResult':
      return boundedString(value.toolCallId, MAX_JSON_STRING_BYTES)
        && boundedString(value.toolName, MAX_JSON_STRING_BYTES)
        && typeof value.isError === 'boolean'
        && boundedString(value.text, MAX_EVENT_TEXT_BYTES)
        && optionalJson(value.result)
    case 'bash':
      return boundedString(value.toolCallId, MAX_JSON_STRING_BYTES)
        && boundedString(value.command, MAX_EVENT_TEXT_BYTES)
        && typeof value.isError === 'boolean'
        && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
        && optionalString(value.error, MAX_EVENT_TEXT_BYTES)
    case 'fabricPhase':
      return boundedString(value.subordinal, MAX_JSON_STRING_BYTES)
        && boundedString(value.address, MAX_JSON_STRING_BYTES)
        && boundedString(value.phase, MAX_EVENT_TEXT_BYTES)
    case 'fabricRun':
      return boundedString(value.toolCallId, MAX_JSON_STRING_BYTES)
        && boundedString(value.subordinal, MAX_JSON_STRING_BYTES)
        && boundedString(value.address, MAX_JSON_STRING_BYTES)
        && boundedString(value.name, MAX_EVENT_TEXT_BYTES)
        && optionalString(value.description, MAX_EVENT_TEXT_BYTES)
        && isOutcome(value.outcome)
        && (value.source === 'trace' || value.source === 'legacy' || value.source === 'result' || value.source === 'branch')
    case 'fabricOperation':
      return boundedString(value.subordinal, MAX_JSON_STRING_BYTES)
        && boundedString(value.address, MAX_JSON_STRING_BYTES)
        && boundedString(value.ref, MAX_JSON_STRING_BYTES)
        && optionalString(value.provider, MAX_JSON_STRING_BYTES)
        && optionalString(value.action, MAX_JSON_STRING_BYTES)
        && boundedString(value.tool, MAX_JSON_STRING_BYTES)
        && isBoundedJsonRecord(value.args)
        && isOutcome(value.outcome)
        && optionalString(value.error, MAX_EVENT_TEXT_BYTES)
        && optionalJson(value.result)
        && (value.source === 'trace' || value.source === 'legacy' || value.source === 'branch')
    default:
      return false
  }
}

function isOutcome(value: unknown): boolean {
  return value === 'succeeded' || value === 'failed' || value === 'aborted' || value === 'timed_out'
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= maxBytes
}

function optionalString(value: unknown, maxBytes: number): boolean {
  return value === undefined || boundedString(value, maxBytes)
}

function optionalJson(value: unknown): boolean {
  return value === undefined || isBoundedJson(value)
}

function isBoundedJsonRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isBoundedJson(value)
}

function isBoundedJson(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false
    if (current.value === null || typeof current.value === 'boolean') continue
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) return false
      continue
    }
    if (typeof current.value === 'string') {
      if (utf8Bytes(current.value) > MAX_JSON_STRING_BYTES) return false
      continue
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_COLLECTION) return false
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
      continue
    }
    if (!isRecord(current.value) || Object.keys(current.value).length > MAX_JSON_COLLECTION) return false
    for (const [key, item] of Object.entries(current.value)) {
      if (utf8Bytes(key) > MAX_JSON_STRING_BYTES) return false
      pending.push({ value: item, depth: current.depth + 1 })
    }
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
