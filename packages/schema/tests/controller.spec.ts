import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import Storage from '@monotykamary/dsh-storage'
import * as StorageJson from '@monotykamary/dsh-storage-json'
import * as StorageDomain from '@monotykamary/dsh-storage-domain'
import { StorageFabricMesh } from 'dsh-fabric-mesh/provider'
import { DEFAULT_SCHEMA_CONFIG, SchemaController, type FabricSchemaConfig } from '../src/controller.ts'
import { StateStore } from '../src/state-store.ts'
import { sha256File } from '../src/workspace.ts'

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

async function mountedSchema(workspace: string, storageRoot: string, config: FabricSchemaConfig = DEFAULT_SCHEMA_CONFIG) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: storageRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json' }),
    await ctx.plugin(StorageFabricMesh),
  ]
  const identity = 'session:schema-test'
  const mesh = ctx.fabricMesh.forWorkspace(identity)
  const state = new StateStore(mesh, identity)
  const controller = new SchemaController(workspace, config, mesh, identity, state)
  return {
    ctx,
    controller,
    state,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

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

describe('SchemaController workspace transactions', () => {
  it('hypothesize → verify → commit applies declared operations, advances the generation, and advances the state head', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-commit')
    try {
      await writeFile(join(root, 'existing.txt'), 'hello')
      await writeFile(join(root, 'remove.txt'), 'remove')
      const { controller, state, dispose } = await mountedSchema(root, storage)
      try {
        const hypothesis = await controller.hypothesize({
          label: 'add note',
          summary: 'append a note file',
          evidence: [{ kind: 'file_exists', path: 'existing.txt' }],
        }, 'inv-1')
        expect(hypothesis).toMatchObject({ status: 'active', generation: 0 })
        expect(hypothesis.state).toBeNull()

        const verified = await controller.verify(String(hypothesis.hypothesisId), 'inv-1')
        expect(verified.verified).toBe(true)
        expect(verified.results).toEqual([expect.objectContaining({ status: 'confirmed' })])
        const certificate = String((verified as { certificate: string }).certificate)
        const mutations: unknown[] = []
        const existingSha256 = sha256File(join(root, 'existing.txt'))
        const removeSha256 = sha256File(join(root, 'remove.txt'))

        const committed = await controller.commit({
          hypothesisId: String(hypothesis.hypothesisId),
          certificate,
          operations: [
            { kind: 'write', path: 'note.txt', content: 'note\n', expected: { absent: true } },
            { kind: 'edit', path: 'existing.txt', oldText: 'hello', newText: 'HELLO', expectedSha256: existingSha256 },
            { kind: 'delete', path: 'remove.txt', expectedSha256: removeSha256 },
          ],
          postconditions: [{ kind: 'file_contains', path: 'note.txt', literal: 'note' }],
        }, 'inv-1', receipts => { mutations.push(...receipts) })

        expect(committed.outcome).toBe('committed')
        expect(committed.generation).toBe(1)
        expect(committed.paths).toEqual(['note.txt', 'existing.txt', 'remove.txt'])
        const noteSha256 = sha256File(join(root, 'note.txt'))
        const updatedSha256 = sha256File(join(root, 'existing.txt'))
        expect(mutations).toEqual([
          { beforeSha1: null, afterSha1: sha1('note\n'), beforeSha256: null, afterSha256: noteSha256.slice('sha256:'.length), path: 'note.txt', operation: 'create', diffs: [{ oldText: null, newText: 'note\n' }] },
          { beforeSha1: sha1('hello'), afterSha1: sha1('HELLO'), beforeSha256: existingSha256.slice('sha256:'.length), afterSha256: updatedSha256.slice('sha256:'.length), path: 'existing.txt', operation: 'modify', diffs: [{ oldText: 'hello', newText: 'HELLO' }] },
          { beforeSha1: sha1('remove'), afterSha1: null, beforeSha256: removeSha256.slice('sha256:'.length), afterSha256: null, path: 'remove.txt', operation: 'delete', diffs: [{ oldText: 'remove', newText: null }] },
        ])
        expect(controller.status().lastOutcome).toBe('committed')
        expect(controller.status().generation).toBe(1)
        expect(state.getHead()?.label).toBe('schema:add note')
        expect(state.getHead()?.to).toBe('schema-commit-1')
        const history = state.history({})
        expect(history.transitions).toEqual([expect.objectContaining({ label: 'schema:add note', to: 'schema-commit-1' })])
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('fails closed when the workspace fingerprint changes after hypothesize', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-drift')
    try {
      await writeFile(join(root, 'existing.txt'), 'hello')
      const { controller, dispose } = await mountedSchema(root, storage)
      try {
        const hypothesis = await controller.hypothesize({
          label: 'assume stable',
          summary: 'workspace is stable',
          evidence: [{ kind: 'file_exists', path: 'existing.txt' }],
        }, 'inv-1')
        await writeFile(join(root, 'existing.txt'), 'changed!')
        const verified = await controller.verify(String(hypothesis.hypothesisId), 'inv-1')
        expect(verified.verified).toBe(false)
        expect(verified.reason).toMatch(/fingerprint changed/)
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('rolls back and records a failed outcome when an operation precondition fails', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-rollback')
    try {
      await writeFile(join(root, 'target.txt'), 'original')
      const { controller, dispose } = await mountedSchema(root, storage)
      try {
        const hypothesis = await controller.hypothesize({
          label: 'bad edit',
          summary: 'edit that must fail',
          evidence: [{ kind: 'file_exists', path: 'target.txt' }],
        }, 'inv-1')
        const verified = await controller.verify(String(hypothesis.hypothesisId), 'inv-1')
        const certificate = String((verified as { certificate: string }).certificate)

        const expectedSha256 = sha256File(join(root, 'target.txt'))
        const committed = await controller.commit({
          hypothesisId: String(hypothesis.hypothesisId),
          certificate,
          operations: [
            { kind: 'edit', path: 'target.txt', oldText: 'does not occur once', newText: 'x', expectedSha256 },
          ],
          postconditions: [{ kind: 'file_sha256', path: 'target.txt', sha256: expectedSha256 }],
        }, 'inv-1')

        expect(committed.outcome).toBe('rolled_back')
        expect(controller.status().lastOutcome).toBe('rolled_back')
        expect(controller.status().generation).toBe(0)
        expect(await (await import('node:fs/promises')).readFile(join(root, 'target.txt'), 'utf8')).toBe('original')
        expect(stateHead(controller)).toBeNull()
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('aborts an uncommitted hypothesis and blocks foreign invocation use', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-abort')
    try {
      await writeFile(join(root, 'existing.txt'), 'hello')
      const { controller, dispose } = await mountedSchema(root, storage)
      try {
        const hypothesis = await controller.hypothesize({
          label: 'doomed',
          summary: 'aborted hypothesis',
          evidence: [{ kind: 'file_exists', path: 'existing.txt' }],
        }, 'inv-1')
        await expect(controller.verify(String(hypothesis.hypothesisId), 'other-inv'))
          .rejects.toThrow(/different tool invocation/)

        await controller.abort({ hypothesisId: String(hypothesis.hypothesisId) }, 'inv-1')
        const status = controller.status()
        expect(status.hypotheses).toEqual([expect.objectContaining({ label: 'doomed', status: 'aborted' })])
        await expect(controller.verify(String(hypothesis.hypothesisId), 'inv-1'))
          .rejects.toThrow(/not active/)
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('issues single-use certificates that expire', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-ttl')
    try {
      await writeFile(join(root, 'existing.txt'), 'hello')
      const { controller, dispose } = await mountedSchema(root, storage)
      try {
        const hypothesis = await controller.hypothesize({
          label: 'ttl',
          summary: 'certificate is single-use',
          evidence: [{ kind: 'file_exists', path: 'existing.txt' }],
        }, 'inv-1')
        const verified = await controller.verify(String(hypothesis.hypothesisId), 'inv-1')
        const certificate = String((verified as { certificate: string }).certificate)

        // Same certificate cannot be consumed twice.
        await controller.commit({
          hypothesisId: String(hypothesis.hypothesisId),
          certificate,
          operations: [{ kind: 'write', path: 'a.txt', content: 'a', expected: { absent: true } }],
          postconditions: [{ kind: 'file_exists', path: 'a.txt' }],
        }, 'inv-1')
        await expect(controller.commit({
          hypothesisId: String(hypothesis.hypothesisId),
          certificate,
          operations: [{ kind: 'write', path: 'b.txt', content: 'b', expected: { absent: true } }],
          postconditions: [{ kind: 'file_exists', path: 'b.txt' }],
        }, 'inv-1')).rejects.toThrow(/certificate is consumed/)
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })

  it('rejects expired certificates', async () => {
    const { workspace: root, storage, cleanup } = await roots('dsh-fabric-schema-expired')
    try {
      await writeFile(join(root, 'existing.txt'), 'hello')
      const { controller, dispose } = await mountedSchema(root, storage, { ...DEFAULT_SCHEMA_CONFIG, certificateTtlMs: 1 })
      try {
        const hypothesis = await controller.hypothesize({
          label: 'expiry',
          summary: 'certificate expires before commit',
          evidence: [{ kind: 'file_exists', path: 'existing.txt' }],
        }, 'inv-1')
        const verified = await controller.verify(String(hypothesis.hypothesisId), 'inv-1')
        const certificate = String((verified as { certificate: string }).certificate)
        await new Promise(resolve => setTimeout(resolve, 15))
        await expect(controller.commit({
          hypothesisId: String(hypothesis.hypothesisId),
          certificate,
          operations: [{ kind: 'write', path: 'a.txt', content: 'a', expected: { absent: true } }],
          postconditions: [{ kind: 'file_exists', path: 'a.txt' }],
        }, 'inv-1')).rejects.toThrow(/certificate expired/)
      } finally {
        await dispose()
      }
    } finally {
      await cleanup()
    }
  })
})

function stateHead(controller: SchemaController) {
  const state = controller.state
  return state ? state.getHead() : null
}
