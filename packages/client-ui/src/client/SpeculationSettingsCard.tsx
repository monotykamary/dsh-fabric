/** Fabric-owned settings card for speculative Code Mode execution. */

import { useState, type ReactNode } from 'react'
import { ChevronDown } from '@monotykamary/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@monotykamary/dsh-client-ui-slots'
import type {} from '@monotykamary/dsh-client-ui-settings-plugins/client'
import type {
  ToolSpeculationFieldState,
  ToolSpeculationSettingsFace,
  ToolSpeculationSettingsField,
} from './speculation-settings-controller.ts'
import css from './SchemaSettingsCard.module.css'

export type SpeculationSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'fabric.speculation.settings'>
  & InjectFace<ToolSpeculationSettingsFace>

export function SpeculationSettingsCard(props: SpeculationSettingsCardProps) {
  const [open, setOpen] = useState(false)
  const state = props.useSpeculationSettings(snapshot => snapshot)
  const { t } = props
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  const enabled = state.enabled.text === 'true'
  return (
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button type="button" className={css.header} aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}>
        <span className={css.headText}>
          <span className={css.name}>{t('title')}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <ChevronDown size={14} className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
      </button>
      {open ? (
        <div className={css.body}>
          {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
          <SettingsField id="fabric-speculation-enabled" label={t('enabled')} hint={t('enabledHint')}
            field="enabled" state={state.enabled} disabled={disabled} resetLabel={t('reset')}
            overriddenLabel={t('overridden')} invalidLabel={t('invalid')} onReset={props.resetField}>
            <label className={css.toggleRow} htmlFor="fabric-speculation-enabled">
              <input id="fabric-speculation-enabled" className={css.toggle} type="checkbox" checked={enabled}
                disabled={disabled} onChange={(event) => { props.edit('enabled', String(event.target.checked)) }} />
              <span>{t(enabled ? 'on' : 'off')}</span>
            </label>
          </SettingsField>
          <NumericField id="fabric-speculation-concurrent" label={t('maxConcurrent')}
            hint={t('maxConcurrentHint')} field="maxConcurrent" state={state.maxConcurrent}
            disabled={disabled} props={props} />
          <NumericField id="fabric-speculation-entries" label={t('maxEntries')}
            hint={t('maxEntriesHint')} field="maxEntries" state={state.maxEntries}
            disabled={disabled} props={props} />
          <NumericField id="fabric-speculation-buffer" label={t('maxBufferBytes')}
            hint={t('maxBufferBytesHint')} field="maxBufferBytes" state={state.maxBufferBytes}
            disabled={disabled} props={props} />
          <NumericField id="fabric-speculation-retained" label={t('maxRetainedBytes')}
            hint={t('maxRetainedBytesHint')} field="maxRetainedBytes" state={state.maxRetainedBytes}
            disabled={disabled} props={props} />
          <NumericField id="fabric-speculation-ttl" label={t('entryTtlMs')}
            hint={t('entryTtlMsHint')} field="entryTtlMs" state={state.entryTtlMs}
            disabled={disabled} props={props} />
          <p className={css.sessionHint}>{t('liveHint')}</p>
          {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
          <div className={css.footer}>
            <button type="button" className={css.discard} disabled={!state.dirty || state.saving}
              onClick={props.discard}>{t('discard')}</button>
            <button type="button" className={css.save}
              disabled={!state.dirty || state.invalid || state.saving || !state.writable}
              onClick={props.save}>{t(state.saving ? 'saving' : 'save')}</button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function NumericField(input: {
  id: string
  label: string
  hint: string
  field: ToolSpeculationSettingsField
  state: ToolSpeculationFieldState
  disabled: boolean
  props: SpeculationSettingsCardProps
}) {
  const { t } = input.props
  return (
    <SettingsField id={input.id} label={input.label} hint={input.hint} field={input.field}
      state={input.state} disabled={input.disabled} resetLabel={t('reset')}
      overriddenLabel={t('overridden')} invalidLabel={t('invalid')} onReset={input.props.resetField}>
      <input id={input.id} className={input.state.invalid ? css.inputInvalid : css.input}
        type="text" inputMode="numeric" aria-invalid={input.state.invalid || undefined}
        value={input.state.text} disabled={input.disabled}
        onChange={(event) => { input.props.edit(input.field, event.target.value) }} />
    </SettingsField>
  )
}

function SettingsField(input: {
  id: string
  label: string
  hint: string
  field: ToolSpeculationSettingsField
  state: ToolSpeculationFieldState
  disabled: boolean
  resetLabel: string
  overriddenLabel: string
  invalidLabel: string
  onReset(field: ToolSpeculationSettingsField): void
  children: ReactNode
}) {
  return (
    <div className={css.field}>
      <div className={css.fieldHead}>
        <label className={css.label} htmlFor={input.id}>{input.label}</label>
        {input.state.overridden ? (
          <span className={css.badges}>
            <span className={css.badge}>{input.overriddenLabel}</span>
            <button type="button" className={css.reset} disabled={input.disabled}
              onClick={() => { input.onReset(input.field) }}>{input.resetLabel}</button>
          </span>
        ) : null}
      </div>
      {input.children}
      <p className={input.state.invalid ? css.invalid : css.hint}>
        {input.state.invalid ? input.invalidLabel : input.hint}
      </p>
    </div>
  )
}
