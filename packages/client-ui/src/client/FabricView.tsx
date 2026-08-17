import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type {} from '@monotykamary/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type { FabricActivityRecord, FabricGraphNode, FabricParticipantRecord } from '@dsh-fabric/protocol'
import { buildFabricClientModel, navigateFabricTopology, type FabricNavigationDirection } from './model.ts'
import { actionLabel, activityKindLabel, formatDuration, kindLabel, statusLabel, topologyNodeLabel } from './labels.ts'
import type { FabricControls } from './types.ts'
import css from './fabric.module.css'

/** Props supplied by the conversation-view registry and Fabric control injection. */
export type FabricViewProps = PropsRuntime<'conversation.view'> & InjectFace<FabricControls> & PropsLocale<'fabric'>

type FabricTab = 'activity' | 'topology'

/** Render Activity and Topology tabs for the selected session's Fabric family. */
export function FabricView({ useSessions, sessionId, openNode, refreshCatalogs, t }: FabricViewProps) {
  const sessions = useSessions(value => value)
  const model = useMemo(() => buildFabricClientModel(sessions, sessionId, Date.now()), [sessionId, sessions])
  const [tab, setTab] = useState<FabricTab>('topology')
  const [selectedId, setSelectedId] = useState<string>()
  const nodeRefs = useRef(new Map<string, SVGGElement>())
  const catalogIds = model?.graph.nodes
    .flatMap(node => node.sessionId === undefined ? [] : [node.sessionId])
    .toSorted() ?? []
  const catalogKey = catalogIds.join('|')

  useEffect(() => {
    if (catalogKey !== '') refreshCatalogs(catalogKey.split('|'))
  }, [catalogKey, refreshCatalogs])

  useEffect(() => {
    if (model === null) return
    if (selectedId !== undefined && model.graph.nodes.some(node => node.id === selectedId)) return
    setSelectedId(model.graph.rootId)
  }, [model, selectedId])

  if (model === null) {
    return <section className={css.empty} aria-label={t('view.aria')}>{t('view.empty')}</section>
  }

  const resolvedSelectedId = selectedId !== undefined && model.graph.nodes.some(node => node.id === selectedId)
    ? selectedId
    : model.graph.rootId
  const selectedNode = model.graph.nodes.find(node => node.id === resolvedSelectedId)
    ?? model.graph.nodes.find(node => node.id === model.graph.rootId)
  const selectedParticipant = selectedNode?.participantId === undefined
    ? undefined
    : model.participants.find(participant => participant.id === selectedNode.participantId)
  const graphNodeIds = new Set(model.graph.nodes.map(node => String(node.id)))
  const focusNode = (nodeId: string): void => {
    requestAnimationFrame(() => {
      const element = nodeRefs.current.get(nodeId)
      element?.focus()
      element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
  const selectAndFocus = (nodeId: string): void => {
    setSelectedId(nodeId)
    focusNode(nodeId)
  }
  const navigate = (nodeId: string, direction: FabricNavigationDirection): void => {
    const next = navigateFabricTopology(model.layout, nodeId, direction)
    if (next !== undefined) selectAndFocus(next)
  }

  return (
    <section className={css.root} data-conversation-composer-overlay="" aria-label={t('view.aria')}>
      <header className={css.toolbar}>
        <div>
          <strong>Fabric</strong>
          <p className={css.subtitle}>{t('view.summary', {
            participants: model.participants.length,
            active: model.active.length,
            resources: model.resourceCount,
          })}</p>
        </div>
        <div className={css.toolbarAside}>
          <span className={css.keyboardHint}>{t('view.keyboardHint')}</span>
          <div className={css.tabs} role="tablist" aria-label={t('tabs.aria')}>
            <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => { setTab('activity') }}>{t('tabs.activity')}</button>
            <button type="button" role="tab" aria-selected={tab === 'topology'} onClick={() => { setTab('topology') }}>{t('tabs.topology')}</button>
          </div>
        </div>
      </header>
      {tab === 'activity'
        ? <ActivityList records={model.activity} selectableNodeIds={graphNodeIds} onSelectNode={(id) => { setSelectedId(id); setTab('topology') }} t={t} />
        : (
          <div className={css.topologyShell}>
            <div className={css.canvas}>
              <svg role="tree" aria-label={t('graph.aria')} width={model.layout.width} height={model.layout.height} viewBox={['0 0', model.layout.width, model.layout.height].join(' ')}>
                {model.graph.edges.map((edge) => {
                  const source = model.layout.nodes.find(value => value.node.id === edge.source)
                  const target = model.layout.nodes.find(value => value.node.id === edge.target)
                  if (source === undefined || target === undefined) return null
                  const direction = target.x >= source.x ? 1 : -1
                  const startX = source.x + direction * 82
                  const endX = target.x - direction * 82
                  const midpoint = (startX + endX) / 2
                  return (
                    <path
                      key={edge.id}
                      className={edge.role === 'traffic' ? css.edgeTraffic : css.edge}
                      aria-hidden="true"
                      data-kind={edge.kind}
                      data-role={edge.role ?? 'structure'}
                      d={['M', startX, source.y, 'C', midpoint, source.y, midpoint, target.y, endX, target.y].join(' ')}
                    />
                  )
                })}
                {model.layout.nodes.map((positioned) => {
                  const siblings = positioned.parentId === undefined
                    ? [positioned.node.id]
                    : model.layout.nodes.find(value => value.node.id === positioned.parentId)?.childIds ?? [positioned.node.id]
                  return (
                    <GraphNode
                      key={positioned.node.id}
                      node={positioned.node}
                      x={positioned.x}
                      y={positioned.y}
                      depth={positioned.depth}
                      position={Math.max(1, siblings.indexOf(positioned.node.id) + 1)}
                      setSize={siblings.length}
                      hasChildren={positioned.childIds.length > 0}
                      selected={positioned.node.id === resolvedSelectedId}
                      registerRef={(element) => {
                        if (element === null) nodeRefs.current.delete(positioned.node.id)
                        else nodeRefs.current.set(positioned.node.id, element)
                      }}
                      onSelect={() => { selectAndFocus(positioned.node.id) }}
                      onNavigate={direction => { navigate(positioned.node.id, direction) }}
                      {...positioned.node.sessionId === undefined ? {} : { onOpen: () => { void openNode(positioned.node.sessionId as string) } }}
                      t={t}
                    />
                  )
                })}
              </svg>
            </div>
            {selectedNode === undefined ? null : (
              <NodeDetails
                node={selectedNode}
                {...selectedParticipant === undefined ? {} : { participant: selectedParticipant }}
                {...selectedNode.sessionId === undefined ? {} : { onOpen: () => { void openNode(selectedNode.sessionId as string) } }}
                t={t}
              />
            )}
          </div>
        )}
    </section>
  )
}

function GraphNode({ node, x, y, depth, position, setSize, hasChildren, selected, registerRef, onSelect, onNavigate, onOpen, t }: {
  node: FabricGraphNode
  x: number
  y: number
  depth: number
  position: number
  setSize: number
  hasChildren: boolean
  selected: boolean
  registerRef: (element: SVGGElement | null) => void
  onSelect: () => void
  onNavigate: (direction: FabricNavigationDirection) => void
  onOpen?: () => void
  t: TranslateNS<'fabric'>
}) {
  const label = topologyNodeLabel(node, t)
  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    const key = event.key.toLowerCase()
    const direction = key === 'arrowleft' || key === 'h'
      ? 'parent'
      : key === 'arrowright' || key === 'l'
        ? 'child'
        : key === 'arrowup' || key === 'k'
          ? 'previous'
          : key === 'arrowdown' || key === 'j'
            ? 'next'
            : undefined
    if (direction !== undefined) {
      event.preventDefault()
      onNavigate(direction)
      return
    }
    if (event.key === 'Enter' && onOpen !== undefined) onOpen()
    if (event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }
  return (
    <g
      ref={registerRef}
      className={[css.node, selected ? css.nodeSelected : '', node.kind === 'group' ? css.nodeGroup : ''].filter(Boolean).join(' ')}
      data-kind={node.kind}
      transform={['translate(', x - 82, ' ', y - 30, ')'].join('')}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={position}
      aria-setsize={setSize}
      aria-expanded={hasChildren ? true : undefined}
      aria-current={selected ? 'true' : undefined}
      aria-label={t('node.aria', { label, status: statusLabel(node.status, t) })}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <rect className={css.nodeCard} width="164" height="60" rx={node.kind === 'group' ? 12 : 16} />
      <circle className={css.nodeIcon} data-status={node.status} cx="18" cy="20" r="5" />
      <foreignObject className={css.nodeLabelViewport} x="31" y="7" width="115" height="22" aria-hidden="true">
        <div className={css.nodeLabel}>{label}</div>
      </foreignObject>
      <foreignObject className={css.nodeMetaViewport} x="18" y="31" width="128" height="20" aria-hidden="true">
        <div className={css.nodeMetaRow}>
          <span className={css.nodeMeta}>{kindLabel(node.kind, t)} · {statusLabel(node.status, t)}</span>
          {node.participantId !== undefined && node.jobCount > 0 ? <span className={css.nodeJobs}>{t('node.jobs', { count: node.jobCount })}</span> : null}
        </div>
      </foreignObject>
      <title>{label}</title>
    </g>
  )
}

function NodeDetails({ node, participant, onOpen, t }: {
  node: FabricGraphNode
  participant?: FabricParticipantRecord
  onOpen?: () => void
  t: TranslateNS<'fabric'>
}) {
  const label = topologyNodeLabel(node, t)
  return (
    <aside className={css.details} aria-label={t('details.aria')}>
      <small>{kindLabel(node.kind, t)}</small>
      <h2>{label}</h2>
      {label === node.label ? null : <p className={css.detailText}>{node.label}</p>}
      {node.detail === undefined ? null : <p className={css.detailText}>{node.detail}</p>}
      <dl>
        <div><dt>{t('details.status')}</dt><dd>{statusLabel(node.status, t)}</dd></div>
        {participant === undefined ? null : (
          <>
            <div><dt>{t('details.residency')}</dt><dd>{t(participant.residency === 'durable' ? 'residency.durable' : 'residency.session')}</dd></div>
            <div><dt>{t('details.capabilities')}</dt><dd>{participant.capabilities.map(capability => t(capability === 'send-message' ? 'capability.sendMessage' : 'capability.openSession')).join(', ') || '—'}</dd></div>
          </>
        )}
        <div><dt>{t('details.tokens')}</dt><dd>{node.tokens?.toLocaleString() ?? '—'}</dd></div>
        <div><dt>{t('details.duration')}</dt><dd>{node.durationMs === undefined ? '—' : formatDuration(node.durationMs, t)}</dd></div>
        <div><dt>{t('details.jobs')}</dt><dd>{node.jobCount.toLocaleString()}</dd></div>
      </dl>
      {onOpen === undefined ? null : <button type="button" onClick={onOpen}>{t('details.open')}</button>}
    </aside>
  )
}

function ActivityList({ records, selectableNodeIds, onSelectNode, t }: {
  records: readonly FabricActivityRecord[]
  selectableNodeIds: ReadonlySet<string>
  onSelectNode: (id: string) => void
  t: TranslateNS<'fabric'>
}) {
  return (
    <ol className={css.activityList}>
      {records.map((record) => {
        const selectable = record.nodeId !== undefined && selectableNodeIds.has(record.nodeId)
        return (
          <li key={record.id}>
            <button type="button" disabled={!selectable} onClick={() => { if (selectable && record.nodeId !== undefined) onSelectNode(record.nodeId) }}>
              <span className={css.activityRail}><span data-status={record.status} /></span>
              <span className={css.activityBody}>
                <strong>{record.label}</strong>
                <span>{activityKindLabel(record.kind, t)} · {actionLabel(record.action, t)} · {statusLabel(record.status, t)}</span>
                {record.detail === undefined ? null : <small>{record.detail}</small>}
              </span>
              <time>{new Date(record.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
