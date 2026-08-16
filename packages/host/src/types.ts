import type { FabricActivityEventData, FabricActivityProjection } from '@dsh-fabric/protocol'

export {}

export type { FabricActivityEventData } from '@dsh-fabric/protocol'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Legacy alpha replay shape; new writes use native DSH tool events. */
    'fabric/activity': FabricActivityEventData
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Bounded activity timeline and topology additions derived from the durable log. */
    fabricActivity: FabricActivityProjection
  }
}
