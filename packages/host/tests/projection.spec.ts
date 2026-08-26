import { describe, expect, it } from 'vitest'
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

  it('projects the latest durable provider and model route', () => {
    const definition = createFabricActivityProjection()
    let state = definition.init()
    state = definition.apply(state, event('request/header', {
      reason: 'initial', header: { config: { provider: 'cursor', model: 'composer-2.5-fast' } },
    }, 1))
    state = definition.apply(state, event('request/context', {
      provider: 'cursor', model: 'claude-fable-5',
    }, 2))
    expect(definition.wire.view(state).route).toEqual({ provider: 'cursor', model: 'claude-fable-5' })
  })

  it('replays parallel delegations with out-of-order child completion', () => {
    const definition = createFabricActivityProjection()
    let state = definition.init()
    state = definition.apply(state, event('tool/call', {
      callId: 'call-1', name: 'delegate', arguments: JSON.stringify({
        label: 'parallel review', parallel: true, max_parallel: 2,
        tasks: [
          { label: 'slow', task: 'slow task', tier: 'cheap' },
          { label: 'fast', task: 'fast task', tier: 'default' },
        ],
      }),
    }, 1))
    state = definition.apply(state, event('tool-workflow/run-start', { runId: 'run-1', name: 'fabric-delegate/call-1/0' }, 2))
    state = definition.apply(state, event('tool-workflow/agent-start', { runId: 'run-1', seq: 1, label: 'slow', childId: 'child-slow' }, 3))
    state = definition.apply(state, event('tool-workflow/agent-start', { runId: 'run-1', seq: 2, label: 'fast', childId: 'child-fast' }, 4))
    state = definition.apply(state, event('tool-workflow/agent-end', { runId: 'run-1', seq: 2, outcome: 'completed' }, 5))
    state = definition.apply(state, event('tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'failed' }, 6))

    expect(state.delegations).toEqual([expect.objectContaining({
      callId: 'call-1', status: 'running', parallel: true, maxParallel: 2,
      workers: [
        expect.objectContaining({ index: 0, status: 'failed', childSessionId: 'child-slow' }),
        expect.objectContaining({ index: 1, status: 'completed', childSessionId: 'child-fast' }),
      ],
    })])
  })

  it('replays observed worker routes from nested delegate dispatch results', () => {
    const definition = createFabricActivityProjection()
    let state = definition.init()
    state = definition.apply(state, event('tool/code-dispatch-start', {
      rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'delegate',
      arguments: { label: 'route audit', tasks: [{ label: 'reviewer', task: 'inspect', tier: 'cheap' }] },
      location: { turn: 1, step: 1 },
    }, 1))
    state = definition.apply(state, event('tool/code-dispatch', {
      rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'delegate', arguments: {},
      isError: false, location: { turn: 1, step: 1 }, content: [{ type: 'text', text: JSON.stringify({
        delegationId: 'root:code:1', label: 'route audit', status: 'completed',
        workers: [{
          index: 0, label: 'reviewer', task: 'inspect', tier: 'cheap', outcome: 'completed', output: 'done',
          childId: 'child-route', actual: { provider: 'codex-oauth', model: 'gpt-5.6-sol' }, routingVerified: true,
        }],
      }) }],
    }, 2))

    expect(definition.wire.view(state).delegations[0]).toMatchObject({
      status: 'completed',
      workers: [{
        childSessionId: 'child-route', actualProvider: 'codex-oauth', actualModel: 'gpt-5.6-sol', routingVerified: true,
      }],
    })
  })

  it('settles cancellation and failure while interrupted runs remain visibly running', () => {
    const definition = createFabricActivityProjection()
    const start = (callId: string, seq: number) => event('tool/call', {
      callId, name: 'delegate', arguments: JSON.stringify({ tasks: [{ label: callId, task: 'task' }] }),
    }, seq)

    let cancelled = definition.apply(definition.init(), start('cancelled', 1))
    cancelled = definition.apply(cancelled, event('tool-workflow/run-start', { runId: 'run-c', name: 'fabric-delegate/cancelled/0' }, 2))
    cancelled = definition.apply(cancelled, event('tool-workflow/agent-start', { runId: 'run-c', seq: 1, label: 'c', childId: 'child-c' }, 3))
    cancelled = definition.apply(cancelled, event('tool-workflow/run-end', { runId: 'run-c', stopReason: 'cancelled' }, 4))
    expect(cancelled.delegations[0]).toMatchObject({ status: 'stopped', workers: [{ status: 'stopped' }] })

    let failed = definition.apply(definition.init(), start('failed', 10))
    failed = definition.apply(failed, event('tool/result', {
      message: { source: { callId: 'failed' }, content: [{ type: 'tool-result', isError: true }] },
    }, 11))
    expect(failed.delegations[0]).toMatchObject({ status: 'failed', workers: [{ status: 'failed' }] })

    let interrupted = definition.apply(definition.init(), start('interrupted', 20))
    interrupted = definition.apply(interrupted, event('tool-workflow/run-start', { runId: 'run-i', name: 'fabric-delegate/interrupted/0' }, 21))
    interrupted = definition.apply(interrupted, event('tool-workflow/agent-start', { runId: 'run-i', seq: 1, label: 'i', childId: 'child-i' }, 22))
    expect(definition.wire.view(interrupted).delegations[0]).toMatchObject({ status: 'running', workers: [{ status: 'running' }] })
  })

  it('retains queued workers when a terminal result contains only started batches', () => {
    const definition = createFabricActivityProjection()
    let state = definition.init()
    state = definition.apply(state, event('tool/call', {
      callId: 'budgeted', name: 'delegate', arguments: JSON.stringify({
        tasks: [
          { label: 'first', task: 'first task' },
          { label: 'second', task: 'second task' },
          { label: 'third', task: 'third task' },
        ],
      }),
    }, 1))
    state = definition.apply(state, event('tool/result', {
      message: { source: { callId: 'budgeted' }, content: [{ type: 'tool-result', isError: false }] },
      meta: { kind: 'fabric-delegation', result: {
        delegationId: 'budgeted', status: 'budget-exhausted', label: 'Budgeted', totalTokens: 10,
        workers: [{ index: 0, label: 'first', task: 'first task', tier: 'cheap', outcome: 'completed', output: 'done' }],
      } },
    }, 2))

    expect(state.delegations[0]).toMatchObject({
      status: 'stopped',
      workers: [
        { index: 0, status: 'completed' },
        { index: 1, status: 'stopped' },
        { index: 2, status: 'stopped' },
      ],
    })
  })

  it('bounds abandoned delegation run correlations', () => {
    const definition = createFabricActivityProjection(200, 200)
    let state = definition.init()
    for (let index = 0; index < 100; index += 1) {
      state = definition.apply(state, event('tool-workflow/run-start', {
        runId: `run-${index}`, name: `fabric-delegate/call-${index}/0`,
      }, index))
    }
    expect(Object.keys(state.delegationRuns)).toHaveLength(80)
    expect(state.delegationRuns['run-0']).toBeUndefined()
    expect(state.delegationRuns['run-99']).toBeDefined()
  })

})
