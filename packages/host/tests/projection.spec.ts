import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createFabricActivityProjection } from '../src/projection.ts'
import type {} from '../src/types.ts'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type {} from '@deepseek-ai/dsh-compaction'

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
      expect.objectContaining({ kind: 'phase', label: 'inspect', status: 'completed' }),
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

  it('retains Fabric facts while projecting DSH compaction lifecycle', () => {
    const definition = createFabricActivityProjection(20, 20)
    let state = definition.init()
    state = definition.apply(state, event('fabric/activity', {
      activity: { id: 'actor:durable', kind: 'actor', action: 'created', label: 'Durable actor', status: 'completed', updatedAt: 1 },
      nodes: [{ id: 'actor:durable', kind: 'actor', label: 'Durable actor', status: 'idle' }],
    }, 0))
    state = definition.apply(state, event('compaction/start', { compactionId: 'cmp-1', turn: null }, 1))
    state = definition.apply(state, event('compaction/summary', {
      compactionId: 'cmp-1', summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 42,
      provider: 'test', model: 'test',
    }, 2))
    state = definition.apply(state, event('compaction/end', { compactionId: 'cmp-1', turn: null }, 3))

    const view = definition.view(state)
    expect(view.nodes).toContainEqual(expect.objectContaining({ id: 'actor:durable', status: 'idle' }))
    expect(view.nodes).toContainEqual(expect.objectContaining({
      id: 'compaction:cmp-1', kind: 'compaction', status: 'completed', detail: '42 tokens · seq 0–0',
    }))
    expect(view.activities.slice(-3).map(activity => activity.action)).toEqual(['started', 'summarized', 'completed'])
  })

  it('settles an evicted workflow member from private correlation state', () => {
    const definition = createFabricActivityProjection(20, 2)
    let state = definition.init()
    state = definition.apply(state, event('tool-workflow/run-start', { runId: 'run-tight', name: 'Tight run' }, 0))
    state = definition.apply(state, event('tool-workflow/agent-start', {
      runId: 'run-tight', childId: 'child-tight', seq: 0, label: 'Builder', phase: 'build',
    }, 1))
    state = definition.apply(state, event('fabric/activity', {
      activity: { id: 'noise', kind: 'mesh', action: 'updated', label: 'Noise', status: 'completed', updatedAt: 3 },
      nodes: [
        { id: 'noise:1', kind: 'component', label: 'Noise 1', status: 'idle' },
        { id: 'noise:2', kind: 'component', label: 'Noise 2', status: 'idle' },
      ],
    }, 2))
    state = definition.apply(state, event('tool-workflow/agent-end', {
      runId: 'run-tight', childId: 'child-tight', seq: 0, outcome: 'completed',
    }, 3))

    expect(definition.view(state).nodes).toContainEqual(expect.objectContaining({
      id: 'session:child-tight', label: 'Builder', status: 'completed',
    }))
  })

})
