import {
  buildLineageGraph,
  type FabricActivityRecord,
  type FabricGraph,
  type FabricGraphNode,
  type FabricSessionInput,
} from '@dsh-fabric/protocol'
import type {} from '@dsh-fabric/host/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'

/** One graph node with deterministic canvas coordinates. */
export interface PositionedFabricNode {
  node: FabricGraphNode
  x: number
  y: number
}

/** Deterministic layered layout consumed by the SVG renderer. */
export interface FabricTreeLayout {
  width: number
  height: number
  nodes: readonly PositionedFabricNode[]
}

/** Browser projection of the global session mirror for one selected lineage. */
export interface FabricClientModel {
  graph: FabricGraph
  layout: FabricTreeLayout
  active: readonly FabricGraphNode[]
  activity: readonly FabricActivityRecord[]
}

/** Project the selected session's known lineage, host activity, metrics, and layout. */
export function buildFabricClientModel(
  state: SessionListState,
  selectedSessionId: string,
  now: number,
): FabricClientModel | null {
  const sessions = orderedSummaries(state).map(summary => sessionInput(state, summary, now))
  const graph = buildLineageGraph(sessions, selectedSessionId)
  if (graph === null) return null
  return {
    graph,
    layout: layoutFabricTree(graph),
    active: graph.nodes
      .filter(node => node.status === 'running' || node.status === 'pending' || node.jobCount > 0)
      .toSorted((left, right) => right.updatedAt - left.updatedAt || left.label.localeCompare(right.label)),
    activity: graph.activities.toSorted((left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)),
  }
}

/** Lay out an arbitrary directed topology without assuming that edges form a tree. */
export function layoutFabricTree(graph: FabricGraph): FabricTreeLayout {
  const horizontalGap = 220
  const verticalGap = 116
  const marginX = 110
  const marginY = 62
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const values = outgoing.get(edge.source) ?? []
    values.push(edge.target)
    outgoing.set(edge.source, values)
  }
  for (const values of outgoing.values()) values.sort()

  const depth = new Map<string, number>([[graph.rootId, 0]])
  const queue: string[] = [graph.rootId]
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index]
    if (source === undefined) continue
    const sourceDepth = depth.get(source) ?? 0
    for (const target of outgoing.get(source) ?? []) {
      if (depth.has(target)) continue
      depth.set(target, sourceDepth + 1)
      queue.push(target)
    }
  }
  const connectedDepth = Math.max(0, ...depth.values())
  for (const node of graph.nodes) {
    if (!depth.has(node.id)) depth.set(node.id, connectedDepth + 1)
  }

  const levels = new Map<number, FabricGraphNode[]>()
  for (const node of graph.nodes) {
    const nodeDepth = depth.get(node.id) ?? 0
    const values = levels.get(nodeDepth) ?? []
    values.push(node)
    levels.set(nodeDepth, values)
  }
  for (const values of levels.values()) values.sort((left, right) => left.label.localeCompare(right.label) || String(left.id).localeCompare(String(right.id)))
  const largestLevel = Math.max(1, ...[...levels.values()].map(values => values.length))
  const width = Math.max(420, marginX * 2 + (largestLevel - 1) * horizontalGap)
  const nodes: PositionedFabricNode[] = []
  for (const [nodeDepth, values] of [...levels].toSorted(([left], [right]) => left - right)) {
    const span = (values.length - 1) * horizontalGap
    const start = (width - span) / 2
    values.forEach((node, index) => nodes.push({ node, x: start + index * horizontalGap, y: marginY + nodeDepth * verticalGap }))
  }
  const maxDepth = Math.max(0, ...levels.keys())
  return {
    width,
    height: Math.max(240, marginY * 2 + maxDepth * verticalGap + 54),
    nodes,
  }
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
  const activity = summary.projectionValues?.fabricActivity
  return {
    id: summary.id,
    label: summary.displayTitle,
    ...(summary.parentId === undefined ? {} : { parentId: summary.parentId }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
    running: summary.running,
    ...(summary.completed === undefined ? {} : { completed: summary.completed }),
    updatedAt: summary.updatedAt,
    jobCount: state.jobsBySession[summary.id]?.length ?? 0,
    ...(tokens === undefined ? {} : { tokens }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(activity === undefined ? {} : { activity }),
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
