import type { Context } from '@monotykamary/cordis'
import { Service } from '@monotykamary/cordis'
import type {
  FabricActorClaimToken,
  FabricActorId,
  FabricActorMessage,
  FabricActorMessageId,
  FabricActorRecord,
  FabricActorSnapshot,
  FabricJsonValue,
  FabricMeshSnapshot,
  FabricStateKey,
  FabricStateRecord,
  FabricTopicId,
  FabricTopicMessage,
  FabricTopicRecord,
} from 'dsh-fabric-protocol'

export type FabricMeshErrorCode = 'already-exists' | 'not-found' | 'version-conflict' | 'invalid-state' | 'claim-conflict'

/** Stable mesh failure with a machine-routable code. */
export class FabricMeshError extends Error {
  override readonly name = 'FabricMeshError'

  constructor(readonly code: FabricMeshErrorCode, message: string) {
    super(message)
  }
}

declare module '@monotykamary/cordis' {
  interface Context {
    fabricMesh: FabricMesh
  }
}

/** Operations bound to one stable DSH workspace identity. */
export interface FabricMeshWorkspace {
  snapshot(limit?: number): FabricMeshSnapshot
  topic(id: FabricTopicId): FabricTopicRecord
  actor(id: FabricActorId): FabricActorSnapshot
  createTopic(label: string, id?: FabricTopicId): Promise<FabricTopicRecord>
  publish(topicId: FabricTopicId, payload: FabricJsonValue): Promise<FabricTopicMessage>
  topicMessages(topicId: FabricTopicId, limit?: number): readonly FabricTopicMessage[]
  pruneTopic(topicId: FabricTopicId, retain: number): Promise<{ deleted: number; retained: number }>
  getState(key: FabricStateKey): FabricStateRecord | undefined
  compareAndSwap(key: FabricStateKey, expectedVersion: number, value: FabricJsonValue): Promise<FabricStateRecord>
  createActor(label: string, id?: FabricActorId): Promise<FabricActorRecord>
  sendActor(actorId: FabricActorId, payload: FabricJsonValue): Promise<FabricActorMessage>
  actorMessages(actorId: FabricActorId, limit?: number): readonly FabricActorMessage[]
  pruneActor(actorId: FabricActorId, retainTerminal: number): Promise<{ deleted: number; retained: number }>
  claimActor(actorId: FabricActorId): Promise<FabricActorMessage | null>
  settleActor(messageId: FabricActorMessageId, claimToken: FabricActorClaimToken, outcome: { result: FabricJsonValue } | { error: string }): Promise<FabricActorMessage>
}

/** Durable topics, compare-and-swap state, and actor mailboxes, always workspace-bound. */
export abstract class FabricMesh extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fabricMesh')
  }

  /** Bind every subsequent mesh read and mutation to one stable workspace identity. */
  abstract forWorkspace(identity: string): FabricMeshWorkspace
}

export default FabricMesh
