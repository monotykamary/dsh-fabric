import type { SessionListState, SessionSummary } from '@monotykamary/dsh-client-runtime/client'
import {
  buildFabricTopology,
  type FabricActivityProjection,
  type FabricActivityRecord,
  type FabricGraph,
  type FabricGraphEdge,
  type FabricGraphNode,
  type FabricNodeId,
  type FabricParticipantDirectory,
  type FabricParticipantRecord,
  type FabricSessionInput,
} from 'dsh-fabric-protocol'
import type {} from 'dsh-fabric-host/types'
import type {} from '@monotykamary/dsh-subagent/client'
import type {} from '@monotykamary/dsh-token-meter/client'

const NODE_WIDTH = 164
const MARGIN_X = 106
const MARGIN_Y = 54
const COLUMN_GAP = 232
const ROW_GAP = 86

export interface FabricLayoutNode {
  node: FabricGraphNode
  x: number
  y: number
  depth: number
  parentId?: FabricNodeId
  childIds: readonly FabricNodeId[]
}

export interface FabricLayout {
  width: number
  height: number
  nodes: readonly FabricLayoutNode[]
}

export type FabricNavigationDirection = 'parent' | 'child' | 'previous' | 'next'

export interface FabricClientModel {
  graph: FabricGraph
  directory: FabricParticipantDirectory
  layout: FabricLayout
  activity: readonly FabricActivityRecord[]
  participants: readonly FabricParticipantRecord[]
  active: readonly FabricParticipantRecord[]
  resourceCount: number
}

/** Build the renderer model from DSH's authoritative session mirror and host projections. */
export function buildFabricClientModel(
  state: SessionListState,
  selectedSessionId: string,
  now: number,
): FabricClientModel | null {
  const topology = buildFabricTopology(
    orderedSummaries(state).map(summary => sessionInput(state, summary, now)),
    selectedSessionId,
  )
  if (topology === null) return null
  const activity = [...topology.graph.activities]
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, 80)
  const participants = topology.directory.participants
  return {
    graph: topology.graph,
    directory: topology.directory,
    layout: layoutFabricTree(topology.graph),
    activity,
    participants,
    active: participants.filter(participant =>
      participant.status === 'running'
      || participant.status === 'pending'
      || participant.status === 'blocked'),
    resourceCount: topology.graph.nodes.filter(node =>
      node.kind === 'topic' || node.kind === 'state').length,
  }
}

/** Place the structural topology left-to-right, centering every parent over its children. */
export function layoutFabricTree(graph: FabricGraph): FabricLayout {
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const parentById = new Map<FabricNodeId, FabricNodeId>()
  const childIdsById = new Map<FabricNodeId, FabricNodeId[]>()
  for (const edge of graph.edges.filter(isStructuralEdge).toSorted(compareEdges)) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.target === graph.rootId) continue
    if (parentById.has(edge.target)) continue
    parentById.set(edge.target, edge.source)
    const values = childIdsById.get(edge.source) ?? []
    values.push(edge.target)
    childIdsById.set(edge.source, values)
  }
  for (const values of childIdsById.values()) {
    values.sort((left, right) => compareNodes(nodeById.get(left), nodeById.get(right)))
  }

  const positions = new Map<FabricNodeId, { x: number; y: number; depth: number }>()
  const visiting = new Set<FabricNodeId>()
  let nextRow = 0
  let maxDepth = 0
  const place = (startId: FabricNodeId, startDepth: number): void => {
    const stack: Array<{ id: FabricNodeId; depth: number; expanded: boolean }> = [
      { id: startId, depth: startDepth, expanded: false },
    ]
    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame === undefined || positions.has(frame.id)) continue
      if (!frame.expanded) {
        if (visiting.has(frame.id)) continue
        visiting.add(frame.id)
        stack.push({ ...frame, expanded: true })
        const descendants = childIdsById.get(frame.id) ?? []
        for (let index = descendants.length - 1; index >= 0; index -= 1) {
          const childId = descendants[index]
          if (childId !== undefined && !positions.has(childId) && !visiting.has(childId)) {
            stack.push({ id: childId, depth: frame.depth + 1, expanded: false })
          }
        }
        continue
      }

      visiting.delete(frame.id)
      const childYs = (childIdsById.get(frame.id) ?? []).flatMap((childId) => {
        const child = positions.get(childId)
        return child === undefined ? [] : [child.y]
      })
      const y = childYs.length === 0
        ? MARGIN_Y + nextRow++ * ROW_GAP
        : ((childYs[0] ?? MARGIN_Y) + (childYs.at(-1) ?? MARGIN_Y)) / 2
      positions.set(frame.id, { x: MARGIN_X + frame.depth * COLUMN_GAP, y, depth: frame.depth })
      maxDepth = Math.max(maxDepth, frame.depth)
    }
  }

  if (nodeById.has(graph.rootId)) place(graph.rootId, 0)
  const remaining = graph.nodes
    .filter(node => !positions.has(node.id))
    .toSorted(compareNodes)
  for (const node of remaining) place(node.id, 0)

  const orderedNodeIds: FabricNodeId[] = []
  const ordered = new Set<FabricNodeId>()
  const appendPreorder = (startId: FabricNodeId): void => {
    const stack = [startId]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || ordered.has(id) || !positions.has(id)) continue
      ordered.add(id)
      orderedNodeIds.push(id)
      const descendants = childIdsById.get(id) ?? []
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        const childId = descendants[index]
        if (childId !== undefined) stack.push(childId)
      }
    }
  }
  appendPreorder(graph.rootId)
  for (const node of remaining) appendPreorder(node.id)

  const nodes = orderedNodeIds.flatMap((id) => {
    const node = nodeById.get(id)
    const position = positions.get(id)
    if (node === undefined || position === undefined) return []
    const parentId = parentById.get(id)
    return [{
      node,
      ...position,
      ...(parentId === undefined ? {} : { parentId }),
      childIds: childIdsById.get(id) ?? [],
    }]
  })
  const maxY = Math.max(MARGIN_Y, ...nodes.map(node => node.y))
  return {
    width: Math.max(640, MARGIN_X * 2 + maxDepth * COLUMN_GAP + NODE_WIDTH),
    height: Math.max(320, maxY + MARGIN_Y),
    nodes,
  }
}

/** Resolve deterministic tree-relative keyboard movement from the shared layout index. */
export function navigateFabricTopology(
  layout: FabricLayout,
  currentId: string,
  direction: FabricNavigationDirection,
): FabricNodeId | undefined {
  const current = layout.nodes.find(value => value.node.id === currentId)
  if (current === undefined) return undefined
  if (direction === 'parent') return current.parentId ?? current.node.id
  if (direction === 'child') return current.childIds[0] ?? current.node.id
  if (current.parentId === undefined) return current.node.id
  const siblings = layout.nodes.find(value => value.node.id === current.parentId)?.childIds ?? []
  const index = siblings.indexOf(current.node.id)
  if (index < 0) return current.node.id
  if (direction === 'previous') return siblings[Math.max(0, index - 1)] ?? current.node.id
  return siblings[Math.min(siblings.length - 1, index + 1)] ?? current.node.id
}

function orderedSummaries(state: SessionListState): SessionSummary[] {
  const ordered: SessionSummary[] = []
  const seen = new Set<string>()
  for (const id of state.ids) {
    const summary = state.byId[id]
    if (summary === undefined) continue
    ordered.push(summary)
    seen.add(id)
  }
  for (const id of Object.keys(state.byId).toSorted()) {
    if (seen.has(id)) continue
    const summary = state.byId[id]
    if (summary !== undefined) ordered.push(summary)
  }
  return ordered
}

function sessionInput(state: SessionListState, summary: SessionSummary, now: number): FabricSessionInput {
  const tokens = tokenTotal(summary.projectionValues?.tokenUsage)
  const durationMs = subagentDuration(summary.projectionValues?.subagentTiming, summary.running, now)
  const projection = summary.projectionValues?.fabricActivity as FabricActivityProjection | undefined
  return {
    id: summary.id,
    label: summary.displayTitle,
    ...(summary.parentId === undefined ? {} : { parentId: summary.parentId }),
    ...(summary.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    running: summary.running,
    ...(summary.pendingInteraction === undefined ? {} : { blocked: true }),
    ...(summary.completed === undefined ? {} : { completed: summary.completed }),
    updatedAt: summary.updatedAt,
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(summary.agentPreset === undefined ? {} : { preset: summary.agentPreset }),
    jobCount: state.jobsBySession[summary.id]?.length ?? 0,
    ...(tokens === undefined ? {} : { tokens }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(projection === undefined ? {} : { activity: projection }),
  }
}

function tokenTotal(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const fields = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
  let total = 0
  let present = false
  for (const field of fields) {
    const amount = record[field]
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue
    total += amount
    present = true
  }
  return present ? total : undefined
}

function subagentDuration(value: unknown, running: boolean, now: number): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const settled = finiteNumber(record.settledMs) ?? 0
  const active = record.active
  if (typeof active !== 'object' || active === null) return settled === 0 ? undefined : settled
  const activeRecord = active as Record<string, unknown>
  const since = finiteNumber(activeRecord.since)
  if (since === undefined) return settled === 0 ? undefined : settled
  const through = finiteNumber(activeRecord.through)
  return Math.max(0, settled + Math.max(0, (running ? now : through ?? since) - since))
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isStructuralEdge(edge: FabricGraphEdge): boolean {
  if (edge.role !== undefined) return edge.role === 'structure'
  return edge.kind === 'parent' || edge.kind === 'contains' || edge.kind === 'member'
}

function compareEdges(left: FabricGraphEdge, right: FabricGraphEdge): number {
  return String(left.source).localeCompare(String(right.source))
    || String(left.target).localeCompare(String(right.target))
    || String(left.id).localeCompare(String(right.id))
}

function compareNodes(left: FabricGraphNode | undefined, right: FabricGraphNode | undefined): number {
  if (left === undefined) return right === undefined ? 0 : 1
  if (right === undefined) return -1
  if (left.kind === 'group' && right.kind === 'group') {
    const order = (left.order ?? 0) - (right.order ?? 0)
    if (order !== 0) return order
  }
  const active = activeRank(left.status) - activeRank(right.status)
  if (active !== 0) return active
  const order = (left.order ?? 0) - (right.order ?? 0)
  if (order !== 0) return order
  const kind = kindRank(left.kind) - kindRank(right.kind)
  if (kind !== 0) return kind
  return left.label.localeCompare(right.label) || String(left.id).localeCompare(String(right.id))
}

function activeRank(status: FabricGraphNode['status']): number {
  if (status === 'running' || status === 'pending' || status === 'blocked') return 0
  if (status === 'failed') return 1
  if (status === 'idle') return 2
  return 3
}

function kindRank(kind: FabricGraphNode['kind']): number {
  if (kind === 'main') return 0
  if (kind === 'group') return 1
  if (kind === 'session') return 2
  if (kind === 'agent' || kind === 'subagent') return 3
  if (kind === 'actor') return 4
  if (kind === 'topic') return 5
  if (kind === 'state') return 6
  if (kind === 'component') return 7
  return 8
}
