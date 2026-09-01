/** Fabric-owned settings card contributed to the Harness Plugins section. */

import { useState, type ReactNode } from 'react'
import { ChevronDown } from '@monotykamary/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@monotykamary/dsh-client-ui-slots'
import type {} from '@monotykamary/dsh-client-ui-settings-plugins/client'
import {
  FABRIC_SCHEMA_MODES,
  type FabricSchemaFieldState,
  type FabricSchemaSettingsFace,
  type FabricSchemaSettingsField,
} from './schema-settings-controller.ts'
import css from './SchemaSettingsCard.module.css'

export type SchemaSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'fabric.settings'>
  & InjectFace<FabricSchemaSettingsFace>

export function SchemaSettingsCard(props: SchemaSettingsCardProps) {
  const [open, setOpen] = useState(false)
  const state = props.useSchemaSettings(snapshot => snapshot)
  const { t } = props
  if (!state.available) return null
  const disabled = !state.writable || state.saving
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
          <SettingsField id="fabric-schema-mode" label={t('mode')} hint={t('modeHint')} field="mode"
            state={state.mode} disabled={disabled} resetLabel={t('reset')} overriddenLabel={t('overridden')}
            invalidLabel={t('invalid')} onReset={props.resetField}>
            <select id="fabric-schema-mode" className={css.input} value={state.mode.text} disabled={disabled}
              onChange={(event) => { props.edit('mode', event.target.value) }}>
              {FABRIC_SCHEMA_MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </SettingsField>
          <NumericField id="fabric-schema-ttl" label={t('ttl')} hint={t('ttlHint')}
            field="certificateTtlMs" state={state.certificateTtlMs} disabled={disabled} props={props} />
          <NumericField id="fabric-schema-max-files" label={t('maxFiles')} hint={t('maxFilesHint')}
            field="maxFiles" state={state.maxFiles} disabled={disabled} props={props} />
          <NumericField id="fabric-schema-max-bytes" label={t('maxBytes')} hint={t('maxBytesHint')}
            field="maxBytes" state={state.maxBytes} disabled={disabled} props={props} />
          <p className={css.sessionHint}>{t('sessionHint')}</p>
          {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
          <div className={css.footer}>
            <button type="button" className={css.discard} disabled={!state.dirty || state.saving} onClick={props.discard}>{t('discard')}</button>
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
  field: FabricSchemaSettingsField
  state: FabricSchemaFieldState
  disabled: boolean
  props: SchemaSettingsCardProps
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
  field: FabricSchemaSettingsField
  state: FabricSchemaFieldState
  disabled: boolean
  resetLabel: string
  overriddenLabel: string
  invalidLabel: string
  onReset(field: FabricSchemaSettingsField): void
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
