import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { FabricActorId, FabricStateKey, FabricTopicId } from '@dsh-fabric/protocol'
import { StorageFabricMesh } from '../src/provider.ts'

async function mount(root: string) {
  const ctx = new Context()
  const storage = await ctx.plugin(Storage)
  const json = await ctx.plugin(StorageJson, { root })
  const domain = await ctx.plugin(StorageDomain, { backend: 'json' })
  const mesh = await ctx.plugin(StorageFabricMesh)
  return {
    ctx,
    async dispose() {
      await mesh.dispose()
      await domain.dispose()
      await json.dispose()
      await storage.dispose()
    },
  }
}

describe('real DSH storage composition', () => {
  it('reopens topics, state, and actor mailboxes from the JSON backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fabric-mesh-'))
    try {
      const first = await mount(root)
      await first.ctx.fabricMesh.createTopic('events', FabricTopicId('events'))
      await first.ctx.fabricMesh.publish(FabricTopicId('events'), { ready: true })
      await first.ctx.fabricMesh.compareAndSwap(FabricStateKey('world'), 0, { revision: 1 })
      await first.ctx.fabricMesh.createActor('builder', FabricActorId('builder'))
      await first.ctx.fabricMesh.sendActor(FabricActorId('builder'), { task: 'build' })
      await first.dispose()

      const second = await mount(root)
      const snapshot = second.ctx.fabricMesh.snapshot()
      expect(snapshot.topics).toEqual([expect.objectContaining({ id: 'events' })])
      expect(snapshot.topicMessages).toEqual([expect.objectContaining({ payload: { ready: true } })])
      expect(snapshot.states).toEqual([expect.objectContaining({ key: 'world', version: 1 })])
      expect(snapshot.actors).toEqual([expect.objectContaining({ id: 'builder', status: 'pending', queued: 1 })])
      await second.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
