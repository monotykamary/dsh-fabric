import { fabricSessionNodeId } from './graph.ts'
import { buildParticipantDirectory } from './participant.ts'
import type {
  FabricParticipantDirectory,
  FabricParticipantKind,
  FabricParticipantRecord,
} from './participant.ts'
import type {
  FabricActivityRecord,
  FabricEdgeId,
  FabricGraph,
  FabricGraphEdge,
  FabricGraphNode,
  FabricNodeId,
  FabricNodeStatus,
  FabricProjectedNode,
  FabricSessionInput,
  FabricTopologyGroupKind,
} from './types.ts'

/** Participant directory and normalized structural graph for one selected session family. */
export interface FabricTopologySnapshot {
  directory: FabricParticipantDirectory
  graph: FabricGraph
}

interface GroupSegment {
  id: string
  label: string
  group: FabricTopologyGroupKind
}

const PARTICIPANTS_ID = 'group:participants' as FabricNodeId
const MESH_ID = 'group:mesh' as FabricNodeId
const TOPICS_ID = 'group:mesh:topics' as FabricNodeId
const STATE_ID = 'group:mesh:state' as FabricNodeId
const COMPONENTS_ID = 'group:components' as FabricNodeId

/**
 * Build a canonical Fabric topology over participants and observed mesh resources.
 * Operational workflow, phase, message, and compaction records remain in Activity.
 */
export function buildFabricTopology(
  sessions: readonly FabricSessionInput[],
  selectedSessionId: string,
): FabricTopologySnapshot | null {
  const directory = buildParticipantDirectory(sessions, selectedSessionId)
  if (directory === null) return null

  const participantById = new Map(directory.participants.map(participant => [participant.id, participant]))
  const sessionIds = new Set(directory.participants.flatMap(participant =>
    participant.sessionId === undefined ? [] : [participant.sessionId]))
  const lineage = sessions.filter(session => sessionIds.has(session.id))
  const nodeById = new Map<FabricNodeId, FabricGraphNode>()
  const edgeById = new Map<FabricEdgeId, FabricGraphEdge>()

  for (const participant of directory.participants) nodeById.set(participant.id, participantNode(participant))

  const addStructure = (source: FabricNodeId, target: FabricNodeId, kind: 'parent' | 'contains'): void => {
    const id = `structure:${String(source)}:${String(target)}` as FabricEdgeId
    edgeById.set(id, { id, source, target, kind, role: 'structure' })
  }
  const ensureGroup = (
    id: FabricNodeId,
    label: string,
    group: FabricTopologyGroupKind,
    parentId: FabricNodeId,
    order: number,
  ): FabricNodeId => {
    if (!nodeById.has(id)) {
      nodeById.set(id, {
        id,
        group,
        kind: 'group',
        label,
        status: 'idle',
        updatedAt: 0,
        order,
        jobCount: 0,
      })
      addStructure(parentId, id, 'contains')
    }
    return id
  }

  for (const participant of directory.participants) {
    if (participant.id === directory.rootId) continue
    const semanticParent = participant.parentId === undefined ? undefined : participantById.get(participant.parentId)
    const nested = semanticParent !== undefined && semanticParent.id !== directory.rootId
    const parentId = nested
      ? semanticParent.id
      : participantCategoryParent(participant.kind, directory.rootId, ensureGroup)
    addStructure(parentId, participant.id, nested ? 'parent' : 'contains')
  }

  const resources = collectResources(lineage)
  for (const resource of resources) {
    const id = resource.id as FabricNodeId
    if (nodeById.has(id)) continue
    let parentId: FabricNodeId
    if (resource.kind === 'topic') {
      ensureGroup(MESH_ID, 'Mesh', 'mesh', directory.rootId, 1)
      ensureGroup(TOPICS_ID, 'Topics', 'topics', MESH_ID, 0)
      parentId = ensureGroupPath(TOPICS_ID, topicGroupPath(resource.label), ensureGroup)
    } else if (resource.kind === 'state') {
      ensureGroup(MESH_ID, 'Mesh', 'mesh', directory.rootId, 1)
      ensureGroup(STATE_ID, 'State', 'state', MESH_ID, 1)
      parentId = ensureGroupPath(STATE_ID, stateGroupPath(resource.label), ensureGroup)
    } else {
      parentId = ensureGroup(COMPONENTS_ID, 'Components', 'components', directory.rootId, 2)
    }
    nodeById.set(id, resourceNode(resource))
    addStructure(parentId, id, 'contains')
  }

  const activities: FabricActivityRecord[] = directory.participants
    .filter(participant => participant.source === 'session-mirror')
    .map(participant => ({
      id: `session-summary:${participant.sessionId ?? String(participant.id)}`,
      kind: 'session',
      action: participant.status === 'running'
        ? 'running'
        : participant.status === 'completed'
          ? 'completed'
          : participant.status === 'blocked'
            ? 'blocked'
            : 'idle',
      label: participant.name,
      status: participant.status,
      updatedAt: participant.updatedAt,
      nodeId: participant.id,
    }))

  for (const owner of lineage) {
    const projection = owner.activity
    if (projection === undefined) continue
    const ownerId = fabricSessionNodeId(owner.id)
    for (const record of projection.activities) {
      const nodeId = activityTarget(record.nodeId, projection.edges, ownerId, nodeById)
      activities.push({
        ...record,
        id: `projected:${owner.id}:${record.id}`,
        ...(nodeId === undefined ? {} : { nodeId }),
      })
    }
    for (const edge of projection.edges) {
      const traffic = trafficEdge(edge, ownerId, nodeById)
      if (traffic === undefined || traffic.source === traffic.target) continue
      const id = `traffic:${traffic.kind}:${String(traffic.source)}:${String(traffic.target)}` as FabricEdgeId
      const existing = edgeById.get(id)
      if (existing === undefined || (traffic.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        edgeById.set(id, { ...traffic, id })
      }
    }
  }

  summarizeGroups(nodeById, edgeById)
  return {
    directory,
    graph: {
      rootId: directory.rootId,
      nodes: [...nodeById.values()],
      edges: [...edgeById.values()],
      activities,
    },
  }
}

function participantNode(participant: FabricParticipantRecord): FabricGraphNode {
  return {
    id: participant.id,
    participantId: participant.id,
    ...(participant.sessionId === undefined ? {} : { sessionId: participant.sessionId }),
    kind: participant.kind === 'root' ? 'main' : participant.kind,
    label: participant.name,
    status: participant.status,
    updatedAt: participant.updatedAt,
    order: participantOrder(participant.kind),
    jobCount: participant.jobCount,
    ...(participant.tokens === undefined ? {} : { tokens: participant.tokens }),
    ...(participant.durationMs === undefined ? {} : { durationMs: participant.durationMs }),
    ...(participant.detail === undefined ? {} : { detail: participant.detail }),
  }
}

function participantOrder(kind: FabricParticipantKind): number {
  if (kind === 'session' || kind === 'root') return 0
  if (kind === 'agent') return 1
  return 2
}

function participantCategoryParent(
  kind: FabricParticipantKind,
  rootId: FabricNodeId,
  ensureGroup: (id: FabricNodeId, label: string, group: FabricTopologyGroupKind, parentId: FabricNodeId, order: number) => FabricNodeId,
): FabricNodeId {
  ensureGroup(PARTICIPANTS_ID, 'Participants', 'participants', rootId, 0)
  if (kind === 'agent') {
    return ensureGroup('group:participants:agents' as FabricNodeId, 'Agents', 'agents', PARTICIPANTS_ID, 1)
  }
  if (kind === 'actor') {
    return ensureGroup('group:participants:actors' as FabricNodeId, 'Actors', 'actors', PARTICIPANTS_ID, 2)
  }
  return ensureGroup('group:participants:sessions' as FabricNodeId, 'Sessions', 'sessions', PARTICIPANTS_ID, 0)
}

function collectResources(sessions: readonly FabricSessionInput[]): FabricProjectedNode[] {
  const byId = new Map<string, FabricProjectedNode>()
  for (const session of sessions) {
    for (const node of session.activity?.nodes ?? []) {
      if (node.kind !== 'topic' && node.kind !== 'state' && node.kind !== 'component') continue
      const existing = byId.get(node.id)
      if (existing === undefined || node.updatedAt >= existing.updatedAt) byId.set(node.id, node)
    }
  }
  return [...byId.values()].toSorted((left, right) =>
    resourceOrder(left) - resourceOrder(right)
    || left.label.localeCompare(right.label)
    || left.id.localeCompare(right.id))
}

function resourceOrder(node: FabricProjectedNode): number {
  if (node.kind === 'topic') return 0
  if (node.kind === 'state') return 1
  return 2
}

function resourceNode(node: FabricProjectedNode): FabricGraphNode {
  const stateLeaf = node.kind === 'state' ? node.label.split('/').filter(Boolean).at(-1) : undefined
  const label = stateLeaf ?? node.label
  const detail = node.detail ?? (label === node.label ? undefined : node.label)
  return {
    id: node.id as FabricNodeId,
    kind: node.kind,
    label,
    status: node.status,
    updatedAt: node.updatedAt,
    order: 0,
    jobCount: 0,
    ...(detail === undefined ? {} : { detail }),
  }
}

function ensureGroupPath(
  rootId: FabricNodeId,
  path: readonly GroupSegment[],
  ensureGroup: (id: FabricNodeId, label: string, group: FabricTopologyGroupKind, parentId: FabricNodeId, order: number) => FabricNodeId,
): FabricNodeId {
  let parentId = rootId
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]
    if (segment === undefined) continue
    const id = `${String(rootId)}:${segment.id}` as FabricNodeId
    parentId = ensureGroup(id, segment.label, segment.group, parentId, index)
  }
  return parentId
}

function topicGroupPath(name: string): GroupSegment[] {
  const parts = namespaceParts(name)
  if (parts[0] === 'fabric') {
    return [
      { id: 'fabric', label: 'Fabric', group: 'topic-fabric' },
      ...(parts.length > 2 && parts[1] !== undefined
        ? [{ id: `fabric:${segmentId(parts[1])}`, label: titleSegment(parts[1]), group: 'namespace' as const }]
        : []),
    ]
  }
  return [
    { id: 'project', label: 'Project topics', group: 'topic-project' },
    ...(parts.length > 1 && parts[0] !== undefined
      ? [{ id: `project:${segmentId(parts[0])}`, label: parts[0], group: 'namespace' as const }]
      : []),
  ]
}

function stateGroupPath(key: string): GroupSegment[] {
  const parts = key.split('/').map(part => part.trim()).filter(Boolean)
  if (parts[0] === 'state') {
    const path: GroupSegment[] = [{ id: 'world', label: 'World state', group: 'state-world' }]
    let prefix = 'world'
    if (parts[1] === 'complexity') {
      prefix += ':complexity'
      path.push({ id: prefix, label: 'Complexity', group: 'namespace' })
      for (const directory of parts.slice(2, -1)) {
        prefix += `:${segmentId(directory)}`
        path.push({ id: prefix, label: directory, group: 'namespace' })
      }
    } else {
      for (const directory of parts.slice(1, -1)) {
        prefix += `:${segmentId(directory)}`
        path.push({ id: prefix, label: titleSegment(directory), group: 'namespace' })
      }
    }
    return path
  }
  if (parts[0] === 'schema') {
    const path: GroupSegment[] = [{ id: 'schema', label: 'Schema', group: 'state-schema' }]
    const family = parts[1]
    if (family === 'hypothesis') {
      path.push({ id: 'schema:hypotheses', label: 'Hypotheses', group: 'namespace' })
    } else if (family === 'certificate') {
      path.push({ id: 'schema:certificates', label: 'Certificates', group: 'namespace' })
    } else {
      let prefix = 'schema'
      for (const directory of parts.slice(1, -1)) {
        prefix += `:${segmentId(directory)}`
        path.push({ id: prefix, label: titleSegment(directory), group: 'namespace' })
      }
    }
    return path
  }
  const path: GroupSegment[] = [{ id: 'project', label: 'Project state', group: 'state-project' }]
  let prefix = 'project'
  for (const directory of parts.slice(0, -1)) {
    prefix += `:${segmentId(directory)}`
    path.push({ id: prefix, label: directory, group: 'namespace' })
  }
  return path
}

function namespaceParts(value: string): string[] {
  return value.split(/[.:/]+/).map(part => part.trim()).filter(Boolean)
}

function segmentId(value: string): string {
  return `${value.length}:${value}`
}

function titleSegment(value: string): string {
  return value === '' ? value : (value[0]?.toUpperCase() ?? '') + value.slice(1)
}

function activityTarget(
  rawNodeId: string | undefined,
  edges: readonly { source: string; target: string }[],
  ownerId: FabricNodeId,
  nodes: ReadonlyMap<FabricNodeId, FabricGraphNode>,
): FabricNodeId | undefined {
  if (rawNodeId === undefined) return ownerId
  const direct = endpoint(rawNodeId, ownerId)
  if (nodes.has(direct)) return direct
  for (const edge of edges) {
    if (edge.target !== rawNodeId) continue
    const source = endpoint(edge.source, ownerId)
    if (nodes.has(source)) return source
  }
  for (const edge of edges) {
    if (edge.source !== rawNodeId) continue
    const target = endpoint(edge.target, ownerId)
    if (nodes.has(target)) return target
  }
  return ownerId
}

function trafficEdge(
  edge: { source: string; target: string; kind: string; updatedAt?: number },
  ownerId: FabricNodeId,
  nodes: ReadonlyMap<FabricNodeId, FabricGraphNode>,
): Omit<FabricGraphEdge, 'id'> | undefined {
  if (edge.kind === 'publish') {
    const topic = endpoint(edge.source, ownerId)
    if (!nodes.has(topic)) return undefined
    return {
      source: ownerId,
      target: topic,
      kind: 'publish',
      role: 'traffic',
      ...(edge.updatedAt === undefined ? {} : { updatedAt: edge.updatedAt }),
    }
  }
  if (edge.kind !== 'route' && edge.kind !== 'state') return undefined
  const source = endpoint(edge.source, ownerId)
  const target = endpoint(edge.target, ownerId)
  if (!nodes.has(source) || !nodes.has(target)) return undefined
  return {
    source,
    target,
    kind: edge.kind,
    role: 'traffic',
    ...(edge.updatedAt === undefined ? {} : { updatedAt: edge.updatedAt }),
  }
}

function endpoint(value: string, ownerId: FabricNodeId): FabricNodeId {
  return (value === '$session' ? ownerId : value) as FabricNodeId
}

function summarizeGroups(
  nodes: Map<FabricNodeId, FabricGraphNode>,
  edges: ReadonlyMap<FabricEdgeId, FabricGraphEdge>,
): void {
  type Summary = { statuses: FabricNodeStatus[]; updatedAt: number; jobs: number }
  const children = new Map<FabricNodeId, FabricNodeId[]>()
  for (const edge of edges.values()) {
    if (edge.role !== 'structure') continue
    const values = children.get(edge.source) ?? []
    values.push(edge.target)
    children.set(edge.source, values)
  }

  const summaries = new Map<FabricNodeId, Summary>()
  const groups: FabricNodeId[] = []
  for (const node of nodes.values()) {
    if (node.kind === 'group') groups.push(node.id)
    else summaries.set(node.id, { statuses: [node.status], updatedAt: node.updatedAt, jobs: node.jobCount })
  }

  const visiting = new Set<FabricNodeId>()
  for (const groupId of groups) {
    if (summaries.has(groupId)) continue
    const stack: Array<{ id: FabricNodeId; expanded: boolean }> = [{ id: groupId, expanded: false }]
    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame === undefined || summaries.has(frame.id)) continue
      const node = nodes.get(frame.id)
      if (node === undefined) continue
      if (!frame.expanded) {
        if (visiting.has(frame.id)) continue
        visiting.add(frame.id)
        stack.push({ id: frame.id, expanded: true })
        const descendants = children.get(frame.id) ?? []
        for (let index = descendants.length - 1; index >= 0; index -= 1) {
          const childId = descendants[index]
          if (childId !== undefined && !summaries.has(childId) && !visiting.has(childId)) {
            stack.push({ id: childId, expanded: false })
          }
        }
        continue
      }

      visiting.delete(frame.id)
      const descendants = (children.get(frame.id) ?? []).flatMap((childId) => {
        const summary = summaries.get(childId)
        return summary === undefined ? [] : [summary]
      })
      const statuses = descendants.flatMap(value => value.statuses)
      const updatedAt = Math.max(0, ...descendants.map(value => value.updatedAt))
      const jobs = descendants.reduce((total, value) => total + value.jobs, 0)
      const summary = { statuses, updatedAt, jobs }
      summaries.set(frame.id, summary)
      nodes.set(frame.id, { ...node, status: aggregateStatus(statuses), updatedAt, jobCount: jobs })
    }
  }
}

function aggregateStatus(statuses: readonly FabricNodeStatus[]): FabricNodeStatus {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('pending')) return 'pending'
  if (statuses.length > 0 && statuses.every(status => status === 'completed')) return 'completed'
  return 'idle'
}
