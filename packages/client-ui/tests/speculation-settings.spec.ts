import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@monotykamary/dsh-client-runtime/client'
import {
  ToolSpeculationSettingsController,
  type ToolSpeculationSettingsSection,
} from '../src/client/speculation-settings-controller.ts'

const BASE: Required<ToolSpeculationSettingsSection> = {
  enabled: true,
  maxConcurrent: 4,
  maxEntries: 64,
  maxBufferBytes: 2 * 1024 * 1024,
  maxRetainedBytes: 16 * 1024 * 1024,
  entryTtlMs: 180_000,
}

class FakeScope implements SettingsScope<ToolSpeculationSettingsSection> {
  readonly writes: Array<[string, unknown]> = []
  readonly listeners = new Set<() => void>()
  user: Record<string, unknown>
  rejectField?: string

  constructor(user: Record<string, unknown> = {}) {
    this.user = { ...user }
  }

  getSnapshot(): SettingsScopeSnapshot<ToolSpeculationSettingsSection> {
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

describe('ToolSpeculationSettingsController', () => {
  it('stages bounded fields and writes only after an explicit valid save', async () => {
    const scope = new FakeScope()
    const controller = new ToolSpeculationSettingsController(scope)
    const face = controller.inject()

    expect(face.hooks.speculationSettings.getSnapshot()).toMatchObject({
      available: true,
      dirty: false,
      enabled: { text: 'true' },
      maxEntries: { text: '64' },
    })
    face.edit('maxBufferBytes', '65535')
    face.edit('maxRetainedBytes', '65535')
    expect(face.hooks.speculationSettings.getSnapshot()).toMatchObject({ dirty: true, invalid: true })
    await controller.save()
    expect(scope.writes).toEqual([])

    face.edit('maxBufferBytes', '65536')
    face.edit('maxRetainedBytes', '65536')
    face.edit('enabled', 'false')
    await controller.save()
    expect(scope.writes).toEqual([
      ['maxBufferBytes', 65536],
      ['maxRetainedBytes', 65536],
      ['enabled', false],
    ])
    expect(scope.user).toEqual({ maxBufferBytes: 65536, maxRetainedBytes: 65536, enabled: false })
    expect(face.hooks.speculationSettings.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    controller.dispose()
  })

  it('resets overrides to the composition base and keeps rejected drafts', async () => {
    const scope = new FakeScope({ maxConcurrent: 8 })
    const controller = new ToolSpeculationSettingsController(scope)
    const face = controller.inject()

    expect(face.hooks.speculationSettings.getSnapshot().maxConcurrent.overridden).toBe(true)
    face.resetField('maxConcurrent')
    await controller.save()
    expect(scope.user).toEqual({})
    expect(face.hooks.speculationSettings.getSnapshot().maxConcurrent)
      .toMatchObject({ text: '4', overridden: false })

    scope.rejectField = 'entryTtlMs'
    face.edit('entryTtlMs', '5000')
    await controller.save()
    expect(face.hooks.speculationSettings.getSnapshot()).toMatchObject({ dirty: true, failed: true })
    expect(face.hooks.speculationSettings.getSnapshot().entryTtlMs.text).toBe('5000')
    controller.dispose()
  })
})
