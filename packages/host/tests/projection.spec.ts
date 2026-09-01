import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage } from '@monotykamary/dsh-llm'
import type { SessionEvent } from '@monotykamary/dsh-session'
import { createFabricActivityProjection } from '../src/projection.ts'
import type {} from '../src/types.ts'
import type {} from '@monotykamary/dsh-tool-workflow/types'
import type {} from '@monotykamary/dsh-compaction'

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

  it('projects run_code display metadata from native call through settlement', () => {
    const definition = createFabricActivityProjection(20, 20)
    const callId = CallId('displayed-run')
    let state = definition.init()
    state = definition.apply(state, event('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'run_code',
      arguments: JSON.stringify({
        code: 'return 1',
        display: { name: 'Verify release', description: 'Confirm artifacts before publishing.' },
      }),
    }, 0))

    expect(definition.wire.view(state).activities).toEqual([expect.objectContaining({
      id: 'execution:displayed-run',
      kind: 'execution',
      action: 'started',
      label: 'Verify release',
      detail: 'Confirm artifacts before publishing.',
      status: 'running',
    })])
    expect(Object.keys(state.codeRuns)).toEqual(['call:displayed-run'])

    state = definition.apply(state, event('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      }),
    }, 1))

    expect(definition.wire.view(state).activities).toEqual([expect.objectContaining({
      id: 'execution:displayed-run',
      action: 'completed',
      label: 'Verify release',
      detail: 'Confirm artifacts before publishing.',
      status: 'completed',
    })])
    expect(state.codeRuns).toEqual({})

    const failedId = CallId('failed-run')
    state = definition.apply(state, event('tool/call', {
      turn: 1, step: 2, callId: failedId, name: 'run_code',
      arguments: JSON.stringify({ code: 'return 2', display: 'Run focused tests' }),
    }, 2))
    state = definition.apply(state, event('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: failedId, content: [{ type: 'text', text: 'failed' }], isError: true }),
    }, 3))
    expect(definition.wire.view(state).activities.at(-1)).toMatchObject({
      kind: 'execution', action: 'failed', label: 'Run focused tests', status: 'failed',
    })

    const unchanged = definition.apply(state, event('tool/call', {
      turn: 1, step: 3, callId: CallId('malformed'), name: 'run_code', arguments: '{',
    }, 4))
    expect(unchanged).toBe(state)
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

    const view = definition.wire.view(state)
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

    expect(definition.wire.view(state).nodes).toContainEqual(expect.objectContaining({
      id: 'session:child-tight', label: 'Builder', status: 'completed',
    }))
  })

  it('bounds record bytes while preserving normalized edge and activity references', () => {
    const definition = createFabricActivityProjection(5, 5)
    const hugeId = 'node:'.concat('x'.repeat(4_000))
    const hugeText = 'y'.repeat(10_000)
    let state = definition.init()
    state = definition.apply(state, event('fabric/activity', {
      activity: { id: hugeId, kind: 'mesh', action: hugeText, label: hugeText, detail: hugeText, status: 'completed', updatedAt: 1, nodeId: hugeId },
      nodes: [{ id: hugeId, kind: 'state', label: hugeText, detail: hugeText, status: 'completed', updatedAt: 1 }],
      edges: [{ id: `edge:${hugeId}`, source: '$session', target: hugeId, kind: 'state', updatedAt: 1 }],
    }, 0))

    const view = definition.wire.view(state)
    expect(view.activities[0]?.id.length).toBeLessThanOrEqual(512)
    expect(view.activities[0]?.action.length).toBeLessThanOrEqual(256)
    expect(view.activities[0]?.label.length).toBeLessThanOrEqual(2048)
    expect(view.activities[0]?.detail?.length).toBeLessThanOrEqual(4096)
    expect(view.activities[0]?.nodeId).toBe(view.nodes[0]?.id)
    expect(view.edges[0]?.target).toBe(view.nodes[0]?.id)
    expect(view.nodes[0]?.id).toMatch(/#[0-9a-f]{16}$/)
  })

  it('bounds abandoned private workflow correlations by topology limit', () => {
    const definition = createFabricActivityProjection(10, 2)
    let state = definition.init()
    for (let index = 0; index < 5; index += 1) {
      state = definition.apply(state, event('tool-workflow/agent-start', {
        runId: `run-${index}`, childId: `child-${index}`, seq: index, label: `Agent ${index}`,
      }, index))
    }

    expect(Object.keys(state.workflowMembers)).toHaveLength(2)
  })

})
