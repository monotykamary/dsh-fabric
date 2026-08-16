import { useEffect, useMemo, useRef, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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

  if (model === null || model.graph.nodes.length <= 1) return null

  const running = model.graph.nodes.filter(node => node.status === 'running')
  const related = model.graph.nodes.filter(node => node.sessionId !== sessionId)
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
            {related.map(node => (
              <li key={node.id}>
                {node.sessionId === undefined
                  ? (
                    <div className={css.headerNode}>
                      <span className={css.headerNodeDot} data-status={node.status} />
                      <span>{node.label}</span>
                      <small>{statusLabel(node.status, t)}</small>
                    </div>
                  )
                  : (
                    <button type="button" onClick={() => { void openNode(node.sessionId as string); setExpanded(false) }}>
                      <span className={css.headerNodeDot} data-status={node.status} />
                      <span>{node.label}</span>
                      <small>{statusLabel(node.status, t)}</small>
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
