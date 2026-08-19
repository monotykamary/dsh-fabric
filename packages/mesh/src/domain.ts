import { z } from 'zod'
import { defineDomain, domainTable } from '@monotykamary/dsh-storage-domain'
import type {
  FabricActorId,
  FabricActorMessage,
  FabricActorMessageId,
  FabricActorRecord,
  FabricJsonValue,
  FabricStateKey,
  FabricStateRecord,
  FabricTopicId,
  FabricTopicMessage,
  FabricTopicMessageId,
  FabricTopicRecord,
} from 'dsh-fabric-protocol'

const jsonSchema: z.ZodType<FabricJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]))

const topicSchema = z.object({
  id: z.string(), label: z.string(), createdAt: z.number(), updatedAt: z.number(),
}) as unknown as z.ZodType<FabricTopicRecord>
const topicMessageSchema = z.object({
  id: z.string(), topicId: z.string(), payload: jsonSchema, publishedAt: z.number(),
}) as unknown as z.ZodType<FabricTopicMessage>
const stateSchema = z.object({
  key: z.string(), version: z.number().int().min(1), value: jsonSchema, updatedAt: z.number(),
}) as unknown as z.ZodType<FabricStateRecord>
const actorSchema = z.object({
  id: z.string(), label: z.string(), createdAt: z.number(), updatedAt: z.number(),
}) as unknown as z.ZodType<FabricActorRecord>
const actorMessageSchema = z.object({
  id: z.string(), actorId: z.string(), payload: jsonSchema,
  status: z.enum(['queued', 'claimed', 'completed', 'failed']),
  createdAt: z.number(), updatedAt: z.number(), claimToken: z.string().optional(), claimedAt: z.number().optional(),
  result: jsonSchema.optional(), error: z.string().optional(),
}) as unknown as z.ZodType<FabricActorMessage>

/** Durable storage-domain declaration for all mesh-owned state. */
export const fabricMeshDomainSpec = defineDomain({
  name: 'dsh_fabric_mesh',
  version: 1,
  tables: {
    topics: domainTable<FabricTopicId, FabricTopicRecord>(topicSchema),
    topic_messages: domainTable<FabricTopicMessageId, FabricTopicMessage>(topicMessageSchema),
    states: domainTable<FabricStateKey, FabricStateRecord>(stateSchema),
    actors: domainTable<FabricActorId, FabricActorRecord>(actorSchema),
    actor_messages: domainTable<FabricActorMessageId, FabricActorMessage>(actorMessageSchema),
  },
})
