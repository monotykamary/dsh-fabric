import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, Session } from '@deepseek-ai/dsh-session'
import { appendFabricActivity } from '@dsh-fabric/host'
import type { FabricActivityEventData } from '@dsh-fabric/host'
import {
  FabricActorClaimToken,
  FabricActorId,
  FabricActorMessageId,
  FabricStateKey,
  FabricTopicId,
} from '@dsh-fabric/protocol'
import type { FabricJsonValue, FabricNodeStatus } from '@dsh-fabric/protocol'
import type {} from './index.ts'

/** Cordis plugin name. */
export const name = 'tool-dsh-fabric-mesh'
/** The tool registry and durable mesh service are both required. */
export const inject = ['tools', 'fabricMesh']

const ACTIONS = [
  'snapshot', 'create_topic', 'publish', 'read_topic', 'get_state', 'cas_state',
  'create_actor', 'send_actor', 'read_mailbox', 'claim_actor_message', 'settle_actor_message',
] as const

type Action = typeof ACTIONS[number]

/** Register the model-facing Fabric mesh Consumer. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'fabric_mesh',
    description: 'Use durable Fabric topics, compare-and-swap state, and actor mailboxes. Mutations are storage-backed and projected into the Fabric Activity and Topology views.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS },
      id: { type: 'string', description: 'Optional topic/actor id for create actions.' },
      label: { type: 'string', description: 'Topic or actor label.' },
      topic_id: { type: 'string', description: 'Topic id.' },
      actor_id: { type: 'string', description: 'Actor id.' },
      message_id: { type: 'string', description: 'Actor mailbox message id.' },
      claim_token: { type: 'string', description: 'Claim token returned by claim_actor_message.' },
      key: { type: 'string', description: 'CAS state key.' },
      expected_version: { type: 'integer', description: 'Expected CAS revision; 0 creates an absent value.' },
      payload: { type: 'json', description: 'Topic or actor message payload.' },
      value: { type: 'json', description: 'CAS replacement or successful actor result.' },
      error: { type: 'string', description: 'Actor failure detail for settle_actor_message.' },
      limit: { type: 'integer', description: 'Maximum messages returned by a read action.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      switch (args.action as Action) {
        case 'snapshot': return json(ctx.fabricMesh.snapshot())
        case 'create_topic': {
          const topic = await ctx.fabricMesh.createTopic(requiredText(args.label, 'label'), optionalTopicId(args.id))
          record(exec.agent?.session, {
            activity: activity(`topic:${topic.id}:created`, 'topic', 'created', topic.label, 'completed', topic.updatedAt, `topic:${topic.id}`),
            nodes: [{ id: `topic:${topic.id}`, kind: 'topic', label: topic.label, status: 'idle', updatedAt: topic.updatedAt }],
            edges: ownerEdge(exec.agent?.id, `topic:${topic.id}`, 'contains', topic.updatedAt),
          })
          return json(topic)
        }
        case 'publish': {
          const message = await ctx.fabricMesh.publish(FabricTopicId(requiredText(args.topic_id, 'topic_id')), requiredJson(args.payload, 'payload'))
          const messageNode = `message:${message.id}`
          record(exec.agent?.session, {
            activity: activity(`topic:${message.id}:published`, 'message', 'published', `Topic ${message.topicId}`, 'completed', message.publishedAt, messageNode),
            nodes: [
              { id: `topic:${message.topicId}`, kind: 'topic', label: String(message.topicId), status: 'idle', updatedAt: message.publishedAt },
              { id: messageNode, kind: 'message', label: `Message ${shortId(message.id)}`, status: 'completed', updatedAt: message.publishedAt },
            ],
            edges: [{ id: `publish:${message.id}`, source: `topic:${message.topicId}`, target: messageNode, kind: 'publish', updatedAt: message.publishedAt }],
          })
          return json(message)
        }
        case 'read_topic': return json(ctx.fabricMesh.topicMessages(FabricTopicId(requiredText(args.topic_id, 'topic_id')), resolveLimit(args.limit)))
        case 'get_state': return json(ctx.fabricMesh.getState(FabricStateKey(requiredText(args.key, 'key'))) ?? null)
        case 'cas_state': {
          const key = FabricStateKey(requiredText(args.key, 'key'))
          const state = await ctx.fabricMesh.compareAndSwap(key, requiredVersion(args.expected_version), requiredJson(args.value, 'value'))
          const nodeId = `state:${state.key}`
          record(exec.agent?.session, {
            activity: activity(`state:${state.key}:${state.version}`, 'state', 'compare-and-swap', String(state.key), 'completed', state.updatedAt, nodeId, `revision ${state.version}`),
            nodes: [{ id: nodeId, kind: 'state', label: String(state.key), status: 'completed', updatedAt: state.updatedAt, detail: `revision ${state.version}` }],
            edges: ownerEdge(exec.agent?.id, nodeId, 'state', state.updatedAt),
          })
          return json(state)
        }
        case 'create_actor': {
          const actor = await ctx.fabricMesh.createActor(requiredText(args.label, 'label'), optionalActorId(args.id))
          const nodeId = `actor:${actor.id}`
          record(exec.agent?.session, {
            activity: activity(`actor:${actor.id}:created`, 'actor', 'created', actor.label, 'completed', actor.updatedAt, nodeId),
            nodes: [{ id: nodeId, kind: 'actor', label: actor.label, status: 'idle', updatedAt: actor.updatedAt }],
            edges: ownerEdge(exec.agent?.id, nodeId, 'contains', actor.updatedAt),
          })
          return json(actor)
        }
        case 'send_actor': {
          const message = await ctx.fabricMesh.sendActor(FabricActorId(requiredText(args.actor_id, 'actor_id')), requiredJson(args.payload, 'payload'))
          recordActorMessage(exec.agent?.session, exec.agent?.id, message, 'pending', 'sent')
          return json(message)
        }
        case 'read_mailbox': return json(ctx.fabricMesh.actorMessages(FabricActorId(requiredText(args.actor_id, 'actor_id')), resolveLimit(args.limit)))
        case 'claim_actor_message': {
          const message = await ctx.fabricMesh.claimActor(FabricActorId(requiredText(args.actor_id, 'actor_id')))
          if (message !== null) recordActorMessage(exec.agent?.session, exec.agent?.id, message, 'running', 'claimed')
          return json(message)
        }
        case 'settle_actor_message': {
          const hasError = args.error !== undefined && args.error !== ''
          if (hasError === (args.value !== undefined)) throw new TypeError('settle_actor_message requires exactly one of value or error')
          const message = await ctx.fabricMesh.settleActor(
            FabricActorMessageId(requiredText(args.message_id, 'message_id')),
            FabricActorClaimToken(requiredText(args.claim_token, 'claim_token')),
            hasError ? { error: args.error as string } : { result: requiredJson(args.value, 'value') },
          )
          const failed = message.status === 'failed'
          recordActorMessage(exec.agent?.session, exec.agent?.id, message, failed ? 'failed' : 'completed', failed ? 'failed' : 'completed')
          return json(message)
        }
      }
    },
    presentCall: args => ({ card: 'generic', title: `Fabric mesh: ${String(args.action)}`, kind: readAction(args.action as Action) ? 'read' : 'other' }),
    isConcurrencySafe: args => readAction(args.action as Action),
  }))
}

function recordActorMessage(
  session: Parameters<typeof record>[0],
  sessionId: string | undefined,
  message: { id: string; actorId: string; updatedAt: number; status: string },
  status: FabricNodeStatus,
  actionName: string,
): void {
  const actorNode = `actor:${message.actorId}`
  const messageNode = `message:${message.id}`
  record(session, {
    activity: activity(`actor:${message.id}:${actionName}`, 'message', actionName, `Actor ${message.actorId}`, status, message.updatedAt, messageNode),
    nodes: [
      { id: actorNode, kind: 'actor', label: String(message.actorId), status: status === 'running' ? 'running' : status === 'pending' ? 'pending' : 'idle', updatedAt: message.updatedAt },
      { id: messageNode, kind: 'message', label: `Message ${shortId(message.id)}`, status, updatedAt: message.updatedAt },
    ],
    edges: [
      ...(sessionId === undefined ? [] : [{ id: `route:${message.id}`, source: '$session', target: actorNode, kind: 'route' as const, updatedAt: message.updatedAt }]),
      { id: `actor-message:${message.id}`, source: actorNode, target: messageNode, kind: 'message', updatedAt: message.updatedAt },
    ],
  })
}

function record(session: Session | undefined, data: FabricActivityEventData): void {
  if (session === undefined) throw new Error('fabric_mesh mutation requires a calling agent')
  appendFabricActivity(session, data)
}

function ownerEdge(sessionId: string | undefined, target: string, kind: 'contains' | 'state', updatedAt: number) {
  return sessionId === undefined ? [] : [{ id: `${kind}:${target}`, source: '$session', target, kind, updatedAt }]
}

function activity(
  id: string,
  kind: 'topic' | 'state' | 'actor' | 'message',
  action: string,
  label: string,
  status: FabricNodeStatus,
  updatedAt: number,
  nodeId: string,
  detail?: string,
) {
  return { id, kind, action, label, status, updatedAt, nodeId, ...(detail === undefined ? {} : { detail }) }
}

function json(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError('fabric_mesh produced a non-JSON value')
  return snapshot as JsonValue
}

function requiredText(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === '') throw new TypeError(`${field} is required for this action`)
  return value
}

function requiredJson(value: FabricJsonValue | undefined, field: string): FabricJsonValue {
  if (value === undefined) throw new TypeError(`${field} is required for this action`)
  return value
}

function requiredVersion(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('expected_version must be a non-negative safe integer')
  return value as number
}

function resolveLimit(value: number | undefined): number {
  if (value === undefined) return 100
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('limit must be a positive safe integer')
  return value
}

function optionalTopicId(value: string | undefined) { return value === undefined ? undefined : FabricTopicId(requiredText(value, 'id')) }
function optionalActorId(value: string | undefined) { return value === undefined ? undefined : FabricActorId(requiredText(value, 'id')) }
function shortId(value: string): string { return String(value).slice(0, 8) }
function readAction(action: Action): boolean { return action === 'snapshot' || action === 'read_topic' || action === 'get_state' || action === 'read_mailbox' }
