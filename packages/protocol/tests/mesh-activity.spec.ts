import { describe, expect, it } from 'vitest'
import {
  FABRIC_MESH_RESULT_META_KIND,
  FABRIC_MESH_RESULT_META_VERSION,
  fabricMeshResultMeta,
  projectFabricMeshActivity,
  readFabricMeshResultMeta,
} from '../src/index.ts'
import type { FabricJsonValue } from '../src/index.ts'

describe('Fabric mesh native tool-result metadata', () => {
  it('maps every mutating mesh action into stable activity and topology facts', () => {
    const cases: Array<{
      args: Record<string, unknown>
      result: FabricJsonValue
      action: string
      kind: string
      status: string
      at: number
      actorStatus?: string
    }> = [
      { args: { action: 'create_topic' }, result: { id: 'events', label: 'Events', createdAt: 11, updatedAt: 11 }, action: 'created', kind: 'topic', status: 'completed', at: 11 },
      { args: { action: 'publish', topic_id: 'events' }, result: { id: 'message-123456789', topicId: 'events', publishedAt: 12 }, action: 'published', kind: 'message', status: 'completed', at: 12 },
      { args: { action: 'prune_topic', topic_id: 'events' }, result: { deleted: 3, retained: 2 }, action: 'pruned', kind: 'topic', status: 'completed', at: 99 },
      { args: { action: 'cas_state', key: 'world' }, result: { key: 'world', version: 2, value: null, updatedAt: 14 }, action: 'compare-and-swap', kind: 'state', status: 'completed', at: 14 },
      { args: { action: 'create_actor' }, result: { id: 'builder', label: 'Builder', createdAt: 15, updatedAt: 15 }, action: 'created', kind: 'actor', status: 'completed', at: 15 },
      { args: { action: 'send_actor' }, result: actorMessage('queued', 16), action: 'sent', kind: 'message', status: 'pending', at: 16, actorStatus: 'pending' },
      { args: { action: 'claim_actor_message' }, result: actorMessage('claimed', 17), action: 'claimed', kind: 'message', status: 'running', at: 17, actorStatus: 'running' },
      { args: { action: 'settle_actor_message' }, result: actorMessage('completed', 18), action: 'completed', kind: 'message', status: 'completed', at: 18, actorStatus: 'idle' },
      { args: { action: 'settle_actor_message' }, result: actorMessage('failed', 19), action: 'failed', kind: 'message', status: 'failed', at: 19, actorStatus: 'failed' },
      { args: { action: 'prune_mailbox', actor_id: 'builder' }, result: { deleted: 4, retained: 1 }, action: 'pruned', kind: 'actor', status: 'completed', at: 99 },
    ]

    for (const item of cases) {
      const projected = projectFabricMeshActivity(item.args, item.result, 99)
      expect(projected?.activity).toMatchObject({
        action: item.action,
        kind: item.kind,
        status: item.status,
        updatedAt: item.at,
      })
      if (item.actorStatus !== undefined) {
        expect(projected?.nodes?.find(node => node.kind === 'actor')?.status).toBe(item.actorStatus)
      }
      const meta = fabricMeshResultMeta(item.args, item.result, 99)
      expect(readFabricMeshResultMeta(meta)).toEqual(projected)
    }
  })

  it('omits non-mutating, unknown, incomplete, and empty-claim results', () => {
    expect(projectFabricMeshActivity({ action: 'snapshot' }, {}, 1)).toBeUndefined()
    expect(projectFabricMeshActivity({ action: 'future_action' }, {}, 1)).toBeUndefined()
    expect(projectFabricMeshActivity({ action: 'create_topic' }, { label: 'missing id' }, 1)).toBeUndefined()
    expect(projectFabricMeshActivity({ action: 'claim_actor_message' }, null, 1)).toBeUndefined()
    expect(fabricMeshResultMeta({ action: 'snapshot' }, {}, 1)).toEqual({
      kind: FABRIC_MESH_RESULT_META_KIND,
      version: FABRIC_MESH_RESULT_META_VERSION,
    })
  })

  it('rejects malformed persisted metadata at the native event boundary', () => {
    const valid = fabricMeshResultMeta(
      { action: 'create_actor' },
      { id: 'builder', label: 'Builder', createdAt: 10, updatedAt: 10 },
      10,
    )
    expect(readFabricMeshResultMeta(valid)).toBeDefined()

    const malformed = [
      null,
      { ...valid, kind: 'other' },
      { ...valid, version: 2 },
      { ...valid, activity: { ...valid.activity, activity: { ...valid.activity?.activity, kind: 'unknown' } } },
      { ...valid, activity: { ...valid.activity, activity: { ...valid.activity?.activity, status: 'unknown' } } },
      { ...valid, activity: { ...valid.activity, nodes: [{ id: 'x', kind: 'unknown', label: '', status: 'idle' }] } },
      { ...valid, activity: { ...valid.activity, edges: [{ id: 'x', source: '', target: '', kind: 'unknown' }] } },
      { ...valid, activity: { ...valid.activity, activity: { ...valid.activity?.activity, updatedAt: Number.NaN } } },
    ]
    for (const value of malformed) expect(readFabricMeshResultMeta(value)).toBeUndefined()
  })

  it('uses durable timestamps before the deterministic fallback', () => {
    expect(projectFabricMeshActivity(
      { action: 'create_topic' },
      { id: 'events', label: 'Events', createdAt: 1, updatedAt: 2 },
      99,
    )?.activity.updatedAt).toBe(2)
    expect(projectFabricMeshActivity(
      { action: 'prune_topic', topic_id: 'events' },
      { deleted: 1, retained: 0 },
      99,
    )?.activity.updatedAt).toBe(99)
  })
})

function actorMessage(status: string, updatedAt: number): FabricJsonValue {
  return {
    id: 'message-123456789',
    actorId: 'builder',
    payload: { task: 'compile' },
    status,
    createdAt: 1,
    updatedAt,
  }
}
