import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@monotykamary/dsh-llm'
import { Session, SessionId } from '@monotykamary/dsh-session'
import { compactCheckpointSource } from '@monotykamary/dsh-compaction'
import { fabricMeshResultMeta } from 'dsh-fabric-protocol'
import {
  compileFabricSummary,
  FABRIC_COMPACTION_MODEL,
  FABRIC_COMPACTION_PROVIDER,
  readLatestFabricSnapshot,
} from '../src/compiler.ts'
import { selectFabricCompactionSource } from '../src/source.ts'

const GOAL = 'Build the Fabric compaction adapter while preserving exact paths and failures. '.repeat(80)

function sourceMessages() {
  const edit = CallId('edit-1')
  const bash = CallId('bash-1')
  return [
    createUserMessage({ content: [{ type: 'text', text: GOAL }], source: { kind: 'user' } }),
    createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'PRIVATE_REASONING_MUST_NOT_SURVIVE' },
        { type: 'text', text: 'I will update the provider and verify it.' },
        { type: 'tool-call', id: edit, name: 'edit', arguments: '{"path":"src/main.ts"}' },
      ],
      source: { provider: 'test', model: 'test' },
    }),
    createToolResultMessage({ callId: edit, content: [{ type: 'text', text: 'updated src/main.ts' }], isError: false }),
    createAssistantMessage({
      content: [{ type: 'tool-call', id: bash, name: 'bash', arguments: '{"command":"pnpm test"}' }],
      source: { provider: 'test', model: 'test' },
    }),
    createToolResultMessage({ callId: bash, content: [{ type: 'text', text: 'tests failed at assertion 7' }], isError: true }),
  ]
}

describe('compileFabricSummary', () => {
  it('renders deterministic graded context from typed DSH messages', () => {
    const messages = sourceMessages()
    const options = { lastTimestamp: '2026-08-16T00:00:00.000Z' }
    const first = compileFabricSummary(messages, options)
    const second = compileFabricSummary(messages, options)

    expect(first).toEqual(second)
    expect(first.summary).toContain('[Session Goal]')
    expect(first.summary).toContain('[Files And Changes]')
    expect(first.summary).toContain('src/main.ts')
    expect(first.summary).toContain('[Outstanding Context]')
    expect(first.summary).toContain('pnpm test')
    expect(first.summary).not.toContain('PRIVATE_REASONING_MUST_NOT_SURVIVE')
    expect(first.snapshot.reasoningBlocks).toBe(1)
    expect(first.rawOutput[1]?.type).toBe('text')
  })

  it('reports bounded source recovery without failing compaction', () => {
    const compiled = compileFabricSummary(sourceMessages(), {
      lastTimestamp: 'bounded-source',
      sourceTruncated: true,
    })
    expect(compiled.summary).toContain('Source recovery reached its event safety cap')
  })

  it('projects durable Fabric and workflow activity into the typed summary', () => {
    const compiled = compileFabricSummary(sourceMessages(), {
      lastTimestamp: 'activity',
      activityEvents: [
        {
          type: 'tool/result', seq: 10, time: 10,
          data: {
            meta: fabricMeshResultMeta(
              { action: 'create_actor', id: 'builder', label: 'Builder' },
              { id: 'builder', label: 'Builder', createdAt: 10, updatedAt: 10 },
              10,
            ),
          },
        },
        { type: 'tool-workflow/run-start', seq: 11, time: 11, data: { runId: 'audit', name: 'Audit workspace' } },
        { type: 'tool-workflow/agent-start', seq: 12, time: 12, data: { runId: 'audit', seq: 0, label: 'Reviewer', phase: 'inspect' } },
        { type: 'tool-workflow/agent-end', seq: 13, time: 13, data: { runId: 'audit', seq: 0, outcome: 'completed' } },
        { type: 'tool-workflow/run-end', seq: 14, time: 14, data: { runId: 'audit', stopReason: 'completed' } },
      ],
    })

    expect(compiled.summary).toContain('[Fabric Activity]')
    expect(compiled.summary).toContain('fabric.actor.created')
    expect(compiled.summary).toContain('Audit workspace')
    expect(compiled.snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'fabricOperation', ref: 'fabric.actor.created' }),
      expect.objectContaining({ kind: 'fabricRun', name: 'Audit workspace', outcome: 'succeeded' }),
    ]))
  })

  it('projects declared and inferred run_code titles from recorded arguments', () => {
    const inferredId = CallId('run-inferred')
    const declaredId = CallId('run-declared')
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: GOAL }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: inferredId,
          name: 'run_code',
          arguments: JSON.stringify({
            code: 'return await tools.bash({ command: "pnpm pack", description: "Inspect packed release" })',
          }),
        }],
        source: { provider: 'test', model: 'test' },
      }),
      createToolResultMessage({ callId: inferredId, content: [{ type: 'text', text: 'packed' }], isError: false }),
      createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: declaredId,
          name: 'run_code',
          arguments: JSON.stringify({ code: 'return 1', description: 'Use the declared title' }),
        }],
        source: { provider: 'test', model: 'test' },
      }),
      createToolResultMessage({ callId: declaredId, content: [{ type: 'text', text: 'failed' }], isError: true }),
    ]

    const compiled = compileFabricSummary(messages, { lastTimestamp: 'run-titles' })

    expect(compiled.summary).toContain('Inspect packed release → succeeded')
    expect(compiled.summary).toContain('Use the declared title → failed')
    expect(compiled.summary).not.toContain('run_code(structured execution)')
    expect(compiled.snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'fabricRun', toolCallId: 'run-inferred', name: 'Inspect packed release', outcome: 'succeeded' }),
      expect.objectContaining({ kind: 'fabricRun', toolCallId: 'run-declared', name: 'Use the declared title', outcome: 'failed' }),
    ]))
  })

  it('projects native Code Mode sub-dispatches into files, failures, and transcript', () => {
    const content = (value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
    const activityEvents = [
      { type: 'tool/code-dispatch-start', seq: 20, time: 20, data: { subCallId: 'nested-read', name: 'read', arguments: { file_path: 'src/input.ts' } } },
      { type: 'tool/code-dispatch', seq: 21, time: 21, data: { subCallId: 'nested-read', name: 'read', arguments: { file_path: 'src/input.ts' }, isError: false, content: content({ path: 'src/input.ts' }) } },
      { type: 'tool/code-dispatch-start', seq: 22, time: 22, data: { subCallId: 'nested-write', name: 'write', arguments: { file_path: 'src/created.ts', content: 'export {}' } } },
      { type: 'tool/code-dispatch', seq: 23, time: 23, data: { subCallId: 'nested-write', name: 'write', arguments: { file_path: 'src/created.ts', content: 'export {}' }, isError: false, content: content({ path: 'src/created.ts', operation: 'create' }) } },
      { type: 'tool/code-dispatch-start', seq: 24, time: 24, data: { subCallId: 'nested-edit', name: 'edit', arguments: { file_path: 'src/modified.ts', old_string: 'a', new_string: 'b' } } },
      { type: 'tool/code-dispatch', seq: 25, time: 25, data: { subCallId: 'nested-edit', name: 'edit', arguments: { file_path: 'src/modified.ts', old_string: 'a', new_string: 'b' }, isError: false, content: content({ path: 'src/modified.ts' }) } },
      { type: 'tool/code-dispatch-start', seq: 26, time: 26, data: { subCallId: 'nested-grep', name: 'grep', arguments: { path: 'src/missing.ts', pattern: 'needle' } } },
      { type: 'tool/code-dispatch', seq: 27, time: 27, data: { subCallId: 'nested-grep', name: 'grep', arguments: { path: 'src/missing.ts', pattern: 'needle' }, isError: true, content: content('file does not exist') } },
    ]
    const compiled = compileFabricSummary(sourceMessages(), { lastTimestamp: 'code-mode', activityEvents })

    expect(compiled.summary).toContain('[Files And Changes]')
    expect(compiled.summary).toContain('Created:')
    expect(compiled.summary).toContain('created.ts')
    expect(compiled.summary).toContain('Modified:')
    expect(compiled.summary).toContain('modified.ts')
    expect(compiled.summary).toContain('Read:')
    expect(compiled.summary).toContain('input.ts')
    expect(compiled.summary).toContain('[Outstanding Context]')
    expect(compiled.summary).toContain('grep src/missing.ts: file does not exist')
    expect(compiled.snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'toolCall', toolCallId: 'nested-write', name: 'write' }),
      expect.objectContaining({ kind: 'toolResult', toolCallId: 'nested-write', toolName: 'write', isError: false }),
      expect.objectContaining({ kind: 'toolResult', toolCallId: 'nested-grep', toolName: 'grep', isError: true }),
    ]))
  })

  it('rehydrates validated typed facts rather than prior summary prose', () => {
    const first = compileFabricSummary(sourceMessages(), { lastTimestamp: 'first' })
    const next = createUserMessage({
      content: [{ type: 'text', text: 'Now validate uninstall restoration. '.repeat(80) }],
      source: { kind: 'user' },
    })
    const second = compileFabricSummary([next], { prior: first.snapshot, lastTimestamp: 'second' })

    expect(second.summary).toContain('src/main.ts')
    expect(second.summary).toContain('Now validate uninstall restoration.')
    expect(second.snapshot.events.length).toBeGreaterThan(first.snapshot.events.length)
  })

  it('recovers original messages recursively instead of summarizing prior checkpoint prose', () => {
    const session = Session.create(SessionId('fabric-source-backed'))
    const appendTurn = (turn: number, text: string) => {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      if (turn === 1) {
        session.append('tool/code-dispatch-start', {
          parentCallId: 'run-code-1', subCallId: 'nested-read-source', name: 'read',
          arguments: { file_path: 'src/source-backed.ts' }, startedAt: 1,
        })
        session.append('tool/code-dispatch', {
          parentCallId: 'run-code-1', subCallId: 'nested-read-source', name: 'read',
          arguments: { file_path: 'src/source-backed.ts' }, isError: false,
          content: [{ type: 'text', text: '{"path":"src/source-backed.ts"}' }],
        })
      }
      session.append('assistant/message', {
        turn,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'done ' + turn }], source: { provider: 'test', model: 'test' } }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const compactSurface = (id: string) => {
      const nodes = [...session.surface.nodes]
      const start = session.append('compaction/start', { compactionId: id as never, turn: null })
      const summary = session.append('compaction/summary', {
        compactionId: id as never,
        summary: [{ type: 'text', text: 'derived checkpoint ' + id }],
        shadowedRange: { start: nodes[0]!, end: nodes.at(-1)! },
        shadowedSeqs: nodes,
        shadowedTokenCount: 1_000,
        provider: FABRIC_COMPACTION_PROVIDER,
        model: FABRIC_COMPACTION_MODEL,
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'checkpoint prose ' + id }],
        source: compactCheckpointSource(id as never),
      }), {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! },
        sourceEventSeqs: [start.seq, summary.seq, ...nodes],
      })
      session.append('compaction/end', { compactionId: id as never, turn: null })
    }

    appendTurn(1, 'ORIGINAL_ALPHA')
    compactSurface('one')
    appendTurn(2, 'ORIGINAL_BETA')
    compactSurface('two')

    const source = selectFabricCompactionSource(session, session.deriveMessages())
    const text = source.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
    expect(text).toEqual(expect.arrayContaining(['ORIGINAL_ALPHA', 'done 1', 'ORIGINAL_BETA', 'done 2']))
    expect(text.join('\n')).not.toContain('checkpoint prose')
    expect(source.activityEvents.map(event => event.type)).toEqual(expect.arrayContaining([
      'tool/code-dispatch-start', 'tool/code-dispatch',
    ]))
    const compiled = compileFabricSummary(source.messages, {
      activityEvents: source.activityEvents,
      budgetMessages: session.deriveMessages(),
    })
    expect(compiled.snapshot.events).toContainEqual(expect.objectContaining({ kind: 'user', text: 'ORIGINAL_ALPHA' }))
    expect(compiled.snapshot.events).toContainEqual(expect.objectContaining({
      kind: 'toolCall', toolCallId: 'nested-read-source', name: 'read',
    }))
  })

  it('renumbers sampled events so a byte-trimmed snapshot remains readable', () => {
    const messages = Array.from({ length: 12 }, (_, index) => createUserMessage({
      content: [{ type: 'text', text: `message ${index} ${'x'.repeat(6_000)}` }],
      source: { kind: 'user' },
    }))
    const compiled = compileFabricSummary(messages, { lastTimestamp: 'trimmed' })
    expect(compiled.snapshot.events.length).toBeLessThan(messages.length)
    expect(compiled.snapshot.events.map(event => event.index))
      .toEqual(compiled.snapshot.events.map((_, index) => index + 1))

    const session = Session.create(SessionId('fabric-trimmed-snapshot'))
    session.append('compaction/summary', {
      compactionId: 'cmp-trimmed' as never,
      summary: [{ type: 'text', text: compiled.summary }],
      rawOutput: compiled.rawOutput,
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [0],
      shadowedTokenCount: 1,
      provider: FABRIC_COMPACTION_PROVIDER,
      model: FABRIC_COMPACTION_MODEL,
    })
    expect(readLatestFabricSnapshot(session)).toEqual(compiled.snapshot)
  })

  it('accepts only the newest well-formed Fabric-provenance snapshot', () => {
    const compiled = compileFabricSummary(sourceMessages(), {
      lastTimestamp: 'snapshot',
      activityEvents: [{
        type: 'fabric/activity', seq: 7, time: 7,
        data: { activity: { id: 'workflow:review:completed', kind: 'workflow', action: 'completed', label: 'Review', status: 'completed', updatedAt: 7, detail: 'checked' } },
      }],
    })
    const encoded = compiled.rawOutput[1]?.type === 'text' ? compiled.rawOutput[1].text : ''
    const jsonStart = encoded.indexOf('{')
    const prefix = encoded.slice(0, jsonStart)
    const malformed = structuredClone(compiled.snapshot) as unknown as { events: Array<Record<string, unknown>> }
    const run = malformed.events.find(event => event.kind === 'fabricRun')
    if (run === undefined) throw new Error('test snapshot omitted Fabric run')
    run.description = 42

    const session = Session.create(SessionId('fabric-snapshot-validation'))
    const appendSummary = (rawOutput: typeof compiled.rawOutput, provider = FABRIC_COMPACTION_PROVIDER) => {
      session.append('compaction/summary', {
        compactionId: `cmp-${session.events.length}` as never,
        summary: [{ type: 'text', text: 'summary' }],
        rawOutput,
        shadowedRange: { start: 0, end: 0 },
        shadowedSeqs: [0],
        shadowedTokenCount: 1,
        provider,
        model: FABRIC_COMPACTION_MODEL,
      })
    }

    appendSummary(compiled.rawOutput, 'other-provider')
    expect(readLatestFabricSnapshot(session)).toBeUndefined()
    appendSummary(compiled.rawOutput)
    expect(readLatestFabricSnapshot(session)).toEqual(compiled.snapshot)
    appendSummary([{ type: 'text', text: 'summary' }, { type: 'text', text: `${prefix}${JSON.stringify(malformed)}` }])
    expect(readLatestFabricSnapshot(session)).toBeUndefined()
  })
})
