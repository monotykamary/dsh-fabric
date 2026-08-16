export type FabricJsonValue = null | boolean | number | string | FabricJsonValue[] | { [key: string]: FabricJsonValue }

/** Opaque graph node identifier. */
export type FabricNodeId = string & { readonly __fabricNodeId: unique symbol }

/** Opaque graph edge identifier. */
export type FabricEdgeId = string & { readonly __fabricEdgeId: unique symbol }

/** Node classes shared by host projections and browser renderers. */
export type FabricNodeKind =
  | 'main'
  | 'session'
  | 'subagent'
  | 'workflow'
  | 'phase'
  | 'job'
  | 'actor'
  | 'topic'
  | 'message'
  | 'state'
  | 'component'
  | 'compaction'

/** Portable lifecycle states used by Activity and Topology views. */
export type FabricNodeStatus = 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'blocked' | 'stopped'

/** Relationships rendered by the topology view. */
export type FabricEdgeKind = 'parent' | 'contains' | 'member' | 'publish' | 'message' | 'state' | 'route'

/** Kinds of timeline facts retained in a compact activity projection. */
export type FabricActivityKind = 'session' | 'workflow' | 'phase' | 'agent' | 'mesh' | 'topic' | 'state' | 'actor' | 'message' | 'compaction'

/** One timeline fact associated with a node when applicable. */
export interface FabricActivityRecord {
  id: string
  kind: FabricActivityKind
  action: string
  label: string
  status: FabricNodeStatus
  updatedAt: number
  nodeId?: string
  detail?: string
}

/** A host projection node before it is merged into one selected lineage. */
export interface FabricProjectedNode {
  id: string
  kind: FabricNodeKind
  label: string
  status: FabricNodeStatus
  updatedAt: number
  sessionId?: string
  detail?: string
}

/** A host projection edge. `$session` resolves to the projection-owning session. */
export interface FabricProjectedEdge {
  id: string
  source: string
  target: string
  kind: FabricEdgeKind
  updatedAt?: number
}

/** Compact host-computed activity and topology values for one session. */
export interface FabricActivityProjection {
  activities: readonly FabricActivityRecord[]
  nodes: readonly FabricProjectedNode[]
  edges: readonly FabricProjectedEdge[]
}

/** One session summary accepted by the host-independent lineage projection. */
export interface FabricSessionInput {
  id: string
  label: string
  parentId?: string
  origin?: 'subagent'
  running: boolean
  completed?: boolean
  updatedAt: number
  jobCount?: number
  tokens?: number
  durationMs?: number
  activity?: FabricActivityProjection
}

/** One normalized node in a Fabric topology snapshot. */
export interface FabricGraphNode {
  id: FabricNodeId
  sessionId?: string
  kind: FabricNodeKind
  label: string
  status: FabricNodeStatus
  updatedAt: number
  jobCount: number
  tokens?: number
  durationMs?: number
  detail?: string
}

/** One normalized relationship in a Fabric topology snapshot. */
export interface FabricGraphEdge {
  id: FabricEdgeId
  source: FabricNodeId
  target: FabricNodeId
  kind: FabricEdgeKind
  updatedAt?: number
}

/** Complete activity and topology graph rooted at the selected session's oldest known ancestor. */
export interface FabricGraph {
  rootId: FabricNodeId
  nodes: readonly FabricGraphNode[]
  edges: readonly FabricGraphEdge[]
  activities: readonly FabricActivityRecord[]
}
