import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  FabricActorClaimToken,
  FabricActorId,
  FabricActorMessageId,
  FabricTopicId,
  FabricTopicMessageId,
} from '@dsh-fabric/protocol'
import type {
  FabricActorId as ActorId,
  FabricActorMessage,
  FabricActorMessageId as ActorMessageId,
  FabricActorRecord,
  FabricJsonValue,
  FabricMeshSnapshot,
  FabricStateKey,
  FabricStateRecord,
  FabricTopicId as TopicId,
  FabricTopicMessage,
  FabricTopicRecord,
} from '@dsh-fabric/protocol'
import FabricMesh, { FabricMeshError } from './index.ts'
import { fabricMeshDomainSpec } from './domain.ts'

/** Storage-domain provider for the Fabric mesh service. */
export class StorageFabricMesh extends FabricMesh {
  static inject = ['storageDomain']

  private domain?: Domain<typeof fabricMeshDomainSpec>
  private topics?: KvTable<TopicId, FabricTopicRecord>
  private topicMessageTable?: KvTable<ReturnType<typeof FabricTopicMessageId>, FabricTopicMessage>
  private states?: KvTable<FabricStateKey, FabricStateRecord>
  private actors?: KvTable<ActorId, FabricActorRecord>
  private actorMessageTable?: KvTable<ActorMessageId, FabricActorMessage>
  private operationTail: Promise<void> = Promise.resolve()
  private mutationAdmissionOpen = true

  constructor(ctx: Context) {
    super(ctx)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(fabricMeshDomainSpec)
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await this.operationTail
      await domain.close()
    }, 'dsh-fabric.meshDomainClose')
    this.domain = domain
    this.topics = domain.table('topics')
    this.topicMessageTable = domain.table('topic_messages')
    this.states = domain.table('states')
    this.actors = domain.table('actors')
    this.actorMessageTable = domain.table('actor_messages')
  }

  snapshot(): FabricMeshSnapshot {
    const actors = ordered(this.requireActors().entries()).map((actor) => {
      const messages = this.messagesForActor(actor.id)
      const queued = messages.filter(message => message.status === 'queued').length
      const claimed = messages.filter(message => message.status === 'claimed').length
      const status = claimed > 0
        ? 'running' as const
        : queued > 0
          ? 'pending' as const
          : messages.some(message => message.status === 'failed')
            ? 'failed' as const
            : 'idle' as const
      return { ...actor, status, queued, claimed }
    })
    return {
      topics: ordered(this.requireTopics().entries()),
      topicMessages: ordered(this.requireTopicMessages().entries()),
      states: ordered(this.requireStates().entries()),
      actors,
      actorMessages: ordered(this.requireActorMessages().entries()),
    }
  }

  createTopic(label: string, id = FabricTopicId(randomUUID())): Promise<FabricTopicRecord> {
    return this.enqueue(async () => {
      const table = this.requireTopics()
      if (table.get(id) !== undefined) throw new FabricMeshError('already-exists', `topic ${JSON.stringify(id)} already exists`)
      const now = Date.now()
      const topic: FabricTopicRecord = { id, label, createdAt: now, updatedAt: now }
      await table.put(id, topic)
      return topic
    })
  }

  publish(topicId: TopicId, payload: FabricJsonValue): Promise<FabricTopicMessage> {
    return this.enqueue(async () => {
      this.requireTopic(topicId)
      const message: FabricTopicMessage = {
        id: FabricTopicMessageId(randomUUID()), topicId, payload, publishedAt: Date.now(),
      }
      await this.requireTopicMessages().put(message.id, message)
      return message
    })
  }

  topicMessages(topicId: TopicId, limit = 100): readonly FabricTopicMessage[] {
    this.requireTopic(topicId)
    return newest(this.requireTopicMessages().entries(), message => message.topicId === topicId, limit)
  }

  getState(key: FabricStateKey): FabricStateRecord | undefined {
    return this.requireStates().get(key)
  }

  compareAndSwap(key: FabricStateKey, expectedVersion: number, value: FabricJsonValue): Promise<FabricStateRecord> {
    return this.enqueue(async () => {
      const table = this.requireStates()
      const current = table.get(key)
      const actual = current?.version ?? 0
      if (actual !== expectedVersion) {
        throw new FabricMeshError('version-conflict', `state ${JSON.stringify(key)} expected version ${expectedVersion}, current version is ${actual}`)
      }
      const next: FabricStateRecord = { key, version: actual + 1, value, updatedAt: Date.now() }
      if (current === undefined) await table.put(key, next)
      else await table.update(key, () => next)
      return next
    })
  }

  createActor(label: string, id = FabricActorId(randomUUID())): Promise<FabricActorRecord> {
    return this.enqueue(async () => {
      const table = this.requireActors()
      if (table.get(id) !== undefined) throw new FabricMeshError('already-exists', `actor ${JSON.stringify(id)} already exists`)
      const now = Date.now()
      const actor: FabricActorRecord = { id, label, createdAt: now, updatedAt: now }
      await table.put(id, actor)
      return actor
    })
  }

  sendActor(actorId: ActorId, payload: FabricJsonValue): Promise<FabricActorMessage> {
    return this.enqueue(async () => {
      this.requireActor(actorId)
      const now = Date.now()
      const message: FabricActorMessage = {
        id: FabricActorMessageId(randomUUID()), actorId, payload, status: 'queued', createdAt: now, updatedAt: now,
      }
      await this.requireActorMessages().put(message.id, message)
      return message
    })
  }

  actorMessages(actorId: ActorId, limit = 100): readonly FabricActorMessage[] {
    this.requireActor(actorId)
    return newest(this.requireActorMessages().entries(), message => message.actorId === actorId, limit)
  }

  claimActor(actorId: ActorId): Promise<FabricActorMessage | null> {
    return this.enqueue(async () => {
      this.requireActor(actorId)
      const candidate = this.messagesForActor(actorId)
        .filter(message => message.status === 'queued')
        .toSorted((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))[0]
      if (candidate === undefined) return null
      const now = Date.now()
      const claimed: FabricActorMessage = {
        ...candidate,
        status: 'claimed',
        claimToken: FabricActorClaimToken(randomUUID()),
        claimedAt: now,
        updatedAt: now,
      }
      return await this.requireActorMessages().update(candidate.id, () => claimed)
    })
  }

  settleActor(
    messageId: ActorMessageId,
    claimToken: FabricActorClaimToken,
    outcome: { result: FabricJsonValue } | { error: string },
  ): Promise<FabricActorMessage> {
    return this.enqueue(async () => {
      const table = this.requireActorMessages()
      const current = table.get(messageId)
      if (current === undefined) throw new FabricMeshError('not-found', `actor message ${JSON.stringify(messageId)} does not exist`)
      if (current.claimToken !== claimToken) throw new FabricMeshError('claim-conflict', `actor message ${JSON.stringify(messageId)} is owned by another claim`)
      if (current.status === 'completed' || current.status === 'failed') return current
      if (current.status !== 'claimed') throw new FabricMeshError('invalid-state', `actor message ${JSON.stringify(messageId)} is not claimed`)
      const settled: FabricActorMessage = {
        id: current.id,
        actorId: current.actorId,
        payload: current.payload,
        status: 'result' in outcome ? 'completed' : 'failed',
        createdAt: current.createdAt,
        updatedAt: Date.now(),
        claimToken,
        ...(current.claimedAt === undefined ? {} : { claimedAt: current.claimedAt }),
        ...'result' in outcome ? { result: outcome.result } : { error: outcome.error },
      }
      return await table.update(messageId, () => settled)
    })
  }

  private messagesForActor(actorId: ActorId): FabricActorMessage[] {
    return ordered(this.requireActorMessages().entries()).filter(message => message.actorId === actorId)
  }

  private requireTopic(id: TopicId): FabricTopicRecord {
    const value = this.requireTopics().get(id)
    if (value === undefined) throw new FabricMeshError('not-found', `topic ${JSON.stringify(id)} does not exist`)
    return value
  }

  private requireActor(id: ActorId): FabricActorRecord {
    const value = this.requireActors().get(id)
    if (value === undefined) throw new FabricMeshError('not-found', `actor ${JSON.stringify(id)} does not exist`)
    return value
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.mutationAdmissionOpen) return Promise.reject(new Error('dsh-fabric mesh service is disposing'))
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private requireTopics() { return required(this.topics, 'topics') }
  private requireTopicMessages() { return required(this.topicMessageTable, 'topic messages') }
  private requireStates() { return required(this.states, 'states') }
  private requireActors() { return required(this.actors, 'actors') }
  private requireActorMessages() { return required(this.actorMessageTable, 'actor messages') }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`dsh-fabric mesh ${label} are unavailable before service initialization`)
  return value
}

function ordered<K extends string, V>(entries: IterableIterator<[K, V]>): V[] {
  return [...entries].map(([, value]) => value)
}

function newest<K extends string, V extends { publishedAt?: number; updatedAt?: number }>(
  entries: IterableIterator<[K, V]>,
  include: (value: V) => boolean,
  limit: number,
): V[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer')
  return [...entries].map(([, value]) => value).filter(include)
    .toSorted((left, right) => (right.publishedAt ?? right.updatedAt ?? 0) - (left.publishedAt ?? left.updatedAt ?? 0))
    .slice(0, limit)
}

export default StorageFabricMesh
