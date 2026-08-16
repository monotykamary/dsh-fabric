import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  FabricActivityRecord,
  FabricGraphNode,
} from '@dsh-fabric/protocol'
import { buildFabricClientModel } from './model.ts'
import { actionLabel, activityKindLabel, formatDuration, kindLabel, statusLabel } from './labels.ts'
import type { FabricControls } from './types.ts'
import css from './fabric.module.css'

/** Complete props delivered to the Fabric conversation view. */
export type FabricViewProps = ConvViewProps & InjectFace<FabricControls> & PropsLocale<'fabric'>

/** Render the selected lineage as Activity and Topology views. */
export function FabricView({ useSessions, sessionId, openNode, refreshCatalogs, t }: FabricViewProps) {
  const sessions = useSessions(value => value)
  const model = useMemo(
    () => buildFabricClientModel(sessions, sessionId, Date.now()),
    [sessionId, sessions],
  )
  const [mode, setMode] = useState<'activity' | 'topology'>('topology')
  const [selected, setSelected] = useState<string | null>(null)
  const catalogKey = model?.graph.nodes
    .flatMap(node => node.sessionId === undefined ? [] : [node.sessionId])
    .toSorted()
    .join('\u0000') ?? ''

  useEffect(() => {
    if (catalogKey !== '') refreshCatalogs(catalogKey.split('\u0000'))
  }, [catalogKey, refreshCatalogs])

  useEffect(() => {
    if (model === null) return
    if (selected === null || !model.graph.nodes.some(node => node.id === selected)) {
      setSelected(model.graph.rootId)
    }
  }, [model, selected])

  if (model === null) {
    return <div className={css.empty}>{t('view.empty')}</div>
  }

  const selectedNode = model.graph.nodes.find(node => node.id === selected) ?? model.graph.nodes[0]
  return (
    <section className={css.view} aria-label={t('view.aria')}>
      <header className={css.toolbar}>
        <div>
          <h2 className={css.title}>Fabric</h2>
          <p className={css.subtitle}>{t('view.summary', { nodes: model.graph.nodes.length, active: model.active.length })}</p>
        </div>
        <div className={css.tabs} role="tablist" aria-label={t('tabs.aria')}>
          <button
            className={mode === 'activity' ? css.tabActive : css.tab}
            type="button"
            role="tab"
            aria-selected={mode === 'activity'}
            onClick={() => { setMode('activity') }}
          >{t('tabs.activity')}</button>
          <button
            className={mode === 'topology' ? css.tabActive : css.tab}
            type="button"
            role="tab"
            aria-selected={mode === 'topology'}
            onClick={() => { setMode('topology') }}
          >{t('tabs.topology')}</button>
        </div>
      </header>

      <div className={css.content}>
        <div className={css.primary}>
          {mode === 'activity'
            ? <ActivityList activities={model.activity} nodes={model.graph.nodes} onSelect={node => { setSelected(node.id) }} t={t} />
            : (
              <div className={css.canvas}>
                <svg
                  className={css.graph}
                  viewBox={`0 0 ${model.layout.width} ${model.layout.height}`}
                  role="tree"
                  aria-label={t('graph.aria')}
                >
                  {model.graph.edges.map((edge) => {
                    const source = model.layout.nodes.find(item => item.node.id === edge.source)
                    const target = model.layout.nodes.find(item => item.node.id === edge.target)
                    if (source === undefined || target === undefined) return null
                    const middle = (source.y + target.y) / 2
                    return <path
                      className={css.edge}
                      data-kind={edge.kind}
                      d={`M ${source.x} ${source.y + 30} V ${middle} H ${target.x} V ${target.y - 30}`}
                      key={edge.id}
                    />
                  })}
                  {model.layout.nodes.map(({ node, x, y }) => (
                    <GraphNode
                      key={node.id}
                      node={node}
                      x={x}
                      y={y}
                      selected={node.id === selectedNode?.id}
                      onSelect={() => { setSelected(node.id) }}
                      t={t}
                      {...node.sessionId === undefined ? {} : { onOpen: () => { void openNode(node.sessionId as string) } }}
                    />
                  ))}
                </svg>
              </div>
            )}
        </div>
        {selectedNode === undefined ? null : (
          <NodeDetails
            node={selectedNode}
            t={t}
            {...selectedNode.sessionId === undefined ? {} : { onOpen: () => { void openNode(selectedNode.sessionId as string) } }}
          />
        )}
      </div>
    </section>
  )
}

function GraphNode({ node, x, y, selected, onSelect, onOpen, t }: {
  node: FabricGraphNode
  x: number
  y: number
  selected: boolean
  onSelect: () => void
  onOpen?: () => void
  t: TranslateNS<'fabric'>
}) {
  const activate = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' && onOpen !== undefined) onOpen()
    if (event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }
  return (
    <g
      className={selected ? css.graphNodeSelected : css.graphNode}
      data-status={node.status}
      transform={`translate(${x - 82} ${y - 30})`}
      role="treeitem"
      tabIndex={0}
      aria-label={t('node.aria', { label: node.label, status: statusLabel(node.status, t) })}
      onClick={onSelect}
      {...onOpen === undefined ? {} : { onDoubleClick: onOpen }}
      onKeyDown={activate}
    >
      <title>{node.label}</title>
      <rect className={css.nodeBody} width="164" height="60" rx="12" />
      <circle className={css.statusDot} cx="15" cy="18" r="5" />
      <text className={css.nodeLabel} x="27" y="22">{truncate(node.label, 18)}</text>
      <text className={css.nodeMeta} x="15" y="44">
        {kindLabel(node.kind, t)}{node.jobCount > 0 ? ` · ${t('node.jobs', { count: node.jobCount })}` : ''}
      </text>
    </g>
  )
}

function ActivityList({ activities, nodes, onSelect, t }: {
  activities: readonly FabricActivityRecord[]
  nodes: readonly FabricGraphNode[]
  onSelect: (node: FabricGraphNode) => void
  t: TranslateNS<'fabric'>
}) {
  return (
    <ul className={css.activityList}>
      {activities.map((activity) => {
        const node = activity.nodeId === undefined ? undefined : nodes.find(candidate => candidate.id === activity.nodeId)
        return (
          <li className={css.activityRow} data-status={activity.status} key={activity.id}>
            <button
              type="button"
              className={css.activityButton}
              disabled={node === undefined}
              onClick={() => { if (node !== undefined) onSelect(node) }}
            >
              <span className={css.activityDot} />
              <span className={css.activityCopy}>
                <strong>{activity.label}</strong>
                <small>{actionLabel(activity.action, t)} · {statusLabel(activity.status, t)}{activity.detail === undefined ? '' : ` · ${activity.detail}`}</small>
              </span>
              <span className={css.activityMetric}>{activityKindLabel(activity.kind, t)}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function NodeDetails({ node, onOpen, t }: { node: FabricGraphNode; onOpen?: () => void; t: TranslateNS<'fabric'> }) {
  return (
    <aside className={css.details} aria-label={t('details.aria')}>
      <span className={css.eyebrow}>{kindLabel(node.kind, t)}</span>
      <h3>{node.label}</h3>
      <dl className={css.metrics}>
        <div><dt>{t('details.status')}</dt><dd>{statusLabel(node.status, t)}</dd></div>
        <div><dt>{t('details.tokens')}</dt><dd>{node.tokens === undefined ? '—' : formatTokens(node.tokens)}</dd></div>
        <div><dt>{t('details.duration')}</dt><dd>{node.durationMs === undefined ? '—' : formatDuration(node.durationMs, t)}</dd></div>
        <div><dt>{t('details.jobs')}</dt><dd>{node.jobCount}</dd></div>
      </dl>
      {node.detail === undefined ? null : <p className={css.nodeDetail}>{node.detail}</p>}
      {onOpen === undefined ? null : <button className={css.openButton} type="button" onClick={onOpen}>{t('details.open')}</button>}
    </aside>
  )
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function formatTokens(value: number): string {
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
}
