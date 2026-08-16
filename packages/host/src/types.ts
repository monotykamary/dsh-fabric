import type {
  FabricActivityProjection,
  FabricActivityRecord,
  FabricProjectedEdge,
  FabricProjectedNode,
} from '@dsh-fabric/protocol'

export {}

/** Whole activity fact appended after one Fabric-owned operation commits. */
export interface FabricActivityEventData {
  activity: FabricActivityRecord
  nodes?: readonly FabricProjectedNode[]
  edges?: readonly FabricProjectedEdge[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A committed Fabric operation and its complete topology updates. */
    'fabric/activity': FabricActivityEventData
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Bounded activity timeline and topology additions derived from the durable log. */
    fabricActivity: FabricActivityProjection
  }
}
