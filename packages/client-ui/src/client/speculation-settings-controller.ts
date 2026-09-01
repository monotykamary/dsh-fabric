/** Browser form model for persistent speculative Code Mode settings. */

import type { SettingsScope, SnapshotStore } from '@monotykamary/dsh-client-runtime/client'

export const TOOL_SPECULATION_SETTINGS_NAMESPACE = 'tool-speculation'
export type ToolSpeculationSettingsField =
  | 'enabled' | 'maxConcurrent' | 'maxEntries' | 'maxBufferBytes' | 'maxRetainedBytes' | 'entryTtlMs'

export interface ToolSpeculationSettingsSection {
  enabled?: boolean
  maxConcurrent?: number
  maxEntries?: number
  maxBufferBytes?: number
  maxRetainedBytes?: number
  entryTtlMs?: number
}

export interface ToolSpeculationFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface ToolSpeculationSettingsState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  enabled: ToolSpeculationFieldState
  maxConcurrent: ToolSpeculationFieldState
  maxEntries: ToolSpeculationFieldState
  maxBufferBytes: ToolSpeculationFieldState
  maxRetainedBytes: ToolSpeculationFieldState
  entryTtlMs: ToolSpeculationFieldState
}

export interface ToolSpeculationSettingsFace {
  hooks: { speculationSettings: SnapshotStore<ToolSpeculationSettingsState> }
  edit(field: ToolSpeculationSettingsField, text: string): void
  resetField(field: ToolSpeculationSettingsField): void
  save(): void
  discard(): void
}

interface Draft {
  text: string
  clear: boolean
}

interface Plan {
  field: ToolSpeculationSettingsField
  write: { kind: 'set'; value: boolean | number } | { kind: 'clear' } | undefined
}

interface FieldSpec {
  format(value: unknown): string
  parse(text: string): boolean | number | undefined
}

const integer = (minimum: number, maximum: number): FieldSpec => ({
  format: value => typeof value === 'number' ? String(value) : '',
  parse: (text) => {
    const value = Number(text.trim())
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
  },
})

const SPECS: Record<ToolSpeculationSettingsField, FieldSpec> = {
  enabled: {
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: text => text === 'true' ? true : text === 'false' ? false : undefined,
  },
  maxConcurrent: integer(1, 32),
  maxEntries: integer(1, 1_024),
  maxBufferBytes: integer(64 * 1_024, 64 * 1_024 * 1_024),
  maxRetainedBytes: integer(64 * 1_024, 256 * 1_024 * 1_024),
  entryTtlMs: integer(5_000, 30 * 60_000),
}

/** Stages one speculative execution card and commits only explicit valid saves. */
export class ToolSpeculationSettingsController {
  private readonly staged = new Map<ToolSpeculationSettingsField, Draft>()
  private readonly store: SnapshotStore<ToolSpeculationSettingsState>
  private readonly unsubscribe: () => void
  private saving = false
  private failed = false

  constructor(private readonly scope: SettingsScope<ToolSpeculationSettingsSection>) {
    this.store = createLocalSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  inject(): ToolSpeculationSettingsFace {
    return {
      hooks: { speculationSettings: this.store },
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

  private projection(): ToolSpeculationSettingsState {
    const plan = this.plan()
    return {
      available: this.scope.getSnapshot().status === 'ready',
      writable: this.scope.getSnapshot().writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.write === undefined),
      saving: this.saving,
      failed: this.failed,
      enabled: this.field('enabled'),
      maxConcurrent: this.field('maxConcurrent'),
      maxEntries: this.field('maxEntries'),
      maxBufferBytes: this.field('maxBufferBytes'),
      maxRetainedBytes: this.field('maxRetainedBytes'),
      entryTtlMs: this.field('entryTtlMs'),
    }
  }

  private field(field: ToolSpeculationSettingsField): ToolSpeculationFieldState {
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
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      current = next
      for (const listener of listeners) listener()
    },
    update: (mutator) => {
      const next = structuredClone(current)
      mutator(next)
      current = next
      for (const listener of listeners) listener()
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
