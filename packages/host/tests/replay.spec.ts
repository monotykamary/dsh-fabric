import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-compaction'
import * as HostPlugin from '../src/index.ts'
import type {} from '../src/types.ts'

function serializedEvents(): SessionEvent[] {
  return JSON.parse(JSON.stringify([
    {
      type: 'fabric/activity', seq: 0, time: 100,
      data: {
        activity: { id: 'state:goal:1', kind: 'state', action: 'compare-and-swap', label: 'goal', status: 'completed', updatedAt: 100 },
        nodes: [{ id: 'state:goal', kind: 'state', label: 'goal', status: 'completed', updatedAt: 100 }],
      },
    },
    { type: 'compaction/start', seq: 1, time: 101, data: { compactionId: 'cmp-replay', turn: null } },
    {
      type: 'compaction/summary', seq: 2, time: 102,
      data: {
        compactionId: 'cmp-replay', summary: [{ type: 'text', text: 'summary' }],
        shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 17,
        provider: 'test', model: 'test',
      },
    },
    { type: 'compaction/end', seq: 3, time: 103, data: { compactionId: 'cmp-replay', turn: null } },
  ])) as SessionEvent[]
}

describe('Fabric projection replay', () => {
  it('reconstructs durable Fabric and compaction views from a detached serialized log', async () => {
    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      fibers.push(await ctx.plugin(HostPlugin, { activityLimit: 20, topologyLimit: 20 }))
      const replay = Session.create(SessionId('fabric-replay'), serializedEvents())

      expect(ctx.sessionProjections.snapshot(replay)).toMatchObject({
        asOfSeq: 4,
        values: {
          fabricActivity: {
            nodes: expect.arrayContaining([
              expect.objectContaining({ id: 'state:goal', status: 'completed' }),
              expect.objectContaining({ id: 'compaction:cmp-replay', status: 'completed' }),
            ]),
          },
        },
      })

      const checkpoint = JSON.parse(JSON.stringify(ctx.sessionProjections.checkpoint(replay)))
      const restored = ctx.sessionProjections.restore(checkpoint, replay.events.slice(2), 2)
      expect(restored.snapshot).toEqual(ctx.sessionProjections.snapshot(replay))
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })
})
