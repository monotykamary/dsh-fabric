import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as HostPlugin from '@dsh-fabric/host'
import { StorageFabricMesh } from '../src/provider.ts'
import * as MeshTool from '../src/tool.ts'

const signal = new AbortController().signal

describe('fabric_mesh ToolRuntime composition', () => {
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
      const result = await ctx.tools.execute({
        signal,
        callId: 'fabric-mesh-1' as never,
        name: 'fabric_mesh',
        arguments: { action: 'create_actor', id: 'builder', label: 'Builder' },
        agent: agent as never,
      })

      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ id: 'builder', label: 'Builder' })
      expect(ctx.fabricMesh.snapshot().actors).toEqual([expect.objectContaining({ id: 'builder' })])
      expect(session.events.at(-1)).toMatchObject({ type: 'fabric/activity', data: { activity: { kind: 'actor', action: 'created' } } })
      expect(ctx.sessionProjections.snapshot(session).values.fabricActivity).toMatchObject({
        activities: [expect.objectContaining({ nodeId: 'actor:builder' })],
        nodes: [expect.objectContaining({ id: 'actor:builder' })],
        edges: [expect.objectContaining({ source: '$session', target: 'actor:builder', kind: 'contains' })],
      })

      const sent = await ctx.tools.execute({ signal, callId: 'fabric-mesh-2' as never, name: 'fabric_mesh', arguments: { action: 'send_actor', actor_id: 'builder', payload: { task: 'compile' } }, agent: agent as never })
      const claimed = await ctx.tools.execute({ signal, callId: 'fabric-mesh-3' as never, name: 'fabric_mesh', arguments: { action: 'claim_actor_message', actor_id: 'builder' }, agent: agent as never })
      const message = claimed.value as { id: string; claimToken: string }
      expect(sent.isError).toBe(false)
      expect(message).toMatchObject({ id: expect.any(String), claimToken: expect.any(String) })
      await ctx.tools.execute({ signal, callId: 'fabric-mesh-4' as never, name: 'fabric_mesh', arguments: { action: 'settle_actor_message', message_id: message.id, claim_token: message.claimToken, value: { ok: true } }, agent: agent as never })
      const replay = await ctx.tools.execute({ signal, callId: 'fabric-mesh-5' as never, name: 'fabric_mesh', arguments: { action: 'settle_actor_message', message_id: message.id, claim_token: message.claimToken, error: 'late retry' }, agent: agent as never })

      expect(replay.value).toMatchObject({ status: 'completed', result: { ok: true } })
      expect(session.events.at(-1)).toMatchObject({ type: 'fabric/activity', data: { activity: { action: 'completed', status: 'completed' } } })
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
