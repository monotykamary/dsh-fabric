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
} from './types.ts'

/** Convert a session id to the graph's opaque node id. */
export function fabricSessionNodeId(sessionId: string): FabricNodeId {
  return `session:${sessionId}` as FabricNodeId
}

/** Build the selected session's known lineage and merge its host activity projections. */
export function buildLineageGraph(
  sessions: readonly FabricSessionInput[],
  selectedSessionId: string,
): FabricGraph | null {
  const byId = new Map(sessions.map(session => [session.id, session]))
  if (!byId.has(selectedSessionId)) return null

  const rootSessionId = findRoot(byId, selectedSessionId)
  const children = new Map<string, FabricSessionInput[]>()
  for (const session of sessions) {
    if (session.parentId === undefined || !byId.has(session.parentId)) continue
    const siblings = children.get(session.parentId) ?? []
    siblings.push(session)
    children.set(session.parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.id.localeCompare(right.id))

  const nodeById = new Map<FabricNodeId, FabricGraphNode>()
  const edgeById = new Map<FabricEdgeId, FabricGraphEdge>()
  const activities: FabricActivityRecord[] = []
  const visited = new Set<string>()
  const lineage: FabricSessionInput[] = []

  const visit = (sessionId: string, root: boolean): void => {
    if (visited.has(sessionId)) return
    const session = byId.get(sessionId)
    if (session === undefined) return
    visited.add(sessionId)
    lineage.push(session)
    const nodeId = fabricSessionNodeId(session.id)
    nodeById.set(nodeId, sessionNode(session, root, nodeId))
    activities.push({
      id: `session-summary:${session.id}`,
      kind: 'session',
      action: session.running ? 'running' : session.completed === true ? 'completed' : 'idle',
      label: session.label,
      status: sessionStatus(session),
      updatedAt: session.updatedAt,
      nodeId,
    })
    for (const child of children.get(sessionId) ?? []) {
      if (visited.has(child.id)) continue
      const childId = fabricSessionNodeId(child.id)
      const edge: FabricGraphEdge = {
        id: `parent:${sessionId}:${child.id}` as FabricEdgeId,
        source: nodeId,
        target: childId,
        kind: 'parent',
      }
      edgeById.set(edge.id, edge)
      visit(child.id, false)
    }
  }

  visit(rootSessionId, true)
  for (const session of lineage) mergeProjection(session, nodeById, edgeById, activities)

  const edges = [...edgeById.values()].filter(edge => nodeById.has(edge.source) && nodeById.has(edge.target))
  return {
    rootId: fabricSessionNodeId(rootSessionId),
    nodes: [...nodeById.values()],
    edges,
    activities,
  }
}

function sessionNode(session: FabricSessionInput, root: boolean, id: FabricNodeId): FabricGraphNode {
  return {
    id,
    sessionId: session.id,
    kind: root ? 'main' : session.origin === 'subagent' ? 'subagent' : 'session',
    label: session.label,
    status: sessionStatus(session),
    updatedAt: session.updatedAt,
    jobCount: session.jobCount ?? 0,
    ...(session.tokens === undefined ? {} : { tokens: session.tokens }),
    ...(session.durationMs === undefined ? {} : { durationMs: session.durationMs }),
  }
}

function mergeProjection(
  owner: FabricSessionInput,
  nodes: Map<FabricNodeId, FabricGraphNode>,
  edges: Map<FabricEdgeId, FabricGraphEdge>,
  activities: FabricActivityRecord[],
): void {
  const projection = owner.activity
  if (projection === undefined) return
  for (const projected of projection.nodes) {
    const id = endpoint(projected.id, owner.id)
    const existing = nodes.get(id)
    if (existing !== undefined && existing.sessionId !== undefined) {
      nodes.set(id, {
        ...existing,
        updatedAt: Math.max(existing.updatedAt, projected.updatedAt),
        ...(existing.detail === undefined && projected.detail !== undefined ? { detail: projected.detail } : {}),
      })
      continue
    }
    const candidate = projectedNode(id, projected)
    if (existing === undefined || candidate.updatedAt >= existing.updatedAt) nodes.set(id, candidate)
  }
  for (const projected of projection.edges) {
    const id = `projected:${owner.id}:${projected.id}` as FabricEdgeId
    edges.set(id, {
      id,
      source: endpoint(projected.source, owner.id),
      target: endpoint(projected.target, owner.id),
      kind: projected.kind,
      ...(projected.updatedAt === undefined ? {} : { updatedAt: projected.updatedAt }),
    })
  }
  for (const record of projection.activities) {
    activities.push({
      ...record,
      id: `projected:${owner.id}:${record.id}`,
      ...(record.nodeId === undefined ? {} : { nodeId: endpoint(record.nodeId, owner.id) }),
    })
  }
}

function projectedNode(id: FabricNodeId, node: FabricProjectedNode): FabricGraphNode {
  return {
    id,
    ...(node.sessionId === undefined ? {} : { sessionId: node.sessionId }),
    kind: node.kind,
    label: node.label,
    status: node.status,
    updatedAt: node.updatedAt,
    jobCount: 0,
    ...(node.detail === undefined ? {} : { detail: node.detail }),
  }
}

function endpoint(value: string, ownerSessionId: string): FabricNodeId {
  return (value === '$session' ? fabricSessionNodeId(ownerSessionId) : value) as FabricNodeId
}

function findRoot(byId: ReadonlyMap<string, FabricSessionInput>, selectedSessionId: string): string {
  const lineage: string[] = []
  const seen = new Set<string>()
  let current = selectedSessionId
  while (!seen.has(current)) {
    seen.add(current)
    lineage.push(current)
    const parent = byId.get(current)?.parentId
    if (parent === undefined || !byId.has(parent)) return current
    current = parent
  }
  return lineage.toSorted()[0] ?? selectedSessionId
}

function sessionStatus(session: FabricSessionInput): FabricNodeStatus {
  if (session.blocked === true) return 'blocked'
  if (session.running) return 'running'
  if (session.completed === true) return 'completed'
  return 'idle'
}
