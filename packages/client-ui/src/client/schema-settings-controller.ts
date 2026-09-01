/** Browser form model for the persistent Fabric Schema settings namespace. */

import type { SettingsScope, SnapshotStore } from '@monotykamary/dsh-client-runtime/client'

export const FABRIC_SCHEMA_SETTINGS_NAMESPACE = 'fabric-schema'
export const FABRIC_SCHEMA_MODES = ['off', 'audit', 'enforce'] as const

export type FabricSchemaMode = typeof FABRIC_SCHEMA_MODES[number]
export type FabricSchemaSettingsField = 'mode' | 'certificateTtlMs' | 'maxFiles' | 'maxBytes'

export interface FabricSchemaSettingsSection {
  mode?: FabricSchemaMode
  certificateTtlMs?: number
  maxFiles?: number
  maxBytes?: number
}

export interface FabricSchemaFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface FabricSchemaSettingsState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  mode: FabricSchemaFieldState
  certificateTtlMs: FabricSchemaFieldState
  maxFiles: FabricSchemaFieldState
  maxBytes: FabricSchemaFieldState
}

export interface FabricSchemaSettingsFace {
  hooks: { schemaSettings: SnapshotStore<FabricSchemaSettingsState> }
  edit(field: FabricSchemaSettingsField, text: string): void
  resetField(field: FabricSchemaSettingsField): void
  save(): void
  discard(): void
}

interface Draft {
  text: string
  clear: boolean
}

interface Plan {
  field: FabricSchemaSettingsField
  write: { kind: 'set'; value: string | number } | { kind: 'clear' } | undefined
}

interface FieldSpec {
  format(value: unknown): string
  parse(text: string): string | number | undefined
}

const integer = (minimum: number, maximum: number): FieldSpec => ({
  format: value => typeof value === 'number' ? String(value) : '',
  parse: (text) => {
    const value = Number(text.trim())
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
  },
})

const SPECS: Record<FabricSchemaSettingsField, FieldSpec> = {
  mode: {
    format: value => typeof value === 'string' ? value : '',
    parse: text => FABRIC_SCHEMA_MODES.includes(text.trim() as FabricSchemaMode) ? text.trim() : undefined,
  },
  certificateTtlMs: integer(1_000, 600_000),
  maxFiles: integer(1, 1_000),
  maxBytes: integer(1_024, 100 * 1024 * 1024),
}

/** Stages one Schema card's edits and commits them only on explicit save. */
export class FabricSchemaSettingsController {
  private readonly staged = new Map<FabricSchemaSettingsField, Draft>()
  private readonly store: SnapshotStore<FabricSchemaSettingsState>
  private readonly unsubscribe: () => void
  private saving = false
  private failed = false

  constructor(private readonly scope: SettingsScope<FabricSchemaSettingsSection>) {
    this.store = createLocalSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  inject(): FabricSchemaSettingsFace {
    return {
      hooks: { schemaSettings: this.store },
      edit: (field, text) => {
        this.staged.set(field, { text, clear: false })
        this.failed = false
        this.publish()
      },
      resetField: (field) => {
        this.staged.set(field, { text: SPECS[field].format(this.base()[field]), clear: true })
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  dispose(): void {
    this.unsubscribe()
  }

  async save(): Promise<void> {
    const plan = this.plan()
    if (this.saving || plan.length === 0 || plan.some(item => item.write === undefined)) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      for (const item of plan) {
        const write = item.write!
        if (write.kind === 'clear') {
          await this.scope.unset(item.field)
          landed = !Object.hasOwn(this.user(), item.field) && landed
        } else {
          await this.scope.set(item.field, write.value)
          landed = Object.is(this.user()[item.field], write.value) && landed
        }
      }
    } catch {
      landed = false
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private projection(): FabricSchemaSettingsState {
    const plan = this.plan()
    return {
      available: this.scope.getSnapshot().status === 'ready',
      writable: this.scope.getSnapshot().writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.write === undefined),
      saving: this.saving,
      failed: this.failed,
      mode: this.field('mode'),
      certificateTtlMs: this.field('certificateTtlMs'),
      maxFiles: this.field('maxFiles'),
      maxBytes: this.field('maxBytes'),
    }
  }

  private field(field: FabricSchemaSettingsField): FabricSchemaFieldState {
    const draft = this.staged.get(field)
    if (draft === undefined) {
      return {
        text: SPECS[field].format(this.value()[field]),
        overridden: Object.hasOwn(this.user(), field),
        invalid: false,
      }
    }
    return {
      text: draft.text,
      overridden: !draft.clear,
      invalid: !draft.clear && SPECS[field].parse(draft.text) === undefined,
    }
  }

  private plan(): Plan[] {
    const plan: Plan[] = []
    for (const [field, draft] of this.staged) {
      if (draft.clear) {
        if (Object.hasOwn(this.user(), field)) plan.push({ field, write: { kind: 'clear' } })
        continue
      }
      const parsed = SPECS[field].parse(draft.text)
      if (parsed === undefined) {
        plan.push({ field, write: undefined })
      } else if (!Object.is(this.value()[field], parsed)) {
        plan.push({ field, write: { kind: 'set', value: parsed } })
      }
    }
    return plan
  }

  private value(): Record<string, unknown> {
    return record(this.scope.getSnapshot().value)
  }

  private base(): Record<string, unknown> {
    return record(this.scope.getSnapshot().base)
  }

  private user(): Record<string, unknown> {
    return record(this.scope.getSnapshot().user)
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}

function createLocalSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let current = initial
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      current = next
      publish()
    },
    update: (mutator) => {
      const next = structuredClone(current)
      mutator(next)
      current = next
      publish()
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
