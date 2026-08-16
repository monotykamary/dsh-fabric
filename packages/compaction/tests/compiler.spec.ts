import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import {
  compileFabricSummary,
  FABRIC_COMPACTION_MODEL,
  FABRIC_COMPACTION_PROVIDER,
  readLatestFabricSnapshot,
} from '../src/compiler.ts'

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

  it('projects durable Fabric and workflow activity into the typed summary', () => {
    const compiled = compileFabricSummary(sourceMessages(), {
      lastTimestamp: 'activity',
      activityEvents: [
        {
          type: 'fabric/activity', seq: 10, time: 10,
          data: { activity: { kind: 'actor', action: 'created', label: 'Builder', status: 'completed', nodeId: 'actor:builder' } },
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
        data: { activity: { kind: 'workflow', action: 'completed', label: 'Review', status: 'completed', detail: 'checked' } },
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
