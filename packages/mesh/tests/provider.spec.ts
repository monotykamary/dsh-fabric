import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import { FabricActorId, FabricStateKey } from '@dsh-fabric/protocol'
import { StorageFabricMesh } from '../src/provider.ts'
import type { FabricMeshWorkspace } from '../src/index.ts'

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

async function setup(options: { writeGate?: Promise<void>; onClose?(): void } = {}): Promise<{ ctx: Context; mesh: FabricMeshWorkspace; service: StorageFabricMesh; dispose(): Promise<void> }> {
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
  return { ctx, mesh: ctx.fabricMesh.forWorkspace('workspace:test'), service: ctx.fabricMesh as StorageFabricMesh, dispose: () => fiber.dispose() }
}

describe('StorageFabricMesh', () => {
  it('isolates duplicate ids across workspaces while sharing within one workspace', async () => {
    const { service, dispose } = await setup()
    const alpha = service.forWorkspace('workspace:alpha')
    const alphaAgain = service.forWorkspace('workspace:alpha')
    const beta = service.forWorkspace('workspace:beta')
    await alpha.createActor('Alpha builder', FabricActorId('builder'))
    await beta.createActor('Beta builder', FabricActorId('builder'))
    await alpha.compareAndSwap(FabricStateKey('status'), 0, { workspace: 'alpha' })
    await beta.compareAndSwap(FabricStateKey('status'), 0, { workspace: 'beta' })

    expect(alphaAgain.actor(FabricActorId('builder')).label).toBe('Alpha builder')
    expect(beta.actor(FabricActorId('builder')).label).toBe('Beta builder')
    expect(alpha.snapshot().totals).toMatchObject({ actors: 1, states: 1 })
    expect(beta.snapshot().totals).toMatchObject({ actors: 1, states: 1 })
    expect(alpha.getState(FabricStateKey('status'))?.value).toEqual({ workspace: 'alpha' })
    expect(beta.getState(FabricStateKey('status'))?.value).toEqual({ workspace: 'beta' })
    await dispose()
  })

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


  it('detaches caller-owned and returned JSON across durable boundaries', async () => {
    const { mesh, dispose } = await setup()
    const input = { nested: { ready: false } }
    const stored = await mesh.compareAndSwap(FabricStateKey('detached'), 0, input)
    input.nested.ready = true
    ;(stored.value as { nested: { ready: boolean } }).nested.ready = true

    expect(mesh.getState(FabricStateKey('detached'))?.value).toEqual({ nested: { ready: false } })
    const snapshot = mesh.snapshot()
    ;(snapshot.states[0]!.value as { nested: { ready: boolean } }).nested.ready = true
    expect(mesh.getState(FabricStateKey('detached'))?.value).toEqual({ nested: { ready: false } })
    await dispose()
  })

  it('returns bounded snapshots with authoritative totals and rejects oversized identifiers', async () => {
    const { mesh, dispose } = await setup()
    await mesh.createActor('One', FabricActorId('one'))
    await mesh.createActor('Two', FabricActorId('two'))
    await mesh.sendActor(FabricActorId('one'), { task: 1 })
    await mesh.sendActor(FabricActorId('one'), { task: 2 })

    expect(mesh.snapshot(1)).toMatchObject({
      actors: [expect.any(Object)],
      actorMessages: [expect.any(Object)],
      totals: { actors: 2, actorMessages: 2 },
      truncated: true,
    })
    expect(mesh.actor(FabricActorId('one'))).toMatchObject({ label: 'One', status: 'pending', queued: 2 })
    expect(() => mesh.createActor('Too long', FabricActorId('x'.repeat(257)))).toThrow('1–256 UTF-8 bytes')
    await dispose()
  })

  it('prunes topic history and terminal mailbox records without deleting active commands', async () => {
    const { mesh, dispose } = await setup()
    const topic = await mesh.createTopic('retained')
    await mesh.publish(topic.id, { ordinal: 1 })
    await mesh.publish(topic.id, { ordinal: 2 })
    await mesh.publish(topic.id, { ordinal: 3 })
    expect(await mesh.pruneTopic(topic.id, 1)).toEqual({ deleted: 2, retained: 1 })
    expect(mesh.topicMessages(topic.id)).toHaveLength(1)

    const actor = await mesh.createActor('retained actor', FabricActorId('retained-actor'))
    await mesh.sendActor(actor.id, { ordinal: 1 })
    await mesh.sendActor(actor.id, { ordinal: 2 })
    const failed = await mesh.claimActor(actor.id)
    await mesh.settleActor(failed!.id, failed!.claimToken!, { error: 'failed once' })
    await new Promise(resolve => setTimeout(resolve, 2))
    const completed = await mesh.claimActor(actor.id)
    await mesh.settleActor(completed!.id, completed!.claimToken!, { result: { ok: true } })
    const active = await mesh.sendActor(actor.id, { ordinal: 3 })

    expect(await mesh.pruneActor(actor.id, 1)).toEqual({ deleted: 1, retained: 1 })
    expect(mesh.actorMessages(actor.id).map(message => message.id)).toEqual(expect.arrayContaining([completed!.id, active.id]))
    expect(mesh.actorMessages(actor.id)).not.toContainEqual(expect.objectContaining({ id: failed!.id }))
    expect(mesh.actor(actor.id)).toMatchObject({ status: 'pending', queued: 1, claimed: 0 })
    await dispose()
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
