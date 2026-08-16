import { useEffect, useMemo, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { buildFabricClientModel } from './model.ts'
import type { FabricControls } from './types.ts'
import css from './fabric.module.css'

/** Props supplied to the compact Fabric session-header action. */
export type FabricHeaderActionProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<FabricControls>

/** Show a compact active-lineage summary without duplicating the conversation view. */
export function FabricHeaderAction({ useSessions, sessionId, openNode, refreshCatalogs }: FabricHeaderActionProps) {
  const sessions = useSessions(value => value)
  const model = useMemo(() => buildFabricClientModel(sessions, sessionId, Date.now()), [sessionId, sessions])
  const [expanded, setExpanded] = useState(false)
  const catalogKey = model?.graph.nodes
    .flatMap(node => node.sessionId === undefined ? [] : [node.sessionId])
    .toSorted()
    .join('\u0000') ?? ''

  useEffect(() => {
    if (catalogKey !== '') refreshCatalogs(catalogKey.split('\u0000'))
  }, [catalogKey, refreshCatalogs])

  if (model === null || model.graph.nodes.length <= 1) return null

  const running = model.graph.nodes.filter(node => node.status === 'running')
  const navigable = model.graph.nodes.filter(node => node.sessionId !== undefined && node.sessionId !== sessionId)
  return (
    <div className={css.headerAction}>
      <button
        className={css.headerButton}
        type="button"
        aria-expanded={expanded}
        aria-label={`Fabric 拓扑，${running.length} 个节点运行中`}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={running.length > 0 ? css.headerPulse : css.headerIdle} />
        Fabric · {model.graph.nodes.length - 1}
      </button>
      {expanded ? (
        <div className={css.headerPopover} role="dialog" aria-label="Fabric 会话节点">
          <strong>Fabric 拓扑</strong>
          <ul>
            {navigable.map(node => (
              <li key={node.id}>
                <button type="button" onClick={() => { openNode(node.sessionId as string); setExpanded(false) }}>
                  <span className={css.headerNodeDot} data-status={node.status} />
                  <span>{node.label}</span>
                  <small>{node.status === 'running' ? '运行中' : '非活动'}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
