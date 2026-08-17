import { describe, expect, it, vi } from 'vitest'
import { Context } from '@monotykamary/cordis'
import type { Agent } from '@monotykamary/dsh-agent'
import CommandRuntime from '@monotykamary/dsh-commands'
import * as CommandCompact from '@monotykamary/dsh-command-compact'
import { createAssistantMessage, createUserMessage } from '@monotykamary/dsh-llm'
import LlmRuntime from '@monotykamary/dsh-llm'
import SessionStore, { Session, SessionId } from '@monotykamary/dsh-session'
import TokenMeter from '@monotykamary/dsh-token-meter'
import { FabricCompactionEngine } from '../src/index.ts'
import { FABRIC_COMPACTION_MODEL, readLatestFabricSnapshot } from '../src/compiler.ts'
import AgentPresets from '@monotykamary/dsh-agent-presets'
import { apply as provideFabricPresetRoot, FABRIC_PRESET_ROOT } from '../src/presets.ts'

const SIGNAL = new AbortController().signal
const HISTORY = 'Older durable implementation context with paths, decisions, and verified failures. '.repeat(120)

function closedConversation(): Session {
  const session = Session.create(SessionId('fabric-compact-command'))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${HISTORY} turn ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `completed work for turn ${turn}` }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

function idleAgent(session: Session): Agent {
  return {
    session,
    status: 'idle',
    options: { provider: 'test', model: 'test' },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(SIGNAL)
    },
  } as unknown as Agent
}

describe('Fabric /compact composition', () => {
  it('routes the real command through deterministic Fabric compaction without an LLM call', async () => {
    const ctx = new Context()
    try {
      void new LlmRuntime(ctx)
      void new SessionStore(ctx)
      vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
      void new TokenMeter(ctx)
      await ctx.plugin(CommandRuntime)
      const engine = new FabricCompactionEngine(ctx, { auto: false })
      await ctx.plugin(CommandCompact)
      const agent = idleAgent(closedConversation())

      const execution = await ctx.commands.execute(agent, '/compact', SIGNAL)

      const end = agent.session.events.findLast(event => event.type === 'compaction/end')
      const diagnostic = end?.type === 'compaction/end' ? end.data.error : undefined
      expect(execution?.result, diagnostic).toMatchObject({ kind: 'success' })
      expect(execution?.result.text).toMatch(/^Compacted \d+ history items/)
      expect(ctx.compaction).toBeInstanceOf(FabricCompactionEngine)
      expect(engine.config.auto).toBe(false)
      const summary = agent.session.events.findLast(event => event.type === 'compaction/summary')
      expect(summary?.type === 'compaction/summary' && summary.data.provider).toBe('@dsh-fabric/compaction')
      expect(summary?.type === 'compaction/summary' && summary.data.model).toBe(FABRIC_COMPACTION_MODEL)
      expect(summary?.type === 'compaction/summary' && summary.data.summary[0]?.type === 'text'
        ? summary.data.summary[0].text
        : '').toContain('[Session Goal]')
      expect(readLatestFabricSnapshot(agent.session)?.events.length).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('discovers only the English Fabric-owned preset roster', async () => {
    const ctx = new Context()
    try {
      provideFabricPresetRoot(ctx)
      expect(ctx.fabricPresetRoot).toBe(FABRIC_PRESET_ROOT)
      const presets = new AgentPresets(ctx, {
        default: 'standard',
        roots: [{ path: ctx.fabricPresetRoot, trust: 'system' }],
        includeUserRoot: false,
      })
      const listed = await presets.list()
      expect(listed.map(preset => preset.id)).toEqual(['standard', 'code', 'minimal', 'cordis'])
      expect(listed.map(preset => preset.name)).toEqual([
        'Standard mode', 'Code mode', 'Minimal mode', 'Creation mode',
      ])
      for (const preset of listed) {
        const composition = await presets.read(preset.id)
        expect(composition).toContain("name: '@dsh-fabric/compaction'")
        expect(composition).not.toContain('@monotykamary/dsh-compaction-basic')
        expect(composition).not.toContain('@monotykamary/dsh-compaction-tool-result-pruner')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
