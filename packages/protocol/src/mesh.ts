import type { FabricJsonValue, FabricNodeStatus } from './types.ts'

/** Opaque durable topic identifier. */
export type FabricTopicId = string & { readonly __fabricTopicId: unique symbol }
/** Opaque durable topic-message identifier. */
export type FabricTopicMessageId = string & { readonly __fabricTopicMessageId: unique symbol }
/** Opaque durable state key. */
export type FabricStateKey = string & { readonly __fabricStateKey: unique symbol }
/** Opaque durable actor identifier. */
export type FabricActorId = string & { readonly __fabricActorId: unique symbol }
/** Opaque durable actor-message identifier. */
export type FabricActorMessageId = string & { readonly __fabricActorMessageId: unique symbol }
/** Opaque actor-message claim token. */
export type FabricActorClaimToken = string & { readonly __fabricActorClaimToken: unique symbol }

/** Brand a validated topic id. */
export const FabricTopicId = (value: string): FabricTopicId => value as FabricTopicId
/** Brand a validated topic-message id. */
export const FabricTopicMessageId = (value: string): FabricTopicMessageId => value as FabricTopicMessageId
/** Brand a validated state key. */
export const FabricStateKey = (value: string): FabricStateKey => value as FabricStateKey
/** Brand a validated actor id. */
export const FabricActorId = (value: string): FabricActorId => value as FabricActorId
/** Brand a validated actor-message id. */
export const FabricActorMessageId = (value: string): FabricActorMessageId => value as FabricActorMessageId
/** Brand a validated actor-message claim token. */
export const FabricActorClaimToken = (value: string): FabricActorClaimToken => value as FabricActorClaimToken

/** Durable topic metadata. */
export interface FabricTopicRecord {
  id: FabricTopicId
  label: string
  createdAt: number
  updatedAt: number
}

/** One immutable message published to a durable topic. */
export interface FabricTopicMessage {
  id: FabricTopicMessageId
  topicId: FabricTopicId
  payload: FabricJsonValue
  publishedAt: number
}

/** One revisioned compare-and-swap value. */
export interface FabricStateRecord {
  key: FabricStateKey
  version: number
  value: FabricJsonValue
  updatedAt: number
}

/** Durable actor metadata. */
export interface FabricActorRecord {
  id: FabricActorId
  label: string
  createdAt: number
  updatedAt: number
}

/** Durable actor mailbox states. */
export type FabricActorMessageStatus = 'queued' | 'claimed' | 'completed' | 'failed'

/** One crash-conservative actor mailbox command. */
export interface FabricActorMessage {
  id: FabricActorMessageId
  actorId: FabricActorId
  payload: FabricJsonValue
  status: FabricActorMessageStatus
  createdAt: number
  updatedAt: number
  claimToken?: FabricActorClaimToken
  claimedAt?: number
  result?: FabricJsonValue
  error?: string
}

/** Actor plus status derived from its durable mailbox. */
export interface FabricActorSnapshot extends FabricActorRecord {
  status: FabricNodeStatus
  queued: number
  claimed: number
}

/** Complete synchronous view of the durable mesh service. */
export interface FabricMeshSnapshot {
  topics: readonly FabricTopicRecord[]
  topicMessages: readonly FabricTopicMessage[]
  states: readonly FabricStateRecord[]
  actors: readonly FabricActorSnapshot[]
  actorMessages: readonly FabricActorMessage[]
}
