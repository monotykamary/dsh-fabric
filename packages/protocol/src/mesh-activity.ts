import type {
  FabricActivityKind,
  FabricActivityRecord,
  FabricEdgeKind,
  FabricJsonValue,
  FabricNodeKind,
  FabricNodeStatus,
  FabricProjectedEdge,
  FabricProjectedNode,
} from './types.ts'

/** Whole topology fact attached to a native DSH tool result after a mesh mutation commits. */
export interface FabricActivityEventData {
  activity: FabricActivityRecord
  nodes?: readonly FabricProjectedNode[]
  edges?: readonly FabricProjectedEdge[]
}

export const FABRIC_MESH_RESULT_META_KIND = 'dsh-fabric.mesh-result' as const
export const FABRIC_MESH_RESULT_META_VERSION = 1 as const

/** Presentation metadata persisted by DSH on a top-level fabric_mesh tool/result event. */
export interface FabricMeshResultMeta {
  kind: typeof FABRIC_MESH_RESULT_META_KIND
  version: typeof FABRIC_MESH_RESULT_META_VERSION
  activity?: FabricActivityEventData
}

/** Build bounded-domain presentation metadata without introducing a plugin event type. */
export function fabricMeshResultMeta(
  args: Record<string, unknown>,
  result: FabricJsonValue,
  fallbackTime = Date.now(),
): FabricMeshResultMeta {
  const activity = projectFabricMeshActivity(args, result, fallbackTime)
  return {
    kind: FABRIC_MESH_RESULT_META_KIND,
    version: FABRIC_MESH_RESULT_META_VERSION,
    ...(activity === undefined ? {} : { activity }),
  }
}

/** Recover validated Fabric metadata from a native DSH tool result. */
export function readFabricMeshResultMeta(value: unknown): FabricActivityEventData | undefined {
  if (!isRecord(value)
    || value.kind !== FABRIC_MESH_RESULT_META_KIND
    || value.version !== FABRIC_MESH_RESULT_META_VERSION
    || value.activity === undefined) return undefined
  return isActivityData(value.activity) ? value.activity : undefined
}

/** Deterministically project one successful fabric_mesh mutation result. */
export function projectFabricMeshActivity(
  args: Record<string, unknown>,
  result: FabricJsonValue,
  fallbackTime: number,
): FabricActivityEventData | undefined {
  const action = text(args.action)
  const value = isRecord(result) ? result : undefined
  if (action === undefined) return undefined
  const at = timestamp(value, fallbackTime)

  if (action === 'create_topic' && value !== undefined) {
    const id = text(value.id)
    if (id === undefined) return undefined
    const label = text(value.label) ?? id
    const nodeId = 'topic:' + id
    return fact(activity('topic:' + id + ':created', 'topic', 'created', label, 'completed', at, nodeId),
      [{ id: nodeId, kind: 'topic', label, status: 'idle', updatedAt: at }],
      [ownerEdge(nodeId, 'contains', at)])
  }
  if (action === 'publish' && value !== undefined) {
    const id = text(value.id)
    const topicId = text(value.topicId) ?? text(args.topic_id)
    if (id === undefined || topicId === undefined) return undefined
    const topicNode = 'topic:' + topicId
    const messageNode = 'message:' + id
    return fact(activity('topic:' + id + ':published', 'message', 'published', topicId, 'completed', at, messageNode), [
      { id: topicNode, kind: 'topic', label: topicId, status: 'idle', updatedAt: at },
      { id: messageNode, kind: 'message', label: 'Message ' + shortId(id), status: 'completed', updatedAt: at },
    ], [{ id: 'publish:' + id, source: topicNode, target: messageNode, kind: 'publish', updatedAt: at }])
  }
  if (action === 'prune_topic') {
    const id = text(args.topic_id)
    if (id === undefined) return undefined
    const nodeId = 'topic:' + id
    const detail = countDetail(value, 'retained', ' retained')
    return fact(activity('topic:' + id + ':pruned:' + at, 'topic', 'pruned', id, 'completed', at, nodeId, countDetail(value, 'deleted', ' deleted')),
      [{ id: nodeId, kind: 'topic', label: id, status: 'idle', updatedAt: at, ...(detail === undefined ? {} : { detail }) }],
      [ownerEdge(nodeId, 'contains', at)])
  }
  if (action === 'cas_state' && value !== undefined) {
    const key = text(value.key) ?? text(args.key)
    if (key === undefined) return undefined
    const nodeId = 'state:' + key
    const version = integer(value.version)
    const detail = version === undefined ? undefined : 'revision ' + version
    return fact(activity('state:' + key + ':' + String(version ?? at), 'state', 'compare-and-swap', key, 'completed', at, nodeId, detail),
      [{ id: nodeId, kind: 'state', label: key, status: 'completed', updatedAt: at, ...(detail === undefined ? {} : { detail }) }],
      [ownerEdge(nodeId, 'state', at)])
  }
  if (action === 'create_actor' && value !== undefined) {
    const id = text(value.id)
    if (id === undefined) return undefined
    const label = text(value.label) ?? id
    const nodeId = 'actor:' + id
    return fact(activity('actor:' + id + ':created', 'actor', 'created', label, 'completed', at, nodeId),
      [{ id: nodeId, kind: 'actor', label, status: 'idle', updatedAt: at }],
      [ownerEdge(nodeId, 'contains', at)])
  }
  if (action === 'send_actor') return actorMessageFact(value, at, 'sent', 'pending')
  if (action === 'claim_actor_message') return actorMessageFact(value, at, 'claimed', 'running')
  if (action === 'settle_actor_message') {
    const failed = value?.status === 'failed'
    return actorMessageFact(value, at, failed ? 'failed' : 'completed', failed ? 'failed' : 'completed')
  }
  if (action === 'prune_mailbox') {
    const id = text(args.actor_id)
    if (id === undefined) return undefined
    const nodeId = 'actor:' + id
    const detail = countDetail(value, 'retained', ' terminal records retained')
    return fact(activity('actor:' + id + ':pruned:' + at, 'actor', 'pruned', id, 'completed', at, nodeId, countDetail(value, 'deleted', ' deleted')),
      [{ id: nodeId, kind: 'actor', label: id, status: 'idle', updatedAt: at, ...(detail === undefined ? {} : { detail }) }],
      [ownerEdge(nodeId, 'contains', at)])
  }
  return undefined
}

function actorMessageFact(
  value: Record<string, FabricJsonValue> | undefined,
  at: number,
  action: string,
  status: FabricNodeStatus,
): FabricActivityEventData | undefined {
  if (value === undefined) return undefined
  const id = text(value.id)
  const actorId = text(value.actorId)
  if (id === undefined || actorId === undefined) return undefined
  const actorNode = 'actor:' + actorId
  const messageNode = 'message:' + id
  const actorStatus: FabricNodeStatus = status === 'running' ? 'running' : status === 'pending' ? 'pending' : status === 'failed' ? 'failed' : 'idle'
  return fact(activity('actor:' + id + ':' + action, 'message', action, actorId, status, at, messageNode), [
    { id: actorNode, kind: 'actor', label: actorId, status: actorStatus, updatedAt: at },
    { id: messageNode, kind: 'message', label: 'Message ' + shortId(id), status, updatedAt: at },
  ], [
    { id: 'route:' + id, source: '$session', target: actorNode, kind: 'route', updatedAt: at },
    { id: 'actor-message:' + id, source: actorNode, target: messageNode, kind: 'message', updatedAt: at },
  ])
}

function activity(
  id: string,
  kind: FabricActivityRecord['kind'],
  action: string,
  label: string,
  status: FabricNodeStatus,
  updatedAt: number,
  nodeId: string,
  detail?: string,
): FabricActivityRecord {
  return { id, kind, action, label, status, updatedAt, nodeId, ...(detail === undefined ? {} : { detail }) }
}

function fact(activityValue: FabricActivityRecord, nodes: FabricProjectedNode[], edges: FabricProjectedEdge[]): FabricActivityEventData {
  return { activity: activityValue, nodes, edges }
}

function ownerEdge(target: string, kind: 'contains' | 'state', updatedAt: number): FabricProjectedEdge {
  return { id: kind + ':' + target, source: '$session', target, kind, updatedAt }
}

function timestamp(value: Record<string, FabricJsonValue> | undefined, fallback: number): number {
  const candidate = value?.updatedAt ?? value?.publishedAt ?? value?.createdAt
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : fallback
}

function countDetail(value: Record<string, FabricJsonValue> | undefined, field: string, suffix: string): string | undefined {
  const count = integer(value?.[field])
  return count === undefined ? undefined : String(count) + suffix
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function isActivityData(value: unknown): value is FabricActivityEventData {
  if (!isRecord(value) || !isActivity(value.activity)) return false
  if (value.nodes !== undefined && (!Array.isArray(value.nodes) || !value.nodes.every(isNode))) return false
  return value.edges === undefined || (Array.isArray(value.edges) && value.edges.every(isEdge))
}

const ACTIVITY_KINDS = new Set<FabricActivityKind>([
  'session', 'workflow', 'phase', 'agent', 'execution', 'mesh', 'topic', 'state', 'actor', 'message', 'compaction',
])
const NODE_KINDS = new Set<FabricNodeKind>([
  'main', 'group', 'session', 'agent', 'subagent', 'workflow', 'phase', 'job', 'actor', 'topic', 'message', 'state', 'component', 'compaction',
])
const NODE_STATUSES = new Set<FabricNodeStatus>([
  'pending', 'running', 'idle', 'completed', 'failed', 'blocked', 'stopped',
])
const EDGE_KINDS = new Set<FabricEdgeKind>([
  'parent', 'contains', 'member', 'publish', 'message', 'state', 'route',
])

function isActivity(value: unknown): value is FabricActivityRecord {
  return isRecord(value)
    && text(value.id) !== undefined
    && member(value.kind, ACTIVITY_KINDS)
    && text(value.action) !== undefined
    && typeof value.label === 'string'
    && member(value.status, NODE_STATUSES)
    && timestampValue(value.updatedAt)
    && (value.nodeId === undefined || typeof value.nodeId === 'string')
    && (value.detail === undefined || typeof value.detail === 'string')
}

function isNode(value: unknown): value is FabricProjectedNode {
  return isRecord(value)
    && text(value.id) !== undefined
    && member(value.kind, NODE_KINDS)
    && typeof value.label === 'string'
    && member(value.status, NODE_STATUSES)
    && (value.updatedAt === undefined || timestampValue(value.updatedAt))
    && (value.sessionId === undefined || typeof value.sessionId === 'string')
    && (value.detail === undefined || typeof value.detail === 'string')
}

function isEdge(value: unknown): value is FabricProjectedEdge {
  return isRecord(value)
    && text(value.id) !== undefined
    && typeof value.source === 'string'
    && typeof value.target === 'string'
    && member(value.kind, EDGE_KINDS)
    && (value.updatedAt === undefined || timestampValue(value.updatedAt))
}

function member<T extends string>(value: unknown, values: ReadonlySet<T>): value is T {
  return typeof value === 'string' && values.has(value as T)
}

function timestampValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, FabricJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
