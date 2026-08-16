import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createFabricActivityProjection } from '../src/projection.ts'
import type {} from '../src/types.ts'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'

function event(type: SessionEvent['type'], data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: 100 + seq } as SessionEvent
}

describe('fabric activity projection', () => {
  it('folds durable workflow runs, phases, members, and settlement', () => {
    const definition = createFabricActivityProjection()
    let state = definition.init()
    const runId = 'run-1'
    state = definition.apply(state, event('tool-workflow/run-start', { runId, name: 'audit' }, 0))
    state = definition.apply(state, event('tool-workflow/agent-start', {
      runId, seq: 1, label: 'reviewer', phase: 'inspect', childId: 'child-1',
    }, 1))
    state = definition.apply(state, event('tool-workflow/agent-end', { runId, seq: 1, outcome: 'completed' }, 2))
    state = definition.apply(state, event('tool-workflow/run-end', { runId, stopReason: 'completed' }, 3))

    expect(state.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'workflow:run-1', status: 'completed' }),
      expect.objectContaining({ id: 'session:child-1', status: 'completed' }),
      expect.objectContaining({ kind: 'phase', label: 'inspect' }),
    ]))
    expect(state.edges.map(edge => edge.kind)).toEqual(expect.arrayContaining(['contains', 'member']))
    expect(state.activities).toHaveLength(4)
  })

  it('bounds custom activity and upserts topology records', () => {
    const definition = createFabricActivityProjection(2, 2)
    let state = definition.init()
    for (let index = 0; index < 3; index += 1) {
      state = definition.apply(state, event('fabric/activity', {
        activity: { id: `a${index}`, kind: 'mesh', action: 'write', label: `A${index}`, status: 'completed', updatedAt: index, nodeId: 'state:key' },
        nodes: [{ id: 'state:key', kind: 'state', label: 'key', status: 'completed', updatedAt: index }],
      }, index))
    }

    expect(state.activities.map(item => item.id)).toEqual(['a1', 'a2'])
    expect(state.nodes).toEqual([expect.objectContaining({ id: 'state:key', updatedAt: 2 })])
  })
})
