import { mkdtemp, rm } from 'node:fs/promises'
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
import ToolRuntime, { defineTool } from '@monotykamary/dsh-tools'
import * as HostPlugin from 'dsh-fabric-host'
import { StorageFabricMesh } from 'dsh-fabric-mesh/provider'
import { resolveWorkspaceIdentity } from 'dsh-fabric-mesh/tool'
import { FabricTopicId } from 'dsh-fabric-protocol'
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

async function compose(storageRoot: string, config: SchemaTool.Config = {}, extra: Array<() => Promise<unknown>> = []) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SessionStore),
    await ctx.plugin(SessionProjectionRegistry),
    await ctx.plugin(HostPlugin, { activityLimit: 20, topologyLimit: 20 }),
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: storageRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json' }),
    await ctx.plugin(StorageFabricMesh),
  ]
  for (const mount of extra) await mount()
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

  it('enforce mode denies direct mutation tools through the pre-execute gate', async () => {
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

        const blocked = ctx.fabricMesh.forWorkspace(identity)
          .topicMessages(FabricTopicId('fabric.schema'), 10)
        expect(blocked.some(message => (message.payload as { kind?: string }).kind === 'blocked')).toBe(true)
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('audit mode records would_block without denying', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-audit')
    try {
      const { ctx, fibers } = await compose(storage, { mode: 'audit' })
      try {
        ctx.tools.register(defineTool({
          name: 'edit',
          description: 'stub edit for audit',
          parameters: { path: { type: 'string', required: true } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async () => ({ edited: true }),
        }))

        const session = ctx.sessions.create(SessionId('schema-audit-session'), { meta: { cwd: root } })
        const agent = agentFor(session, ctx)
        const identity = workspaceOf(ctx, agent)
        const result = await ctx.tools.execute({
          signal,
          callId: 'audit-1' as never,
          name: 'edit',
          arguments: { path: 'x.txt' },
          agent: agent as never,
        })
        expect(result.isError).toBe(false)
        expect(result.value).toEqual({ edited: true })

        const events = ctx.fabricMesh.forWorkspace(identity)
          .topicMessages(FabricTopicId('fabric.schema'), 10)
        expect(events.some(message => (message.payload as { kind?: string }).kind === 'would_block')).toBe(true)
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
      }
    } finally {
      await cleanup()
    }
  })
})
