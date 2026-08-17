import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@monotykamary/dsh-llm'
import { Session, SessionId } from '@monotykamary/dsh-session'
import { selectFabricCompactionSource } from '../src/source.ts'

describe('selectFabricCompactionSource', () => {
  it('falls back losslessly when selected message ids are detached', () => {
    const session = Session.create(SessionId('source-detached-only'))
    const detached = createUserMessage({
      content: [{ type: 'text', text: 'detached input' }],
      source: { kind: 'user' },
    })

    expect(selectFabricCompactionSource(session, [detached])).toEqual({
      messages: [detached],
      activityEvents: [],
    })
  })

  it('merges detached messages without discarding mapped source activity', () => {
    const session = Session.create(SessionId('source-partial-map'))
    session.append('turn/start', { turn: 1 })
    const mapped = createUserMessage({ content: [{ type: 'text', text: 'mapped' }], source: { kind: 'user' } })
    session.append('user/message', mapped, { surfaceOp: 'append' })
    const activity = session.append('tool/code-dispatch-start', {
      parentCallId: 'parent', subCallId: 'nested', name: 'read',
      arguments: { file_path: 'src/mapped.ts' }, startedAt: 1,
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const detached = createUserMessage({ content: [{ type: 'text', text: 'detached' }], source: { kind: 'user' } })

    const source = selectFabricCompactionSource(session, [mapped, detached])
    expect(source.messages).toEqual([mapped, detached])
    expect(source.activityEvents).toContainEqual(expect.objectContaining({
      type: 'tool/code-dispatch-start', seq: activity.seq,
    }))
    expect(source.lastTime).toBe(activity.time)
  })

  it('collects activity only from turns causally selected by source messages', () => {
    const session = Session.create(SessionId('source-turn-window'))
    const messages = [1, 2].map((turn) => {
      session.append('turn/start', { turn })
      const message = createUserMessage({
        content: [{ type: 'text', text: 'turn ' + turn }],
        source: { kind: 'user' },
      })
      session.append('user/message', message, { surfaceOp: 'append' })
      session.append('tool/code-dispatch-start', {
        parentCallId: 'parent-' + turn, subCallId: 'nested-' + turn, name: 'read',
        arguments: { file_path: 'src/turn-' + turn + '.ts' }, startedAt: turn,
      })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return message
    })

    const source = selectFabricCompactionSource(session, [messages[0]!])
    expect(source.messages).toEqual([messages[0]])
    expect(source.activityEvents).toHaveLength(1)
    expect(source.activityEvents[0]?.data).toMatchObject({ subCallId: 'nested-1' })
  })

  it('keeps durable activity when every selected message is detached', () => {
    const session = Session.create(SessionId('source-detached-activity'))
    session.append('tool/code-dispatch-start', {
      parentCallId: 'parent', subCallId: 'detached-read', name: 'read',
      arguments: { file_path: 'src/detached.ts' }, startedAt: 1,
    })
    const detached = createUserMessage({
      content: [{ type: 'text', text: 'detached selection' }],
      source: { kind: 'user' },
    })

    const source = selectFabricCompactionSource(session, [detached])
    expect(source.messages).toEqual([detached])
    expect(source.activityEvents).toContainEqual(expect.objectContaining({
      type: 'tool/code-dispatch-start', data: expect.objectContaining({ subCallId: 'detached-read' }),
    }))
  })

  it('widens workflow activity to the complete correlated lifecycle across turns', () => {
    const session = Session.create(SessionId('source-workflow-lifecycle'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'start workflow' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('tool-workflow/run-start', { runId: 'audit-run' as never, name: 'Audit' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    session.append('turn/start', { turn: 2 })
    const selected = createUserMessage({
      content: [{ type: 'text', text: 'finish workflow' }], source: { kind: 'user' },
    })
    session.append('user/message', selected, { surfaceOp: 'append' })
    session.append('tool-workflow/run-end', {
      runId: 'audit-run' as never, stopReason: 'completed', agentsStarted: 0,
    })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    expect(selectFabricCompactionSource(session, [selected]).activityEvents.map(event => event.type))
      .toEqual(['tool-workflow/run-start', 'tool-workflow/run-end'])
  })

  it('degrades explicitly instead of throwing when citation recovery reaches its cap', () => {
    const session = Session.create(SessionId('source-cap'))
    for (let index = 0; index < 3; index += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'original ' + index }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const nodes = [...session.surface.nodes]
    const replacement = createUserMessage({
      content: [{ type: 'text', text: 'bounded replacement' }], source: { kind: 'user' },
    })
    session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
      sourceEventSeqs: nodes,
    })

    const source = selectFabricCompactionSource(session, session.deriveMessages(), { maxSourceEvents: 2 })
    expect(source.sourceTruncated).toBe(true)
    expect(source.messages.length).toBeGreaterThan(0)
    expect(() => selectFabricCompactionSource(session, session.deriveMessages(), { maxSourceEvents: 0 }))
      .toThrow('positive safe integer')
  })

  it('relies on DSH rejecting forward provenance before a cycle can enter the source graph', () => {
    const session = Session.create(SessionId('source-invalid-citation'))
    const message = createUserMessage({
      content: [{ type: 'text', text: 'invalid provenance' }],
      source: { kind: 'user' },
    })

    expect(() => session.append('user/message', message, {
      surfaceOp: 'append',
      sourceEventSeqs: [999_999],
    })).toThrow('sourceEventSeqs must reference earlier events')
  })
})
