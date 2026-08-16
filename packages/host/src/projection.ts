import { z } from 'zod'
import { fabricSessionNodeId } from '@dsh-fabric/protocol'
import type {
  FabricActivityProjection,
  FabricActivityRecord,
  FabricNodeStatus,
  FabricProjectedEdge,
  FabricProjectedNode,
} from '@dsh-fabric/protocol'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkflowAgentOutcome, WorkflowStopReason } from '@deepseek-ai/dsh-workflow'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type {} from './types.ts'

const nodeStatusSchema = z.enum(['pending', 'running', 'idle', 'completed', 'failed', 'blocked', 'stopped'])
const nodeKindSchema = z.enum(['main', 'session', 'subagent', 'workflow', 'phase', 'job', 'actor', 'topic', 'message', 'state', 'component', 'compaction'])
const edgeKindSchema = z.enum(['parent', 'contains', 'member', 'publish', 'message', 'state', 'route'])
const activityKindSchema = z.enum(['session', 'workflow', 'phase', 'agent', 'mesh', 'topic', 'state', 'actor', 'message', 'compaction'])

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
    stateVersion: 2,
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
      return merge(state, event.data.activity, event.data.nodes ?? [], event.data.edges ?? [], activityLimit, topologyLimit)
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
        workflowMembers: {
          ...next.workflowMembers,
          [workflowMemberKey(runId, event.data.seq)]: { runId, nodeId: childId, sessionId: String(event.data.childId), label: event.data.label },
        },
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
      const phasePrefix = `${id}:phase:`
      const phaseNodes = state.nodes
        .filter(node => node.kind === 'phase' && node.id.startsWith(phasePrefix))
        .map(node => ({ ...node, status, updatedAt: event.time }))
      const next = merge(state, {
        id: `workflow:${String(event.data.runId)}:end`, kind: 'workflow', action: event.data.stopReason,
        label: existing?.label ?? String(event.data.runId), status, updatedAt: event.time, nodeId: id,
      }, [...phaseNodes, { id, kind: 'workflow', label: existing?.label ?? String(event.data.runId), status, updatedAt: event.time }], [], activityLimit, topologyLimit)
      const workflowMembers = Object.fromEntries(Object.entries(next.workflowMembers)
        .filter(([, member]) => member.runId !== String(event.data.runId)))
      return { ...next, workflowMembers }
    }
    default:
      return state
  }
}

function merge(
  state: FabricProjectionState,
  activity: FabricActivityRecord,
  nodes: readonly FabricProjectedNode[],
  edges: readonly FabricProjectedEdge[],
  activityLimit: number,
  topologyLimit: number,
): FabricProjectionState {
  const nextNodes = nodes.reduce((values, node) => upsert(values, node, topologyLimit), state.nodes)
  const nextEdges = edges.reduce((values, edge) => upsert(values, edge, topologyLimit), state.edges)
    .filter(edge => edge.source === '$session' || nextNodes.some(node => node.id === edge.source))
    .filter(edge => edge.target === '$session' || nextNodes.some(node => node.id === edge.target))
  return {
    activities: [...state.activities.filter(item => item.id !== activity.id), activity].slice(-activityLimit),
    nodes: nextNodes,
    edges: nextEdges,
    workflowMembers: state.workflowMembers,
  }
}

function upsert<T extends { id: string }>(values: readonly T[], value: T, limit: number): T[] {
  return [...values.filter(candidate => candidate.id !== value.id), value].slice(-limit)
}

function workflowMemberKey(runId: string, seq: number): string {
  return `${runId.length}:${runId}:${seq}`
}

function workflowNodeId(runId: string): string {
  return `workflow:${runId}`
}

function workflowPhaseNodeId(runId: string, phase: string): string {
  return `workflow:${runId}:phase:${phase.length}:${phase}`
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
