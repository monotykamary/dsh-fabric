import { mkdtemp, realpath, rm } from 'node:fs/promises'
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
import ToolRuntime from '@monotykamary/dsh-tools'
import * as HostPlugin from 'dsh-fabric-host'
import QuickJsCodeRuntime from 'dsh-fabric-code-runtime-quickjs'
import { StorageFabricMesh } from '../src/provider.ts'
import * as MeshTool from '../src/tool.ts'

const signal = new AbortController().signal

type SettledToolResult = { isError: boolean; content: ContentBlock[]; value?: JsonValue; meta?: JsonValue }

async function executeMesh(
  ctx: Context,
  agent: { session: Session },
  callId: string,
  args: Record<string, JsonValue>,
): Promise<SettledToolResult> {
  const result = await ctx.tools.execute({
    signal,
    callId: callId as never,
    name: 'fabric_mesh',
    arguments: args,
    agent: agent as never,
  })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: callId as never, content: result.content, isError: result.isError }),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
  }, { surfaceOp: 'append' })
  return result
}

describe('fabric_mesh ToolRuntime composition', () => {
  it('resolves an unindexed session by the registry canonical path synchronously', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fabric-identity-'))
    try {
      const canonical = await realpath(root)
      const ctx = {
        get: (name: string) => name === 'workspaceRegistry'
          ? { list: () => [{ id: 'stable-workspace', path: canonical, sessionIds: [] }] }
          : undefined,
      }
      const agent = { id: SessionId('not-indexed-yet'), session: { header: { cwd: root } } }
      expect(MeshTool.resolveWorkspaceIdentity(ctx as never, agent as never)).toBe('workspace:stable-workspace')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('commits storage, a durable activity event, and the host projection through one tool call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fabric-tool-'))
    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      fibers.push(await ctx.plugin(HostPlugin, { activityLimit: 20, topologyLimit: 20 }))
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(ToolRuntime))
      fibers.push(await ctx.plugin(Storage))
      fibers.push(await ctx.plugin(StorageJson, { root }))
      fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
      fibers.push(await ctx.plugin(StorageFabricMesh))
      fibers.push(await ctx.plugin(MeshTool))

      const session = ctx.sessions.create(SessionId('fabric-tool-session'))
      const agent = { id: session.id, session, ctx, options: {}, status: 'idle' }
      const result = await executeMesh(ctx, agent, 'fabric-mesh-1', { action: 'create_actor', id: 'builder', label: 'Builder' })

      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ id: 'builder', label: 'Builder' })
      const scopedMesh = ctx.fabricMesh.forWorkspace('session:' + session.id)
      expect(scopedMesh.snapshot().actors).toEqual([expect.objectContaining({ id: 'builder' })])
      const initialAssembly = await ctx.systemPrompt.assemble({ agent: agent as never })
      expect(initialAssembly.sections).toContainEqual(expect.objectContaining({
        name: 'fabric:mesh-guidance',
        text: expect.stringContaining('context compaction'),
      }))
      expect(initialAssembly.contexts).toContainEqual(expect.objectContaining({
        name: 'fabric:mesh-state',
        text: expect.stringMatching(/\"actors\".*\"builder\"/),
      }))
      expect(session.events.at(-1)).toMatchObject({
        type: 'tool/result',
        data: { meta: { kind: 'dsh-fabric.mesh-result', activity: { activity: { kind: 'actor', action: 'created' } } } },
      })
      expect(ctx.sessionProjections.snapshot(session).values.fabricActivity).toMatchObject({
        activities: [expect.objectContaining({ nodeId: 'actor:builder' })],
        nodes: [expect.objectContaining({ id: 'actor:builder' })],
        edges: [expect.objectContaining({ source: '$session', target: 'actor:builder', kind: 'contains' })],
      })

      const sent = await executeMesh(ctx, agent, 'fabric-mesh-2', { action: 'send_actor', actor_id: 'builder', payload: { task: 'compile' } })
      await executeMesh(ctx, agent, 'fabric-mesh-2b', { action: 'send_actor', actor_id: 'builder', payload: { task: 'verify' } })
      const claimed = await executeMesh(ctx, agent, 'fabric-mesh-3', { action: 'claim_actor_message', actor_id: 'builder' })
      const message = claimed.value as { id: string; claimToken: string }
      expect(sent.isError).toBe(false)
      expect(message).toMatchObject({ id: expect.any(String), claimToken: expect.any(String) })
      await executeMesh(ctx, agent, 'fabric-mesh-4', { action: 'settle_actor_message', message_id: message.id, claim_token: message.claimToken, value: { ok: true } })
      const replay = await executeMesh(ctx, agent, 'fabric-mesh-5', { action: 'settle_actor_message', message_id: message.id, claim_token: message.claimToken, error: 'late retry' })

      expect(replay.value).toMatchObject({ status: 'completed', result: { ok: true } })
      const rehydratedAssembly = await ctx.systemPrompt.assemble({ agent: agent as never })
      expect(rehydratedAssembly.contexts.find(context => context.name === 'fabric:mesh-state')?.text)
        .toMatch(/\"actorMessages\".*\"completed\"/)

      const snapshot = await executeMesh(ctx, agent, 'fabric-mesh-6', { action: 'snapshot', limit: 1 })
      expect(snapshot.value).toMatchObject({ totals: { actors: 1, actorMessages: 2 }, truncated: true })
      expect(ctx.sessionProjections.snapshot(session).values.fabricActivity?.nodes)
        .toContainEqual(expect.objectContaining({ id: 'actor:builder', label: 'Builder', status: 'pending' }))
      const excessive = await executeMesh(ctx, agent, 'fabric-mesh-7', { action: 'snapshot', limit: 501 })
      expect(excessive.isError).toBe(true)
      const agentless = await ctx.tools.execute({
        signal,
        callId: 'fabric-mesh-agentless' as never,
        name: 'fabric_mesh',
        arguments: { action: 'snapshot' },
      })
      expect(agentless.isError).toBe(true)
      expect(agentless.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('requires a DSH agent workspace'),
      }))
      expect(session.events).toContainEqual(expect.objectContaining({
        type: 'tool/result',
        data: expect.objectContaining({ meta: expect.objectContaining({ activity: expect.objectContaining({ activity: expect.objectContaining({ action: 'completed', status: 'completed' }) }) }) }),
      }))
      const pruned = await executeMesh(ctx, agent, 'fabric-mesh-8', { action: 'prune_mailbox', actor_id: 'builder', retain: 0 })
      expect(pruned.value).toEqual({ deleted: 1, retained: 0 })
      expect(scopedMesh.actorMessages('builder' as never)).toHaveLength(1)
      expect(session.events.at(-1)).toMatchObject({
        type: 'tool/result',
        data: { meta: { activity: { activity: { action: 'pruned' } } } },
      })
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes run_code through fabric_mesh into durable storage and projection state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fabric-code-mesh-'))
    const ctx = new Context()
    const fibers = []
    try {
      fibers.push(await ctx.plugin(SessionStore))
      fibers.push(await ctx.plugin(SessionProjectionRegistry))
      fibers.push(await ctx.plugin(HostPlugin, { activityLimit: 20, topologyLimit: 20 }))
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(QuickJsCodeRuntime, {
        maxWallMs: 10_000,
        memoryLimitBytes: 32 * 1024 * 1024,
        maxStackBytes: 256 * 1024,
        maxOutputBytes: 64 * 1024,
      }))
      fibers.push(await ctx.plugin(ToolRuntime, { mode: 'code', maxParallelSubCalls: 2 }))
      fibers.push(await ctx.plugin(Storage))
      fibers.push(await ctx.plugin(StorageJson, { root }))
      fibers.push(await ctx.plugin(StorageDomain, { backend: 'json' }))
      fibers.push(await ctx.plugin(StorageFabricMesh))
      fibers.push(await ctx.plugin(MeshTool))

      const session = ctx.sessions.create(SessionId('fabric-code-mesh'))
      const agent = { id: session.id, session, ctx, options: {}, status: 'idle' }
      const result = await ctx.tools.execute({
        signal,
        callId: 'fabric-code-mesh-1' as never,
        name: 'run_code',
        arguments: {
          description: 'Create a durable actor and inspect the mesh',
          code: `
            await tools.fabric_mesh({ action: 'create_actor', id: 'code-builder', label: 'Code Builder' });
            return await tools.fabric_mesh({ action: 'snapshot', limit: 10 });
          `,
        },
        agent: agent as never,
      })

      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        result: { actors: [expect.objectContaining({ id: 'code-builder' })] },
      })
      expect(ctx.fabricMesh.forWorkspace('session:' + session.id).snapshot().actors)
        .toContainEqual(expect.objectContaining({ id: 'code-builder' }))
      expect(session.events.some(event => event.type === 'tool/code-dispatch')).toBe(true)
      expect(session.events.some(event => String(event.type) === 'fabric/activity')).toBe(false)
      expect(ctx.sessionProjections.snapshot(session).values.fabricActivity?.nodes)
        .toContainEqual(expect.objectContaining({ id: 'actor:code-builder' }))
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

})
