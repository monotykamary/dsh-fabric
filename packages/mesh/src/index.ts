import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
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

  /** Return authoritative mesh collections, optionally retaining only the newest records of each kind. */
  abstract snapshot(limit?: number): FabricMeshSnapshot
  /** Resolve detached topic metadata. */
  abstract topic(id: FabricTopicId): FabricTopicRecord
  /** Resolve detached actor metadata and mailbox-derived status. */
  abstract actor(id: FabricActorId): FabricActorSnapshot
  /** Create one topic with an optional caller-selected id. */
  abstract createTopic(label: string, id?: FabricTopicId): Promise<FabricTopicRecord>
  /** Publish one immutable topic message. */
  abstract publish(topicId: FabricTopicId, payload: FabricJsonValue): Promise<FabricTopicMessage>
  /** Read newest topic messages up to `limit`. */
  abstract topicMessages(topicId: FabricTopicId, limit?: number): readonly FabricTopicMessage[]
  /** Delete older topic messages while retaining the newest `retain`. */
  abstract pruneTopic(topicId: FabricTopicId, retain: number): Promise<{ deleted: number; retained: number }>
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
  /** Delete older terminal mailbox records while retaining the newest terminal records. */
  abstract pruneActor(actorId: FabricActorId, retainTerminal: number): Promise<{ deleted: number; retained: number }>
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
