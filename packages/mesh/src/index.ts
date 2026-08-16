import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {
  FabricActorClaimToken,
  FabricActorId,
  FabricActorMessage,
  FabricActorMessageId,
  FabricActorRecord,
  FabricJsonValue,
  FabricMeshSnapshot,
  FabricStateKey,
  FabricStateRecord,
  FabricTopicId,
  FabricTopicMessage,
  FabricTopicRecord,
} from '@dsh-fabric/protocol'

export type FabricMeshErrorCode = 'already-exists' | 'not-found' | 'version-conflict' | 'invalid-state' | 'claim-conflict'

/** Stable mesh failure with a machine-routable code. */
export class FabricMeshError extends Error {
  override readonly name = 'FabricMeshError'

  constructor(readonly code: FabricMeshErrorCode, message: string) {
    super(message)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fabricMesh: FabricMesh
  }
}

/** Durable topics, compare-and-swap state, and crash-conservative actor mailboxes. */
export abstract class FabricMesh extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fabricMesh')
  }

  /** Return the current durable mesh snapshot from authoritative in-memory domain state. */
  abstract snapshot(): FabricMeshSnapshot
  /** Create one topic with an optional caller-selected id. */
  abstract createTopic(label: string, id?: FabricTopicId): Promise<FabricTopicRecord>
  /** Publish one immutable topic message. */
  abstract publish(topicId: FabricTopicId, payload: FabricJsonValue): Promise<FabricTopicMessage>
  /** Read newest topic messages up to `limit`. */
  abstract topicMessages(topicId: FabricTopicId, limit?: number): readonly FabricTopicMessage[]
  /** Read one revisioned state value. */
  abstract getState(key: FabricStateKey): FabricStateRecord | undefined
  /** Replace state exactly when `expectedVersion` matches, where 0 means absent. */
  abstract compareAndSwap(key: FabricStateKey, expectedVersion: number, value: FabricJsonValue): Promise<FabricStateRecord>
  /** Create one actor mailbox. */
  abstract createActor(label: string, id?: FabricActorId): Promise<FabricActorRecord>
  /** Queue one durable actor command. */
  abstract sendActor(actorId: FabricActorId, payload: FabricJsonValue): Promise<FabricActorMessage>
  /** Read newest actor messages up to `limit`. */
  abstract actorMessages(actorId: FabricActorId, limit?: number): readonly FabricActorMessage[]
  /** Claim the oldest queued command, returning null when the mailbox is empty. */
  abstract claimActor(actorId: FabricActorId): Promise<FabricActorMessage | null>
  /** Settle one claimed command; repeating the same token replays its stored result. */
  abstract settleActor(
    messageId: FabricActorMessageId,
    claimToken: FabricActorClaimToken,
    outcome: { result: FabricJsonValue } | { error: string },
  ): Promise<FabricActorMessage>
}

export default FabricMesh
