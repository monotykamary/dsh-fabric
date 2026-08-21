import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import Storage from '@monotykamary/dsh-storage'
import * as StorageJson from '@monotykamary/dsh-storage-json'
import * as StorageDomain from '@monotykamary/dsh-storage-domain'
import { StorageFabricMesh } from 'dsh-fabric-mesh/provider'
import { StateStore } from '../src/state-store.ts'

async function mountedMesh(storageRoot: string) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: storageRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json' }),
    await ctx.plugin(StorageFabricMesh),
  ]
  return {
    ctx,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

/** Workspace root and separate mesh-storage root (mirrors production: DSH home is outside the project). */
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

describe('StateStore world state over the Fabric mesh', () => {
  it('appends a transition, advances the head, and folds history', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-state')
    try {
      const { ctx, dispose } = await mountedMesh(storage)
      try {
        const store = new StateStore(ctx.fabricMesh.forWorkspace('session:test'), 'session:test')
        const { head } = await store.transition({
          label: 'initial',
          to: 'clean',
          summary: 'workspace is clean',
          tags: ['bootstrap'],
        }, root)

        expect(head.to).toBe('clean')
        expect(head.transitionSequence).toBe(1)
        expect(store.getHead()?.label).toBe('initial')

        const chained = await store.transition({
          label: 'patch',
          from: 'clean',
          to: 'patched',
          summary: 'applied the patch',
          evidence: ['test -f package.json || true'],
        }, root)
        expect(chained.head.from).toBe('clean')

        const history = store.history({})
        expect(history.transitions.map(record => record.label)).toEqual(['initial', 'patch'])
        expect(history.labels).toEqual(expect.arrayContaining(['clean', 'patched']))
        expect(store.get().head?.to).toBe('patched')
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('rejects a from-mismatch unless forced', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-state-from')
    try {
      const { ctx, dispose } = await mountedMesh(storage)
      try {
        const store = new StateStore(ctx.fabricMesh.forWorkspace('session:test'), 'session:test')
        await store.transition({ label: 'a', to: 'alpha', summary: 'a' }, root)
        await expect(store.transition({ label: 'b', from: 'beta', to: 'gamma', summary: 'b' }, root))
          .rejects.toThrow(/from-mismatch/)
        await store.transition({ label: 'c', from: 'beta', to: 'gamma', summary: 'c', force: true }, root)
        expect(store.getHead()?.to).toBe('gamma')
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('certifies evidence fail-closed and revokes on violation', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-state-verify')
    try {
      await writeFile(join(root, 'fixture.txt'), 'hello')
      const { ctx, dispose } = await mountedMesh(storage)
      try {
        const store = new StateStore(ctx.fabricMesh.forWorkspace('session:test'), 'session:test')
        const { head } = await store.transition({
          label: 'fixture',
          to: 'fixture-present',
          summary: 'fixture exists',
          evidence: [`test -f ${join(root, 'fixture.txt')}`],
        }, root)

        const report = await store.verify({ cwd: root })
        expect(report.certified).toBe(true)
        expect(report.certificationStatus).toBe('certified')
        expect(report.certificate).toMatchObject({ current: true, targets: [{ transitionId: head.transitionId }] })
        expect(report.results).toHaveLength(1)
        expect(report.results[0]?.status).toBe('confirmed')

        const violated = await store.transition({
          label: 'missing',
          to: 'fixture-missing',
          summary: 'fixture is gone',
          evidence: [`test -f ${join(root, 'does-not-exist.txt')}`],
        }, root)
        const failed = await store.verify({ cwd: root, labels: [violated.head.label] })
        expect(failed.certified).toBe(false)
        expect(failed.violated).toBe(true)
        expect(failed.failures[0]?.reason).toBe('nonzero-exit')
        // The current certificate is revoked once the head's evidence fails.
        expect(store.get().certification.current).toBeNull()
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('tracks structural complexity through the ledger', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-state-complexity')
    try {
      await writeFile(join(root, 'sample.ts'), 'export function pick(a: number, b: number) { if (a > b) return a; return b }')
      const { ctx, dispose } = await mountedMesh(storage)
      try {
        const store = new StateStore(ctx.fabricMesh.forWorkspace('session:test'), 'session:test')
        await store.transition({
          label: 'refactor',
          to: 'refactored',
          summary: 'introduce pick',
          complexity: { files: ['sample.ts'] },
        }, root)

        const measured = store.complexity({ cwd: root })
        expect(measured.files).toEqual([expect.objectContaining({ file: 'sample.ts', supported: true, current: 1, recorded: 1, delta: 0 })])
        expect(measured.netDelta).toBe(0)
        expect(store.get().complexity).toMatchObject({ files: 1, decisionPoints: 1 })
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('sets and checks the executable goal predicate', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-state-goal')
    try {
      await writeFile(join(root, 'done.txt'), 'x')
      const { ctx, dispose } = await mountedMesh(storage)
      try {
        const store = new StateStore(ctx.fabricMesh.forWorkspace('session:test'), 'session:test')
        await store.goal({ check: `test -f ${join(root, 'done.txt')}`, description: 'done marker exists' })
        const passed = await store.checkGoal({ cwd: root })
        expect(passed.passed).toBe(true)

        await store.goal({ check: `test -f ${join(root, 'missing.txt')}` })
        const failed = await store.checkGoal({ cwd: root })
        expect(failed.passed).toBe(false)
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })
})
