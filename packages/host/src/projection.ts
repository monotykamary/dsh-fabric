import { z } from 'zod'
import { fabricSessionNodeId, projectFabricMeshActivity, readFabricMeshResultMeta } from '@dsh-fabric/protocol'
import type {
  FabricActivityEventData,
  FabricActivityProjection,
  FabricActivityRecord,
  FabricJsonValue,
  FabricNodeStatus,
  FabricProjectedEdge,
  FabricProjectedNode,
} from '@dsh-fabric/protocol'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkflowAgentOutcome, WorkflowStopReason } from '@deepseek-ai/dsh-workflow'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from './types.ts'

const nodeStatusSchema = z.enum(['pending', 'running', 'idle', 'completed', 'failed', 'blocked', 'stopped'])
const nodeKindSchema = z.enum(['main', 'session', 'subagent', 'workflow', 'phase', 'job', 'actor', 'topic', 'message', 'state', 'component', 'compaction'])
const edgeKindSchema = z.enum(['parent', 'contains', 'member', 'publish', 'message', 'state', 'route'])
const activityKindSchema = z.enum(['session', 'workflow', 'phase', 'agent', 'mesh', 'topic', 'state', 'actor', 'message', 'compaction'])

const MAX_ID_BYTES = 512
const MAX_ACTION_BYTES = 256
const MAX_LABEL_BYTES = 2048
const MAX_DETAIL_BYTES = 4096

const activitySchema = z.object({
  id: z.string(),
  kind: activityKindSchema,
  action: z.string(),
  label: z.string(),
  status: nodeStatusSchema,
  updatedAt: z.number(),
  nodeId: z.string().optional(),
  detail: z.string().optional(),
})
const nodeSchema = z.object({
  id: z.string(),
  kind: nodeKindSchema,
  label: z.string(),
  status: nodeStatusSchema,
  updatedAt: z.number(),
  sessionId: z.string().optional(),
  detail: z.string().optional(),
})
const edgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: edgeKindSchema,
  updatedAt: z.number().optional(),
})

const projectionSchema = z.object({
  activities: z.array(activitySchema),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
}) as z.ZodType<FabricActivityProjection>

interface FabricProjectionState extends FabricActivityProjection {
  workflowMembers: Record<string, {
    runId: string
    nodeId: string
    sessionId: string
    label: string
  }>
}

/** Create the pure bounded fold registered by the host adapter. */
export function createFabricActivityProjection(
  activityLimit = 200,
  topologyLimit = 256,
): ProjectionDefinition<'fabricActivity', FabricProjectionState> {
  if (!Number.isSafeInteger(activityLimit) || activityLimit < 1) throw new TypeError('activityLimit must be a positive safe integer')
  if (!Number.isSafeInteger(topologyLimit) || topologyLimit < 1) throw new TypeError('topologyLimit must be a positive safe integer')

  return {
    key: 'fabricActivity',
    schema: projectionSchema,
    init: () => ({ activities: [], nodes: [], edges: [], workflowMembers: {} }),
    apply: (state, event) => applyEvent(state, event, activityLimit, topologyLimit),
    view: state => ({ activities: state.activities, nodes: state.nodes, edges: state.edges }),
    stateVersion: 4,
  }
}

function applyEvent(
  state: FabricProjectionState,
  event: SessionEvent,
  activityLimit: number,
  topologyLimit: number,
): FabricProjectionState {
  switch (event.type) {
    case 'fabric/activity':
      return mergeActivity(state, event.data, activityLimit, topologyLimit)
    case 'tool/result': {
      const activity = readFabricMeshResultMeta(event.data.meta)
      return activity === undefined ? state : mergeActivity(state, activity, activityLimit, topologyLimit)
    }
    case 'tool/code-dispatch': {
      if (event.data.name !== 'fabric_mesh' || event.data.isError) return state
      const args = jsonRecord(event.data.arguments)
      const result = renderedJson(event.data.content)
      if (args === undefined || result === undefined) return state
      const activity = projectFabricMeshActivity(args, result, event.time)
      return activity === undefined ? state : mergeActivity(state, activity, activityLimit, topologyLimit)
    }
    case 'compaction/start': {
      const compactionId = String(event.data.compactionId)
      const id = `compaction:${compactionId}`
      return merge(state, {
        id: `${id}:start`, kind: 'compaction', action: 'started', label: 'Context compaction',
        status: 'running', updatedAt: event.time, nodeId: id,
      }, [{ id, kind: 'compaction', label: 'Context compaction', status: 'running', updatedAt: event.time }], [{
        id: `compaction-owner:${compactionId}`, source: '$session', target: id, kind: 'contains', updatedAt: event.time,
      }], activityLimit, topologyLimit)
    }
    case 'compaction/summary': {
      const compactionId = String(event.data.compactionId)
      const id = `compaction:${compactionId}`
      const existing = state.nodes.find(node => node.id === id)
      const detail = `${event.data.shadowedTokenCount} tokens · seq ${event.data.shadowedRange.start}–${event.data.shadowedRange.end}`
      return merge(state, {
        id: `${id}:summary`, kind: 'compaction', action: 'summarized', label: existing?.label ?? 'Context compaction',
        status: 'running', updatedAt: event.time, nodeId: id, detail,
      }, [{ id, kind: 'compaction', label: existing?.label ?? 'Context compaction', status: 'running', updatedAt: event.time, detail }], [], activityLimit, topologyLimit)
    }
    case 'compaction/end': {
      const compactionId = String(event.data.compactionId)
      const id = `compaction:${compactionId}`
      const existing = state.nodes.find(node => node.id === id)
      const status = event.data.error === undefined ? 'completed' : 'failed'
      return merge(state, {
        id: `${id}:end`, kind: 'compaction', action: status, label: existing?.label ?? 'Context compaction',
        status, updatedAt: event.time, nodeId: id, ...(event.data.error === undefined ? {} : { detail: event.data.error }),
      }, [{
        id, kind: 'compaction', label: existing?.label ?? 'Context compaction', status, updatedAt: event.time,
        ...(event.data.error === undefined ? existing?.detail === undefined ? {} : { detail: existing.detail } : { detail: event.data.error }),
      }], [], activityLimit, topologyLimit)
    }
    case 'compaction/prune': {
      const id = `compaction:prune:${event.seq}`
      const detail = `${event.data.shadowedTokenCount} tokens · seq ${event.data.shadowedRange.start}–${event.data.shadowedRange.end}`
      return merge(state, {
        id, kind: 'compaction', action: 'pruned', label: 'Tool result pruning', status: 'completed',
        updatedAt: event.time, nodeId: id, detail,
      }, [{ id, kind: 'compaction', label: 'Tool result pruning', status: 'completed', updatedAt: event.time, detail }], [{
        id: `compaction-prune-owner:${event.seq}`, source: '$session', target: id, kind: 'contains', updatedAt: event.time,
      }], activityLimit, topologyLimit)
    }
    case 'tool-workflow/run-start': {
      const id = workflowNodeId(String(event.data.runId))
      return merge(state, {
        id: `workflow:${String(event.data.runId)}:start`,
        kind: 'workflow', action: 'started', label: event.data.name, status: 'running', updatedAt: event.time, nodeId: id,
      }, [{ id, kind: 'workflow', label: event.data.name, status: 'running', updatedAt: event.time }], [{
        id: `workflow-owner:${String(event.data.runId)}`, source: '$session', target: id, kind: 'contains', updatedAt: event.time,
      }], activityLimit, topologyLimit)
    }
    case 'tool-workflow/agent-start': {
      const runId = String(event.data.runId)
      const workflowId = workflowNodeId(runId)
      const childId = String(fabricSessionNodeId(String(event.data.childId)))
      const phase = event.data.phase
      const phaseId = phase === undefined ? undefined : workflowPhaseNodeId(runId, phase)
      const nodes: FabricProjectedNode[] = [
        { id: childId, sessionId: String(event.data.childId), kind: 'subagent', label: event.data.label, status: 'running', updatedAt: event.time },
      ]
      const edges: FabricProjectedEdge[] = []
      if (phaseId === undefined) {
        edges.push({ id: `workflow-member:${runId}:${event.data.seq}`, source: workflowId, target: childId, kind: 'member', updatedAt: event.time })
      } else {
        nodes.push({ id: phaseId, kind: 'phase', label: phase ?? '', status: 'running', updatedAt: event.time })
        edges.push(
          { id: `workflow-phase:${runId}:${phaseId}`, source: workflowId, target: phaseId, kind: 'contains', updatedAt: event.time },
          { id: `workflow-member:${runId}:${event.data.seq}`, source: phaseId, target: childId, kind: 'member', updatedAt: event.time },
        )
      }
      const next = merge(state, {
        id: `workflow:${runId}:agent:${event.data.seq}:start`, kind: 'agent', action: 'started', label: event.data.label,
        status: 'running', updatedAt: event.time, nodeId: childId, ...(phase === undefined ? {} : { detail: phase }),
      }, nodes, edges, activityLimit, topologyLimit)
      return {
        ...next,
        workflowMembers: putWorkflowMember(next.workflowMembers, workflowMemberKey(runId, event.data.seq), {
          runId,
          nodeId: childId,
          sessionId: String(event.data.childId),
          label: event.data.label,
        }, topologyLimit),
      }
    }
    case 'tool-workflow/agent-end': {
      const runId = String(event.data.runId)
      const memberKey = workflowMemberKey(runId, event.data.seq)
      const member = state.workflowMembers[memberKey]
      const childId = member?.nodeId
      const existing = childId === undefined ? undefined : state.nodes.find(node => node.id === childId)
      const status = outcomeStatus(event.data.outcome)
      const next = merge(state, {
        id: `workflow:${runId}:agent:${event.data.seq}:end`, kind: 'agent', action: event.data.outcome,
        label: existing?.label ?? member?.label ?? `Agent ${event.data.seq}`, status, updatedAt: event.time,
        ...(childId === undefined ? {} : { nodeId: childId }),
      }, childId === undefined ? [] : [{
        ...(existing ?? { id: childId, kind: 'subagent' as const, label: member?.label ?? `Agent ${event.data.seq}`, ...(member === undefined ? {} : { sessionId: member.sessionId }) }),
        status, updatedAt: event.time,
      }], [], activityLimit, topologyLimit)
      const { [memberKey]: _settled, ...workflowMembers } = next.workflowMembers
      return { ...next, workflowMembers }
    }
    case 'tool-workflow/run-end': {
      const id = workflowNodeId(String(event.data.runId))
      const existing = state.nodes.find(node => node.id === id)
      const status = stopStatus(event.data.stopReason)
      const phaseIds = new Set(state.edges
        .filter(edge => edge.source === id && edge.kind === 'contains')
        .map(edge => edge.target))
      const phaseNodes = state.nodes
        .filter(node => node.kind === 'phase' && phaseIds.has(node.id))
        .map(node => ({ ...node, status, updatedAt: event.time }))
      const next = merge(state, {
        id: `workflow:${String(event.data.runId)}:end`, kind: 'workflow', action: event.data.stopReason,
        label: existing?.label ?? String(event.data.runId), status, updatedAt: event.time, nodeId: id,
      }, [...phaseNodes, { id, kind: 'workflow', label: existing?.label ?? String(event.data.runId), status, updatedAt: event.time }], [], activityLimit, topologyLimit)
      const boundedRunId = boundedIdentifier(String(event.data.runId))
      const workflowMembers = Object.fromEntries(Object.entries(next.workflowMembers)
        .filter(([, member]) => member.runId !== boundedRunId))
      return { ...next, workflowMembers }
    }
    default:
      return state
  }
}

function mergeActivity(
  state: FabricProjectionState,
  data: FabricActivityEventData,
  activityLimit: number,
  topologyLimit: number,
): FabricProjectionState {
  return merge(state, data.activity, data.nodes ?? [], data.edges ?? [], activityLimit, topologyLimit)
}

function renderedJson(content: readonly { type: string; text?: string }[]): FabricJsonValue | undefined {
  const text = content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
  if (text === '') return undefined
  try {
    const snapshot = snapshotJsonValue(JSON.parse(text))
    return snapshot as FabricJsonValue | undefined
  } catch {
    return undefined
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function merge(
  state: FabricProjectionState,
  activity: FabricActivityRecord,
  nodes: readonly FabricProjectedNode[],
  edges: readonly FabricProjectedEdge[],
  activityLimit: number,
  topologyLimit: number,
): FabricProjectionState {
  const normalizedActivity = boundedActivity(activity)
  const initialNodes = state.nodes.map(boundedNode)
  const nextNodes = nodes.map(boundedNode).map(node => preserveKnownLabel(initialNodes, node))
    .reduce((values, node) => upsert(values, node, topologyLimit), initialNodes)
  const initialEdges = state.edges.map(boundedEdge)
  const nextEdges = edges.map(boundedEdge).reduce((values, edge) => upsert(values, edge, topologyLimit), initialEdges)
    .filter(edge => edge.source === '$session' || nextNodes.some(node => node.id === edge.source))
    .filter(edge => edge.target === '$session' || nextNodes.some(node => node.id === edge.target))
  const reconciledNodes = nextNodes.map(node => reconcileActorStatus(node, nextNodes, nextEdges))
  return {
    activities: [...state.activities.map(boundedActivity).filter(item => item.id !== normalizedActivity.id), normalizedActivity].slice(-activityLimit),
    nodes: reconciledNodes,
    edges: nextEdges,
    workflowMembers: state.workflowMembers,
  }
}

function putWorkflowMember(
  members: FabricProjectionState['workflowMembers'],
  key: string,
  member: FabricProjectionState['workflowMembers'][string],
  limit: number,
): FabricProjectionState['workflowMembers'] {
  return Object.fromEntries(Object.entries({
    ...members,
    [boundedIdentifier(key)]: {
      runId: boundedIdentifier(member.runId),
      nodeId: boundedIdentifier(member.nodeId),
      sessionId: boundedIdentifier(member.sessionId),
      label: boundedText(member.label, MAX_LABEL_BYTES),
    },
  }).slice(-limit))
}

function boundedActivity(value: FabricActivityRecord): FabricActivityRecord {
  return {
    ...value,
    id: boundedIdentifier(value.id),
    action: boundedText(value.action, MAX_ACTION_BYTES),
    label: boundedText(value.label, MAX_LABEL_BYTES),
    ...(value.nodeId === undefined ? {} : { nodeId: boundedIdentifier(value.nodeId) }),
    ...(value.detail === undefined ? {} : { detail: boundedText(value.detail, MAX_DETAIL_BYTES) }),
  }
}

function reconcileActorStatus(
  node: FabricProjectedNode,
  nodes: readonly FabricProjectedNode[],
  edges: readonly FabricProjectedEdge[],
): FabricProjectedNode {
  if (node.kind !== 'actor') return node
  const messageIds = new Set(edges.filter(edge => edge.source === node.id && edge.kind === 'message').map(edge => edge.target))
  if (messageIds.size === 0) return node
  const statuses = nodes.filter(candidate => messageIds.has(candidate.id)).map(candidate => candidate.status)
  const status: FabricNodeStatus = statuses.includes('running')
    ? 'running'
    : statuses.includes('pending')
      ? 'pending'
      : statuses.includes('failed')
        ? 'failed'
        : 'idle'
  return { ...node, status }
}

function preserveKnownLabel(existing: readonly FabricProjectedNode[], node: FabricProjectedNode): FabricProjectedNode {
  if (node.kind !== 'actor' || !node.id.startsWith('actor:') || node.label !== node.id.slice('actor:'.length)) return node
  const previous = existing.find(candidate => candidate.id === node.id)
  return previous === undefined ? node : { ...node, label: previous.label }
}

function boundedNode(value: FabricProjectedNode): FabricProjectedNode {
  return {
    ...value,
    id: boundedIdentifier(value.id),
    label: boundedText(value.label, MAX_LABEL_BYTES),
    ...(value.sessionId === undefined ? {} : { sessionId: boundedIdentifier(value.sessionId) }),
    ...(value.detail === undefined ? {} : { detail: boundedText(value.detail, MAX_DETAIL_BYTES) }),
  }
}

function boundedEdge(value: FabricProjectedEdge): FabricProjectedEdge {
  return {
    ...value,
    id: boundedIdentifier(value.id),
    source: boundedIdentifier(value.source),
    target: boundedIdentifier(value.target),
  }
}

function boundedIdentifier(value: string): string {
  if (value === '$session' || utf8Bytes(value) <= MAX_ID_BYTES) return value
  const suffix = `#${identifierDigest(value)}`
  return `${boundedText(value, MAX_ID_BYTES - utf8Bytes(suffix))}${suffix}`
}

function boundedText(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function utf8Bytes(value: string): number {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

function identifierDigest(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    first = Math.imul(first ^ unit, 0x01000193) >>> 0
    second = Math.imul(second ^ unit, 0x85ebca6b) >>> 0
  }
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0')
}

function upsert<T extends { id: string }>(values: readonly T[], value: T, limit: number): T[] {
  return [...values.filter(candidate => candidate.id !== value.id), value].slice(-limit)
}

function workflowMemberKey(runId: string, seq: number): string {
  return boundedIdentifier(`${runId.length}:${runId}:${seq}`)
}

function workflowNodeId(runId: string): string {
  return boundedIdentifier(`workflow:${runId}`)
}

function workflowPhaseNodeId(runId: string, phase: string): string {
  return boundedIdentifier(`workflow:${runId}:phase:${phase.length}:${phase}`)
}

function outcomeStatus(outcome: WorkflowAgentOutcome): FabricNodeStatus {
  switch (outcome) {
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'stopped'
  }
}

function stopStatus(reason: WorkflowStopReason): FabricNodeStatus {
  switch (reason) {
    case 'completed': return 'completed'
    case 'error': return 'failed'
    case 'cancelled': return 'stopped'
  }
}
