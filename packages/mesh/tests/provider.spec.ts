import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FabricActorId, FabricStateKey } from '@dsh-fabric/protocol'
import { StorageFabricMesh } from '../src/provider.ts'
import type { FabricMesh } from '../src/index.ts'

class MemoryTable<V> {
  readonly values = new Map<string, V>()
  constructor(private readonly writeGate: Promise<void> = Promise.resolve()) {}
  get(key: string) { return this.values.get(key) }
  entries() { return [...this.values.entries()][Symbol.iterator]() }
  keys() { return [...this.values.keys()][Symbol.iterator]() }
  get size() { return this.values.size }
  async put(key: string, value: V) { await this.writeGate; this.values.set(key, value) }
  async delete(key: string) { return this.values.delete(key) }
  async update(key: string, transform: (value: V) => V) {
    const current = this.values.get(key)
    if (current === undefined) throw new Error('missing')
    const next = transform(current)
    this.values.set(key, next)
    return next
  }
}

async function setup(options: { writeGate?: Promise<void>; onClose?(): void } = {}): Promise<{ ctx: Context; mesh: FabricMesh; dispose(): Promise<void> }> {
  const tables = new Map<string, MemoryTable<unknown>>()
  const domain = {
    name: 'dsh_fabric_mesh',
    table(name: string) {
      let table = tables.get(name)
      if (table === undefined) { table = new MemoryTable(options.writeGate); tables.set(name, table) }
      return table
    },
    close: async () => { options.onClose?.() },
  }
  const ctx = new Context()
  ctx.provide('storageDomain', { open: async () => domain } as never)
  const fiber = await ctx.plugin(StorageFabricMesh)
  return { ctx, mesh: ctx.fabricMesh, dispose: () => fiber.dispose() }
}

describe('StorageFabricMesh', () => {
  it('performs revisioned compare-and-swap and rejects stale writers', async () => {
    const { mesh, dispose } = await setup()
    const key = FabricStateKey('world')
    await expect(mesh.compareAndSwap(key, 0, { ready: false })).resolves.toMatchObject({ version: 1 })
    await expect(mesh.compareAndSwap(key, 0, { ready: true })).rejects.toMatchObject({ code: 'version-conflict' })
    await expect(mesh.compareAndSwap(key, 1, { ready: true })).resolves.toMatchObject({ version: 2, value: { ready: true } })
    await dispose()
  })

  it('claims actor commands once and replays a stored settlement', async () => {
    const { mesh, dispose } = await setup()
    const actor = await mesh.createActor('builder', FabricActorId('builder'))
    const queued = await mesh.sendActor(actor.id, { task: 'compile' })
    const claimed = await mesh.claimActor(actor.id)

    expect(claimed).toMatchObject({ id: queued.id, status: 'claimed' })
    expect(await mesh.claimActor(actor.id)).toBeNull()
    const settled = await mesh.settleActor(claimed!.id, claimed!.claimToken!, { result: { ok: true } })
    expect(settled).toMatchObject({ status: 'completed', result: { ok: true } })
    await expect(mesh.settleActor(claimed!.id, claimed!.claimToken!, { result: { ignored: true } })).resolves.toEqual(settled)
    await dispose()
  })

  it('drains admitted writes before domain close and rejects late mutations', async () => {
    const gate = Promise.withResolvers<void>()
    let closed = false
    let disposed = false
    const { mesh, dispose } = await setup({ writeGate: gate.promise, onClose: () => { closed = true } })
    const write = mesh.createTopic('events')
    await Promise.resolve()
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()

    expect(disposed).toBe(false)
    expect(closed).toBe(false)
    gate.resolve()
    await expect(write).resolves.toMatchObject({ label: 'events' })
    await disposal
    expect(closed).toBe(true)
    await expect(mesh.createTopic('late')).rejects.toThrow('service is disposing')
  })

  it('publishes durable topic messages into the snapshot', async () => {
    const { mesh, dispose } = await setup()
    const topic = await mesh.createTopic('events')
    await mesh.publish(topic.id, { kind: 'ready' })
    expect(mesh.topicMessages(topic.id)).toEqual([expect.objectContaining({ payload: { kind: 'ready' } })])
    expect(mesh.snapshot().topics).toHaveLength(1)
    await dispose()
  })
})
