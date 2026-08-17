import { useEffect, useMemo, useRef, useState } from 'react'
import type {} from '@monotykamary/dsh-client-ui-conversation/client'
import { IconChevronDownOutline14 } from '@monotykamary/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@monotykamary/dsh-client-ui-slots'
import { buildFabricClientModel } from './model.ts'
import { statusLabel } from './labels.ts'
import type { FabricControls } from './types.ts'
import css from './fabric.module.css'

/** Props supplied to the compact Fabric session-header action. */
export type FabricHeaderActionProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<FabricControls> & PropsLocale<'fabric'>

/** Show a compact active-lineage summary without duplicating the conversation view. */
export function FabricHeaderAction({ useSessions, sessionId, openNode, refreshCatalogs, t }: FabricHeaderActionProps) {
  const sessions = useSessions(value => value)
  const model = useMemo(() => buildFabricClientModel(sessions, sessionId, Date.now()), [sessionId, sessions])
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const catalogKey = model?.graph.nodes
    .flatMap(node => node.sessionId === undefined ? [] : [node.sessionId])
    .toSorted()
    .join('\u0000') ?? ''

  useEffect(() => {
    if (catalogKey !== '') refreshCatalogs(catalogKey.split('\u0000'))
  }, [catalogKey, refreshCatalogs])

  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [expanded])

  if (model === null || model.participants.length <= 1) return null

  const related = model.participants.filter(participant => participant.sessionId !== sessionId)
  const running = related.filter(participant => participant.status === 'running')
  return (
    <div ref={rootRef} className={css.headerAction}>
      <button
        className={css.headerButton}
        type="button"
        aria-expanded={expanded}
        aria-label={t('header.aria', { count: related.length, running: running.length })}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={running.length > 0 ? css.headerPulse : css.headerIdle} />
        <span>Fabric · {related.length}</span>
        <IconChevronDownOutline14 className={expanded ? css.headerChevronOpen : css.headerChevron} />
      </button>
      {expanded ? (
        <div className={css.headerPopover} role="dialog" aria-label={t('header.popover.aria')}>
          <strong>{t('header.title')}</strong>
          <p className={css.headerSummary}>{t(related.length === 1 ? 'header.summary.one' : 'header.summary.many', { count: related.length, running: running.length })}</p>
          <ul>
            {related.map(participant => (
              <li key={participant.id}>
                {participant.sessionId === undefined
                  ? (
                    <div className={css.headerNode}>
                      <span className={css.headerNodeDot} data-status={participant.status} />
                      <span>{participant.name}</span>
                      <small>{statusLabel(participant.status, t)}</small>
                    </div>
                  )
                  : (
                    <button type="button" onClick={() => { void openNode(participant.sessionId as string); setExpanded(false) }}>
                      <span className={css.headerNodeDot} data-status={participant.status} />
                      <span>{participant.name}</span>
                      <small>{statusLabel(participant.status, t)}</small>
                    </button>
                  )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
