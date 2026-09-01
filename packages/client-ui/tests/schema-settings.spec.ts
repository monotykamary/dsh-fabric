import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@monotykamary/dsh-client-runtime/client'
import {
  FabricSchemaSettingsController,
  type FabricSchemaSettingsSection,
} from '../src/client/schema-settings-controller.ts'

const BASE: Required<FabricSchemaSettingsSection> = {
  mode: 'off', certificateTtlMs: 30_000, maxFiles: 100, maxBytes: 10_485_760,
}

class FakeScope implements SettingsScope<FabricSchemaSettingsSection> {
  readonly writes: Array<[string, unknown]> = []
  readonly listeners = new Set<() => void>()
  user: Record<string, unknown>
  rejectField?: string

  constructor(user: Record<string, unknown> = {}) {
    this.user = { ...user }
  }

  getSnapshot(): SettingsScopeSnapshot<FabricSchemaSettingsSection> {
    return {
      status: 'ready', value: { ...BASE, ...this.user }, base: BASE, user: this.user,
      revision: this.writes.length, writable: true, mode: 'host',
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async set(field: string, value: unknown): Promise<void> {
    this.writes.push([field, value])
    if (field !== this.rejectField) this.user = { ...this.user, [field]: value }
    this.publish()
  }

  async unset(field: string): Promise<void> {
    this.writes.push([field, undefined])
    const next = { ...this.user }
    delete next[field]
    this.user = next
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

describe('FabricSchemaSettingsController', () => {
  it('stages bounded fields and writes only after an explicit valid save', async () => {
    const scope = new FakeScope()
    const controller = new FabricSchemaSettingsController(scope)
    const face = controller.inject()

    expect(face.hooks.schemaSettings.getSnapshot()).toMatchObject({
      available: true, dirty: false, mode: { text: 'off' }, maxFiles: { text: '100' },
    })
    face.edit('maxFiles', '1001')
    expect(face.hooks.schemaSettings.getSnapshot()).toMatchObject({ dirty: true, invalid: true })
    await controller.save()
    expect(scope.writes).toEqual([])

    face.edit('maxFiles', '25')
    face.edit('mode', 'audit')
    await controller.save()
    expect(scope.writes).toEqual([['maxFiles', 25], ['mode', 'audit']])
    expect(scope.user).toEqual({ maxFiles: 25, mode: 'audit' })
    expect(face.hooks.schemaSettings.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    controller.dispose()
  })

  it('resets overrides to the composition base and keeps rejected drafts', async () => {
    const scope = new FakeScope({ mode: 'enforce' })
    const controller = new FabricSchemaSettingsController(scope)
    const face = controller.inject()

    expect(face.hooks.schemaSettings.getSnapshot().mode.overridden).toBe(true)
    face.resetField('mode')
    await controller.save()
    expect(scope.user).toEqual({})
    expect(face.hooks.schemaSettings.getSnapshot().mode).toMatchObject({ text: 'off', overridden: false })

    scope.rejectField = 'maxBytes'
    face.edit('maxBytes', '2048')
    await controller.save()
    expect(face.hooks.schemaSettings.getSnapshot()).toMatchObject({ dirty: true, failed: true })
    expect(face.hooks.schemaSettings.getSnapshot().maxBytes.text).toBe('2048')
    controller.dispose()
  })
})
