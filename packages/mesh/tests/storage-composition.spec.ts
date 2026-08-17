import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import Storage from '@monotykamary/dsh-storage'
import * as StorageJson from '@monotykamary/dsh-storage-json'
import * as StorageDomain from '@monotykamary/dsh-storage-domain'
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
      const firstMesh = first.ctx.fabricMesh.forWorkspace('workspace:persistence')
      await firstMesh.createTopic('events', FabricTopicId('events'))
      await firstMesh.publish(FabricTopicId('events'), { ready: true })
      await firstMesh.compareAndSwap(FabricStateKey('world'), 0, { revision: 1 })
      await firstMesh.createActor('builder', FabricActorId('builder'))
      await firstMesh.sendActor(FabricActorId('builder'), { task: 'build' })
      await first.dispose()

      const second = await mount(root)
      const snapshot = second.ctx.fabricMesh.forWorkspace('workspace:persistence').snapshot()
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
