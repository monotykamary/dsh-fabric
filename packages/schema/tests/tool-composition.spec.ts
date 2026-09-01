import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import SessionStore, { SessionId } from '@monotykamary/dsh-session'
import type { JsonValue, Session } from '@monotykamary/dsh-session'
import { createToolResultMessage } from '@monotykamary/dsh-llm'
import type { ContentBlock } from '@monotykamary/dsh-llm'
import SessionProjectionRegistry from '@monotykamary/dsh-session-projection'
import Storage from '@monotykamary/dsh-storage'
import * as StorageJson from '@monotykamary/dsh-storage-json'
import * as StorageDomain from '@monotykamary/dsh-storage-domain'
import SystemPrompt from '@monotykamary/dsh-system-prompt'
import CommandRuntime from '@monotykamary/dsh-commands'
import ToolRuntime, { defineTool } from '@monotykamary/dsh-tools'
import * as HostPlugin from 'dsh-fabric-host'
import QuickJsCodeRuntime from 'dsh-fabric-code-runtime-quickjs'
import { StorageFabricMesh } from 'dsh-fabric-mesh/provider'
import * as MeshTool from 'dsh-fabric-mesh/tool'
import { resolveWorkspaceIdentity } from 'dsh-fabric-mesh/tool'
import { FabricStateKey, FabricTopicId } from 'dsh-fabric-protocol'
import { FabricSchemaSettings, type FabricSchemaSettingsConfig } from '../src/index.ts'
import * as SchemaTool from '../src/tool.ts'

const signal = new AbortController().signal

type SettledToolResult = { isError: boolean; content: ContentBlock[]; value?: JsonValue }

async function roots(prefix: string): Promise<{ workspace: string; storage: string; cleanup: () => Promise<void> }> {
  const workspace = await mkdtemp(join(tmpdir(), `${prefix}-`))
  const storage = await mkdtemp(join(tmpdir(), `${prefix}-storage-`))
  return {
    workspace,
    storage,
    cleanup: async () => {
      await rm(workspace, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    },
  }
}

async function compose(storageRoot: string, config: SchemaTool.Config = {}, settingsConfig?: FabricSchemaSettingsConfig) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SessionStore),
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(HostPlugin, { activityLimit: 20, topologyLimit: 20 }),
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(CommandRuntime),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: storageRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json' }),
    await ctx.plugin(StorageFabricMesh),
  ]
  if (settingsConfig !== undefined) fibers.push(await ctx.plugin(FabricSchemaSettings, settingsConfig))
  fibers.push(await ctx.plugin(SchemaTool, config))
  return { ctx, fibers }
}

function agentFor(session: Session, ctx: Context) {
  return { id: session.id, session, ctx, options: {}, status: 'idle' }
}

function workspaceOf(ctx: Context, agent: { id: string; session: Session; ctx: Context }): string {
  return resolveWorkspaceIdentity(ctx, agent as never)
}

describe('dsh-fabric-schema ToolRuntime composition', () => {
  it('exposes the state and schema toolset with guidance and durable mesh records', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-tool')
    try {
      const { ctx, fibers } = await compose(storage)
      try {
        const session = ctx.sessions.create(SessionId('schema-tool-session'), { meta: { cwd: root } })
        const agent = agentFor(session, ctx)
        const identity = workspaceOf(ctx, agent)
        const execute = async (callId: string, name: string, arguments_: Record<string, JsonValue>): Promise<SettledToolResult> => {
          const result = await ctx.tools.execute({
            signal,
            callId: callId as never,
            name,
            arguments: arguments_,
            agent: agent as never,
          })
          session.append('tool/result', {
            turn: 1,
            step: 1,
            message: createToolResultMessage({ callId: callId as never, content: result.content, isError: result.isError }),
          }, { surfaceOp: 'append' })
          return result
        }

        const status = await execute('schema-1', 'schema_status', {})
        expect(status.isError).toBe(false)
        expect(status.value).toMatchObject({ mode: 'off', generation: 0, hypotheses: [] })

        const transitioned = await execute('schema-2', 'state_transition', {
          label: 'init', to: 'clean', summary: 'workspace clean',
        })
        expect(transitioned.isError).toBe(false)
        expect(transitioned.value).toMatchObject({ head: expect.objectContaining({ to: 'clean' }) })

        const got = await execute('schema-3', 'state_get', {})
        expect(got.value).toMatchObject({ head: expect.objectContaining({ label: 'init' }) })

        const assembly = await ctx.systemPrompt.assemble({ agent: agent as never })
        expect(assembly.sections).toContainEqual(expect.objectContaining({
          name: 'fabric:schema-guidance',
          text: expect.stringContaining('Schema world state'),
        }))

        const mesh = ctx.fabricMesh.forWorkspace(identity)
        const events = mesh.topicMessages(FabricTopicId('fabric.state'), 10)
        expect(events.length).toBeGreaterThanOrEqual(2)
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('returns an empty snapshot from state_get before the fabric.state topic exists', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-fresh')
    try {
      const { ctx, fibers } = await compose(storage)
      try {
        const session = ctx.sessions.create(SessionId('schema-fresh-session'), { meta: { cwd: root } })
        const agent = agentFor(session, ctx)
        const result = await ctx.tools.execute({
          signal,
          callId: 'schema-fresh-1' as never,
          name: 'state_get',
          arguments: {},
          agent: agent as never,
        })
        expect(result.isError).toBe(false)
        expect(result.value).toMatchObject({
          head: null,
          goal: null,
          complexity: { files: 0, decisionPoints: 0, lastNetDelta: 0 },
          certification: { current: null, recent: [] },
        })
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed evidence and operations with typed errors', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-args')
    try {
      const { ctx, fibers } = await compose(storage)
      try {
        const session = ctx.sessions.create(SessionId('schema-args-session'), { meta: { cwd: root } })
        const agent = agentFor(session, ctx)
        const execute = async (callId: string, name: string, arguments_: Record<string, JsonValue>): Promise<SettledToolResult> =>
          ctx.tools.execute({ signal, callId: callId as never, name, arguments: arguments_, agent: agent as never })

        const bad = await execute('schema-args-1', 'schema_hypothesize', {
          label: 'bad', summary: 'bad evidence', evidence: [{ kind: 'file_sha256', path: 'x', sha256: 'not-a-digest' }],
        })
        expect(bad.isError).toBe(true)
        expect(bad.content).toContainEqual(expect.objectContaining({
          type: 'text', text: expect.stringContaining('sha256'),
        }))

        const ok = await execute('schema-args-2', 'schema_hypothesize', {
          label: 'ok', summary: 'ok evidence', evidence: [{ kind: 'file_exists', path: 'x.txt' }],
        })
        expect(ok.isError).toBe(false)
        expect(ok.value).toMatchObject({ status: 'active' })
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('snapshots persistent settings and applies /fabric schema as an immediate session override', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-command')
    try {
      const { ctx, fibers } = await compose(storage, { mode: 'off' }, {
        mode: 'audit', certificateTtlMs: 60_000, maxFiles: 25, maxBytes: 1_048_576,
      })
      try {
        ctx.tools.register(defineTool({
          name: 'edit',
          description: 'stub edit for ephemeral enforcement',
          parameters: { path: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async () => ({ edited: true }),
        }))
        const session = ctx.sessions.create(SessionId('schema-command-session'), { meta: { cwd: root } })
        const agent = agentFor(session, ctx)
        const execute = (callId: string, name: string, arguments_: Record<string, JsonValue>) =>
          ctx.tools.execute({ signal, callId: callId as never, name, arguments: arguments_, agent: agent as never })

        expect((await execute('command-status-1', 'schema_status', {})).value).toMatchObject({
          mode: 'audit', source: 'configured default', configuredMode: 'audit',
          certificateTtlMs: 60_000, maxFiles: 25, maxBytes: 1_048_576, executorRuntime: 'quickjs',
        })
        const initial = await ctx.commands.execute(agent as never, '/fabric schema', [], signal)
        expect(initial?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('configured default') })

        const changed = await ctx.commands.execute(agent as never, '/fabric schema enforce', [], signal)
        expect(changed?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('for this session') })
        expect((await execute('command-status-2', 'schema_status', {})).value).toMatchObject({
          mode: 'enforce', source: 'session override', configuredMode: 'audit',
        })
        expect((await execute('command-edit-denied', 'edit', { path: 'x.txt' })).isError).toBe(true)
        const enforcingPrompt = await ctx.systemPrompt.assemble({ agent: agent as never })
        expect(enforcingPrompt.sections.find(section => section.name === 'fabric:schema-guidance')?.text)
          .toContain('Direct edit/write/bash')

        await ctx.commands.execute(agent as never, '/fabric schema off', [], signal)
        expect((await execute('command-edit-allowed', 'edit', { path: 'x.txt' })).value).toEqual({ edited: true })
        expect((await ctx.commands.execute(agent as never, '/fabric schema invalid', [], signal))?.result)
          .toEqual({ kind: 'error', text: 'Usage: /fabric schema [off|audit|enforce]' })
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('enforce mode admits only explicit reads, the Code Mode transport, and certified Schema actions', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-enforce')
    try {
      const { ctx, fibers } = await compose(storage, { mode: 'enforce' })
      try {
        // Register stub tools AFTER compose resolved plugins but BEFORE executing.
        ctx.tools.register(defineTool({
          name: 'edit',
          description: 'stub edit for enforcement',
          parameters: { path: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async () => ({ edited: true }),
        }))
        ctx.tools.register(defineTool({
          name: 'read',
          description: 'stub read for enforcement',
          parameters: { path: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async () => ({ read: true }),
          isConcurrencySafe: () => true,
        }))
        ctx.tools.register(defineTool({
          name: 'bash',
          description: 'stub shell effect for enforcement',
          parameters: { command: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async () => ({ ran: true }),
        }))
        ctx.tools.register(defineTool({
          name: 'fabric_mesh',
          description: 'stub multiplexed mesh surface',
          parameters: { action: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async args => ({ action: args.action }),
        }))

        ctx.tools.register(defineTool({
          name: 'fabric_models',
          description: 'stub multiplexed model surface',
          parameters: { action: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async args => ({ action: args.action }),
        }))
        for (const name of ['spawn_teammate', 'ralph', 'compact', 'web_search', 'ask_user_question']) {
          ctx.tools.register(defineTool({
            name,
            description: `stub ${name} effect`,
            parameters: {},
            output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            execute: async () => ({ ran: name }),
          }))
        }

        const session = ctx.sessions.create(SessionId('schema-enforce-session'), { meta: { cwd: root } })
        const agent = agentFor(session, ctx)
        const identity = workspaceOf(ctx, agent)
        const execute = async (callId: string, name: string, arguments_: Record<string, JsonValue>): Promise<SettledToolResult> =>
          ctx.tools.execute({ signal, callId: callId as never, name, arguments: arguments_, agent: agent as never })

        const denied = await execute('enforce-1', 'edit', { path: 'x.txt' })
        expect(denied.isError).toBe(true)
        expect(denied.content).toContainEqual(expect.objectContaining({
          type: 'text', text: expect.stringContaining('must use schema_commit'),
        }))

        const allowed = await execute('enforce-2', 'read', { path: 'x.txt' })
        expect(allowed.isError).toBe(false)
        expect(allowed.value).toEqual({ read: true })
        expect((await execute('enforce-3', 'fabric_mesh', { action: 'snapshot' })).value).toEqual({ action: 'snapshot' })
        expect((await execute('enforce-4', 'bash', { command: 'touch x' })).isError).toBe(true)
        expect((await execute('enforce-5', 'fabric_mesh', {
          action: 'cas_state', key: 'x', expected_version: 0, value: {},
        })).isError).toBe(true)
        expect((await execute('enforce-6', 'state_transition', {
          label: 'bypass', to: 'changed', summary: 'must not run',
        })).isError).toBe(true)
        expect((await execute('enforce-7', 'schema_status', {})).isError).toBe(false)
        expect((await execute('enforce-8', 'fabric_models', { action: 'current' })).value)
          .toEqual({ action: 'current' })
        expect((await execute('enforce-9', 'fabric_models', { action: 'select' })).isError).toBe(true)
        for (const [index, name] of ['spawn_teammate', 'ralph', 'compact', 'web_search', 'ask_user_question'].entries()) {
          expect((await execute(`enforce-effect-${index}`, name, {})).isError).toBe(true)
        }

        const assembly = await ctx.systemPrompt.assemble({ agent: agent as never })
        expect(assembly.sections.find(section => section.name === 'fabric:schema-guidance')?.text)
          .toContain('Direct edit/write/bash')

        const blocked = ctx.fabricMesh.forWorkspace(identity)
          .topicMessages(FabricTopicId('fabric.schema'), 20)
        const blockedRefs = blocked.flatMap(message => {
          const payload = message.payload as { kind?: string; data?: { ref?: string } }
          return payload.kind === 'blocked' && typeof payload.data?.ref === 'string' ? [payload.data.ref] : []
        })
        expect(blockedRefs).toEqual(expect.arrayContaining([
          'edit',
          'bash',
          'fabric_mesh.cas_state',
          'state_transition',
          'fabric_models.select',
          'spawn_teammate',
          'ralph',
          'compact',
          'web_search',
          'ask_user_question',
        ]))
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('contains effects and scopes certified authority to one real QuickJS run_code invocation', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-code')
    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      fibers.push(await ctx.plugin(HostPlugin, { activityLimit: 20, topologyLimit: 20 }))
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(CommandRuntime))
      fibers.push(await ctx.plugin(QuickJsCodeRuntime, {
        maxWallMs: 10_000,
        memoryLimitBytes: 32 * 1024 * 1024,
        maxStackBytes: 256 * 1024,
        maxOutputBytes: 64 * 1024,
      }))
      fibers.push(await ctx.plugin(ToolRuntime, { mode: 'code', maxParallelSubCalls: 2 }))
      fibers.push(await ctx.plugin(Storage))
      fibers.push(await ctx.plugin(StorageJson, { root: storage }))
      fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
      fibers.push(await ctx.plugin(StorageFabricMesh))
      fibers.push(await ctx.plugin(MeshTool))
      fibers.push(await ctx.plugin(SchemaTool, { mode: 'enforce' }))

      ctx.tools.register(defineTool({
        name: 'bash',
        description: 'stub shell effect',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async () => ({ ran: true }),
      }))

      const session = ctx.sessions.create(SessionId('schema-code-session'), { meta: { cwd: root } })
      const agent = agentFor(session, ctx)
      const executeCode = (callId: string, code: string): Promise<SettledToolResult> => ctx.tools.execute({
        signal,
        callId: callId as never,
        name: 'run_code',
        arguments: {
          code,
          display: { name: 'Exercise strict Schema', description: 'Probe reads, blocked effects, and certified writes.' },
        },
        agent: agent as never,
      })

      const committed = await executeCode('schema-code-1', `
        const snapshot = await tools.fabric_mesh({ action: 'snapshot' });
        let shellBlocked = false;
        let meshWriteBlocked = false;
        try { await tools.bash({ command: 'touch bypass.txt' }); } catch { shellBlocked = true; }
        try {
          await tools.fabric_mesh({ action: 'cas_state', key: 'bypass', expected_version: 0, value: {} });
        } catch { meshWriteBlocked = true; }
        const hypothesis = await tools.schema_hypothesize({
          label: 'write-note',
          summary: 'Create one certified note',
          evidence: [{ kind: 'file_absent', path: 'note.txt' }],
        });
        const verified = await tools.schema_verify({ hypothesisId: hypothesis.hypothesisId });
        const commit = await tools.schema_commit({
          hypothesisId: hypothesis.hypothesisId,
          certificate: verified.certificate,
          operations: [{ kind: 'write', path: 'note.txt', content: 'certified\\n', expected: { absent: true } }],
          postconditions: [{ kind: 'file_contains', path: 'note.txt', literal: 'certified' }],
        });
        return { shellBlocked, meshWriteBlocked, actors: snapshot.totals.actors, outcome: commit.outcome };
      `)

      expect(committed.isError).toBe(false)
      expect(committed.value).toMatchObject({
        result: { shellBlocked: true, meshWriteBlocked: true, actors: 0, outcome: 'committed' },
      })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('certified\n')

      const unfinished = await executeCode('schema-code-2', `
        const hypothesis = await tools.schema_hypothesize({
          label: 'unfinished',
          summary: 'Issue authority but do not commit it',
          evidence: [{ kind: 'file_exists', path: 'note.txt' }],
        });
        const verified = await tools.schema_verify({ hypothesisId: hypothesis.hypothesisId });
        return { hypothesisId: hypothesis.hypothesisId, certificate: verified.certificate };
      `)
      expect(unfinished.isError).toBe(false)
      const unfinishedResult = (unfinished.value as { result: { hypothesisId: string } }).result
      const identity = workspaceOf(ctx, agent)
      const record = ctx.fabricMesh.forWorkspace(identity)
        .getState(FabricStateKey(`schema/hypothesis/${unfinishedResult.hypothesisId}`))
      expect(record?.value).toMatchObject({ status: 'abandoned', parentToolCallId: 'schema-code-2' })
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('certified\n')
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await cleanup()
    }
  })

  it('audit mode records would_block without denying', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-audit')
    try {
      const { ctx, fibers } = await compose(storage, { mode: 'audit' })
      try {
        ctx.tools.register(defineTool({
          name: 'web_search',
          description: 'stub unknown network effect for audit',
          parameters: { query: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async () => ({ searched: true }),
        }))

        const session = ctx.sessions.create(SessionId('schema-audit-session'), { meta: { cwd: root } })
        const agent = agentFor(session, ctx)
        const identity = workspaceOf(ctx, agent)
        const result = await ctx.tools.execute({
          signal,
          callId: 'audit-1' as never,
          name: 'web_search',
          arguments: { query: 'x' },
          agent: agent as never,
        })
        expect(result.isError).toBe(false)
        expect(result.value).toEqual({ searched: true })

        const events = ctx.fabricMesh.forWorkspace(identity)
          .topicMessages(FabricTopicId('fabric.schema'), 10)
        expect(events.some(message => {
          const payload = message.payload as { kind?: string; data?: { ref?: string } }
          return payload.kind === 'would_block' && payload.data?.ref === 'web_search'
        })).toBe(true)
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })
})
