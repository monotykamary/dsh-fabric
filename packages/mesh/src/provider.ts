import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@monotykamary/cordis'
import { Service } from '@monotykamary/cordis'
import type { Domain, KvTable } from '@monotykamary/dsh-storage-domain'
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
  FabricActorSnapshot,
  FabricJsonValue,
  FabricMeshSnapshot,
  FabricStateKey,
  FabricStateRecord,
  FabricTopicId as TopicId,
  FabricTopicMessage,
  FabricTopicRecord,
} from '@dsh-fabric/protocol'
import FabricMesh, { FabricMeshError } from './index.ts'
import type { FabricMeshWorkspace } from './index.ts'
import { fabricMeshDomainSpec } from './domain.ts'

const MAX_IDENTIFIER_BYTES = 256
const MAX_LABEL_BYTES = 512
const MAX_ERROR_BYTES = 8 * 1024

type ActorCounts = { queued: number; claimed: number; failed: number }

/** Storage-domain provider for the Fabric mesh service. */
export class StorageFabricMesh extends FabricMesh {
  static inject = ['storageDomain']

  private domain?: Domain<typeof fabricMeshDomainSpec>
  private topics?: KvTable<TopicId, FabricTopicRecord>
  private topicMessageTable?: KvTable<ReturnType<typeof FabricTopicMessageId>, FabricTopicMessage>
  private states?: KvTable<FabricStateKey, FabricStateRecord>
  private actors?: KvTable<ActorId, FabricActorRecord>
  private actorMessageTable?: KvTable<ActorMessageId, FabricActorMessage>
  private readonly actorCounts = new Map<string, ActorCounts>()
  private operationTail: Promise<void> = Promise.resolve()
  private mutationAdmissionOpen = true

  constructor(ctx: Context) {
    super(ctx)
  }

  /** Bind all reads and mutations to one canonical DSH workspace identity. */
  forWorkspace(identity: string): FabricMeshWorkspace {
    assertText(identity, 'workspace identity', 16 * 1024)
    const workspace = workspaceDigest(identity)
    const scoped: FabricMeshWorkspace = {
      snapshot: (limit?: number) => this.snapshotIn(workspace, limit),
      topic: id => this.topicIn(workspace, id),
      actor: id => this.actorIn(workspace, id),
      createTopic: (label, id) => this.createTopicIn(workspace, label, id),
      publish: (topicId, payload) => this.publishIn(workspace, topicId, payload),
      topicMessages: (topicId, limit) => this.topicMessagesIn(workspace, topicId, limit),
      pruneTopic: (topicId, retain) => this.pruneTopicIn(workspace, topicId, retain),
      getState: key => this.getStateIn(workspace, key),
      compareAndSwap: (key, expectedVersion, value) => this.compareAndSwapIn(workspace, key, expectedVersion, value),
      createActor: (label, id) => this.createActorIn(workspace, label, id),
      sendActor: (actorId, payload) => this.sendActorIn(workspace, actorId, payload),
      actorMessages: (actorId, limit) => this.actorMessagesIn(workspace, actorId, limit),
      pruneActor: (actorId, retainTerminal) => this.pruneActorIn(workspace, actorId, retainTerminal),
      claimActor: actorId => this.claimActorIn(workspace, actorId),
      settleActor: (messageId, claimToken, outcome) => this.settleActorIn(workspace, messageId, claimToken, outcome),
    }
    return Object.freeze(scoped)
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
    for (const [key, message] of this.actorMessageTable.entries()) {
      this.adjustActorCount(workspaceFromStorageKey(String(key)), message.actorId, message.status, 1)
    }
  }

  private snapshotIn(workspace: string, limit?: number): FabricMeshSnapshot {
    const keep = snapshotLimit(limit)
    const topicEntries = scopedEntries(this.requireTopics().entries(), workspace)
    const topicMessageEntries = scopedEntries(this.requireTopicMessages().entries(), workspace)
    const stateEntries = scopedEntries(this.requireStates().entries(), workspace)
    const actorEntries = scopedEntries(this.requireActors().entries(), workspace)
    const actorMessageEntries = scopedEntries(this.requireActorMessages().entries(), workspace)
    const topics = recent(topicEntries, value => value.updatedAt, keep)
    const messages = recent(topicMessageEntries, value => value.publishedAt, keep)
    const states = recent(stateEntries, value => value.updatedAt, keep)
    const actors = recent(actorEntries, value => value.updatedAt, keep).map(actor => this.actorSnapshot(workspace, actor))
    const mailbox = recent(actorMessageEntries, value => value.updatedAt, keep)
    const totals = {
      topics: topicEntries.length,
      topicMessages: topicMessageEntries.length,
      states: stateEntries.length,
      actors: actorEntries.length,
      actorMessages: actorMessageEntries.length,
    }
    return detached({
      topics,
      topicMessages: messages,
      states,
      actors,
      actorMessages: mailbox,
      totals,
      truncated: topics.length < totals.topics
        || messages.length < totals.topicMessages
        || states.length < totals.states
        || actors.length < totals.actors
        || mailbox.length < totals.actorMessages,
    })
  }

  private topicIn(workspace: string, id: TopicId): FabricTopicRecord {
    assertText(id, 'topic id', MAX_IDENTIFIER_BYTES)
    return detached(this.requireTopic(workspace, id))
  }

  private actorIn(workspace: string, id: ActorId): FabricActorSnapshot {
    assertText(id, 'actor id', MAX_IDENTIFIER_BYTES)
    return detached(this.actorSnapshot(workspace, this.requireActor(workspace, id)))
  }

  private createTopicIn(workspace: string, label: string, id = FabricTopicId(randomUUID())): Promise<FabricTopicRecord> {
    assertText(label, 'topic label', MAX_LABEL_BYTES)
    assertText(id, 'topic id', MAX_IDENTIFIER_BYTES)
    return this.enqueue(async () => {
      const table = this.requireTopics()
      if (table.get(storageKey(workspace, id)) !== undefined) throw new FabricMeshError('already-exists', `topic ${JSON.stringify(id)} already exists`)
      const now = Date.now()
      const topic: FabricTopicRecord = { id, label, createdAt: now, updatedAt: now }
      await table.put(storageKey(workspace, id), topic)
      return detached(topic)
    })
  }

  private publishIn(workspace: string, topicId: TopicId, payload: FabricJsonValue): Promise<FabricTopicMessage> {
    assertText(topicId, 'topic id', MAX_IDENTIFIER_BYTES)
    const payloadSnapshot = detached(payload)
    return this.enqueue(async () => {
      this.requireTopic(workspace, topicId)
      const message: FabricTopicMessage = {
        id: FabricTopicMessageId(randomUUID()), topicId, payload: payloadSnapshot, publishedAt: Date.now(),
      }
      await this.requireTopicMessages().put(storageKey(workspace, message.id), message)
      return detached(message)
    })
  }

  private topicMessagesIn(workspace: string, topicId: TopicId, limit = 100): readonly FabricTopicMessage[] {
    assertText(topicId, 'topic id', MAX_IDENTIFIER_BYTES)
    this.requireTopic(workspace, topicId)
    return newest(scopedEntries(this.requireTopicMessages().entries(), workspace), message => message.topicId === topicId, limit)
  }

  private pruneTopicIn(workspace: string, topicId: TopicId, retain: number): Promise<{ deleted: number; retained: number }> {
    assertText(topicId, 'topic id', MAX_IDENTIFIER_BYTES)
    assertRetention(retain)
    return this.enqueue(async () => {
      this.requireTopic(workspace, topicId)
      const table = this.requireTopicMessages()
      const candidates = ordered(scopedEntries(table.entries(), workspace))
        .filter(message => message.topicId === topicId)
        .toSorted((left, right) => right.publishedAt - left.publishedAt || String(right.id).localeCompare(String(left.id)))
      const removed = candidates.slice(retain)
      for (const message of removed) await table.delete(storageKey(workspace, message.id))
      return { deleted: removed.length, retained: candidates.length - removed.length }
    })
  }

  private getStateIn(workspace: string, key: FabricStateKey): FabricStateRecord | undefined {
    assertText(key, 'state key', MAX_IDENTIFIER_BYTES)
    const value = this.requireStates().get(storageKey(workspace, key))
    return value === undefined ? undefined : detached(value)
  }

  private compareAndSwapIn(workspace: string, key: FabricStateKey, expectedVersion: number, value: FabricJsonValue): Promise<FabricStateRecord> {
    assertText(key, 'state key', MAX_IDENTIFIER_BYTES)
    const valueSnapshot = detached(value)
    return this.enqueue(async () => {
      const table = this.requireStates()
      const current = table.get(storageKey(workspace, key))
      const actual = current?.version ?? 0
      if (actual !== expectedVersion) {
        throw new FabricMeshError('version-conflict', `state ${JSON.stringify(key)} expected version ${expectedVersion}, current version is ${actual}`)
      }
      const next: FabricStateRecord = { key, version: actual + 1, value: valueSnapshot, updatedAt: Date.now() }
      if (current === undefined) await table.put(storageKey(workspace, key), next)
      else await table.update(storageKey(workspace, key), () => next)
      return detached(next)
    })
  }

  private createActorIn(workspace: string, label: string, id = FabricActorId(randomUUID())): Promise<FabricActorRecord> {
    assertText(label, 'actor label', MAX_LABEL_BYTES)
    assertText(id, 'actor id', MAX_IDENTIFIER_BYTES)
    return this.enqueue(async () => {
      const table = this.requireActors()
      if (table.get(storageKey(workspace, id)) !== undefined) throw new FabricMeshError('already-exists', `actor ${JSON.stringify(id)} already exists`)
      const now = Date.now()
      const actor: FabricActorRecord = { id, label, createdAt: now, updatedAt: now }
      await table.put(storageKey(workspace, id), actor)
      return detached(actor)
    })
  }

  private sendActorIn(workspace: string, actorId: ActorId, payload: FabricJsonValue): Promise<FabricActorMessage> {
    assertText(actorId, 'actor id', MAX_IDENTIFIER_BYTES)
    const payloadSnapshot = detached(payload)
    return this.enqueue(async () => {
      this.requireActor(workspace, actorId)
      const now = Date.now()
      const message: FabricActorMessage = {
        id: FabricActorMessageId(randomUUID()), actorId, payload: payloadSnapshot, status: 'queued', createdAt: now, updatedAt: now,
      }
      await this.requireActorMessages().put(storageKey(workspace, message.id), message)
      this.adjustActorCount(workspace, actorId, 'queued', 1)
      return detached(message)
    })
  }

  private actorMessagesIn(workspace: string, actorId: ActorId, limit = 100): readonly FabricActorMessage[] {
    assertText(actorId, 'actor id', MAX_IDENTIFIER_BYTES)
    this.requireActor(workspace, actorId)
    return newest(scopedEntries(this.requireActorMessages().entries(), workspace), message => message.actorId === actorId, limit)
  }

  private pruneActorIn(workspace: string, actorId: ActorId, retainTerminal: number): Promise<{ deleted: number; retained: number }> {
    assertText(actorId, 'actor id', MAX_IDENTIFIER_BYTES)
    assertRetention(retainTerminal)
    return this.enqueue(async () => {
      this.requireActor(workspace, actorId)
      const table = this.requireActorMessages()
      const terminal = this.messagesForActor(workspace, actorId)
        .filter(message => message.status === 'completed' || message.status === 'failed')
        .toSorted((left, right) => right.updatedAt - left.updatedAt || String(right.id).localeCompare(String(left.id)))
      const removed = terminal.slice(retainTerminal)
      for (const message of removed) {
        await table.delete(storageKey(workspace, message.id))
        if (message.status === 'failed') this.adjustActorCount(workspace, actorId, 'failed', -1)
      }
      return { deleted: removed.length, retained: terminal.length - removed.length }
    })
  }

  private claimActorIn(workspace: string, actorId: ActorId): Promise<FabricActorMessage | null> {
    assertText(actorId, 'actor id', MAX_IDENTIFIER_BYTES)
    return this.enqueue(async () => {
      this.requireActor(workspace, actorId)
      const candidate = this.messagesForActor(workspace, actorId)
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
      const stored = await this.requireActorMessages().update(storageKey(workspace, candidate.id), () => claimed)
      this.adjustActorCount(workspace, actorId, 'queued', -1)
      this.adjustActorCount(workspace, actorId, 'claimed', 1)
      return detached(stored)
    })
  }

  private settleActorIn(
    workspace: string,
    messageId: ActorMessageId,
    claimToken: FabricActorClaimToken,
    outcome: { result: FabricJsonValue } | { error: string },
  ): Promise<FabricActorMessage> {
    assertText(messageId, 'actor message id', MAX_IDENTIFIER_BYTES)
    assertText(claimToken, 'claim token', MAX_IDENTIFIER_BYTES)
    if ('error' in outcome) assertText(outcome.error, 'actor error', MAX_ERROR_BYTES)
    const outcomeSnapshot = detached(outcome)
    return this.enqueue(async () => {
      const table = this.requireActorMessages()
      const current = table.get(storageKey(workspace, messageId))
      if (current === undefined) throw new FabricMeshError('not-found', `actor message ${JSON.stringify(messageId)} does not exist`)
      if (current.claimToken !== claimToken) throw new FabricMeshError('claim-conflict', `actor message ${JSON.stringify(messageId)} is owned by another claim`)
      if (current.status === 'completed' || current.status === 'failed') return detached(current)
      if (current.status !== 'claimed') throw new FabricMeshError('invalid-state', `actor message ${JSON.stringify(messageId)} is not claimed`)
      const settled: FabricActorMessage = {
        id: current.id,
        actorId: current.actorId,
        payload: detached(current.payload),
        status: 'result' in outcomeSnapshot ? 'completed' : 'failed',
        createdAt: current.createdAt,
        updatedAt: Date.now(),
        claimToken,
        ...(current.claimedAt === undefined ? {} : { claimedAt: current.claimedAt }),
        ...'result' in outcomeSnapshot ? { result: outcomeSnapshot.result } : { error: outcomeSnapshot.error },
      }
      const stored = await table.update(storageKey(workspace, messageId), () => settled)
      this.adjustActorCount(workspace, current.actorId, 'claimed', -1)
      if (stored.status === 'failed') this.adjustActorCount(workspace, current.actorId, 'failed', 1)
      return detached(stored)
    })
  }
  private actorSnapshot(workspace: string, actor: FabricActorRecord): FabricActorSnapshot {
    const counts = this.actorCounts.get(actorCountKey(workspace, actor.id)) ?? { queued: 0, claimed: 0, failed: 0 }
    const status = counts.claimed > 0
      ? 'running' as const
      : counts.queued > 0
        ? 'pending' as const
        : counts.failed > 0
          ? 'failed' as const
          : 'idle' as const
    return { ...actor, status, queued: counts.queued, claimed: counts.claimed }
  }

  private adjustActorCount(workspace: string, actorId: ActorId, status: FabricActorMessage['status'], delta: number): void {
    if (status === 'completed') return
    const key = actorCountKey(workspace, actorId)
    const counts = this.actorCounts.get(key) ?? { queued: 0, claimed: 0, failed: 0 }
    const field = status === 'queued' ? 'queued' : status === 'claimed' ? 'claimed' : 'failed'
    counts[field] += delta
    if (counts[field] < 0) throw new Error('dsh-fabric mesh actor count underflow for ' + JSON.stringify(actorId) + ' (' + field + ')')
    this.actorCounts.set(key, counts)
  }

  private messagesForActor(workspace: string, actorId: ActorId): FabricActorMessage[] {
    return ordered(scopedEntries(this.requireActorMessages().entries(), workspace)).filter(message => message.actorId === actorId)
  }

  private requireTopic(workspace: string, id: TopicId): FabricTopicRecord {
    const value = this.requireTopics().get(storageKey(workspace, id))
    if (value === undefined) throw new FabricMeshError('not-found', 'topic ' + JSON.stringify(id) + ' does not exist')
    return value
  }

  private requireActor(workspace: string, id: ActorId): FabricActorRecord {
    const value = this.requireActors().get(storageKey(workspace, id))
    if (value === undefined) throw new FabricMeshError('not-found', 'actor ' + JSON.stringify(id) + ' does not exist')
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

const WORKSPACE_DIGEST_LENGTH = 32

function workspaceDigest(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, WORKSPACE_DIGEST_LENGTH)
}

function storageKey<T extends string>(workspace: string, id: T): T {
  return (workspace + ':' + id) as T
}

function workspaceFromStorageKey(key: string): string {
  const separator = key.indexOf(':')
  return separator === WORKSPACE_DIGEST_LENGTH ? key.slice(0, separator) : 'legacy'
}

function actorCountKey(workspace: string, actorId: ActorId): string {
  return workspace + ':' + actorId
}

function scopedEntries<K extends string, V>(entries: Iterable<[K, V]>, workspace: string): Array<[K, V]> {
  const prefix = workspace + ':'
  return [...entries].filter(([key]) => String(key).startsWith(prefix))
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`dsh-fabric mesh ${label} are unavailable before service initialization`)
  return value
}

function ordered<K extends string, V>(entries: Iterable<[K, V]>): V[] {
  return [...entries].map(([, value]) => value)
}

function newest<K extends string, V extends { publishedAt?: number; updatedAt?: number }>(
  entries: Iterable<[K, V]>,
  include: (value: V) => boolean,
  limit: number,
): V[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive safe integer')
  return recent(entries, value => value.publishedAt ?? value.updatedAt ?? 0, limit, include).toReversed()
}

function recent<K extends string, V>(
  entries: Iterable<[K, V]>,
  timestamp: (value: V) => number,
  limit: number | undefined,
  include: (value: V) => boolean = () => true,
): V[] {
  const selected: Array<[K, V]> = []
  for (const entry of entries) {
    if (!include(entry[1])) continue
    selected.push(entry)
    if (limit !== undefined && selected.length > limit) {
      selected.sort((left, right) => timestamp(left[1]) - timestamp(right[1]) || String(left[0]).localeCompare(String(right[0])))
      selected.shift()
    }
  }
  selected.sort((left, right) => timestamp(left[1]) - timestamp(right[1]) || String(left[0]).localeCompare(String(right[0])))
  return selected.map(([, value]) => detached(value))
}

function snapshotLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('snapshot limit must be a positive safe integer')
  return value
}

function assertRetention(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('mesh retention must be a non-negative safe integer')
}

function assertText(value: string, label: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (value.trim() === '' || bytes > maxBytes) {
    throw new TypeError(`dsh-fabric mesh ${label} must contain 1–${maxBytes} UTF-8 bytes`)
  }
}

function detached<T>(value: T): T {
  return structuredClone(value)
}

export default StorageFabricMesh
