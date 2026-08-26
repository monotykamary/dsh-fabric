import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react'
import type {} from '@monotykamary/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type { FabricActivityRecord, FabricGraphNode, FabricParticipantRecord } from 'dsh-fabric-protocol'
import { buildFabricClientModel, navigateFabricTopology, type FabricNavigationDirection } from './model.ts'
import { DelegationView } from './DelegationView.tsx'
import { actionLabel, activityKindLabel, formatDuration, kindLabel, statusLabel, topologyNodeLabel } from './labels.ts'
import type { FabricControls } from './types.ts'
import css from './fabric.module.css'

/** Zoom bounds and behavior for the topology canvas. */
const MIN_SCALE = 0.1
const MAX_SCALE = 3
const ZOOM_STEP = 1.25
const VIEWPORT_INSET = 24

/** Props supplied by the conversation-view registry and Fabric control injection. */
export type FabricViewProps = PropsRuntime<'conversation.view'> & InjectFace<FabricControls> & PropsLocale<'fabric'>

type FabricTab = 'delegations' | 'activity' | 'topology'

/** Render Activity and Topology tabs for the selected session's Fabric family. */
export function FabricView({ useSessions, sessionId, openNode, refreshCatalogs, cancelWorker, messageWorker, t }: FabricViewProps) {
  const sessions = useSessions(value => value)
  const model = useMemo(() => buildFabricClientModel(sessions, sessionId, Date.now()), [sessionId, sessions])
  const [tab, setTab] = useState<FabricTab>('delegations')
  const [selectedId, setSelectedId] = useState<string>()
  const nodeRefs = useRef(new Map<string, SVGGElement>())
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  const [scale, setScale] = useState<number>()
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const userZoomedRef = useRef(false)
  const layoutKeyRef = useRef('')
  const zoomAtRef = useRef<(target: number, anchorX: number, anchorY: number) => void>(() => {})
  const scaleRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const panRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number }>()
  const touchGestureRef = useRef<
    | { kind: 'pan'; identifier: number; x: number; y: number; offsetX: number; offsetY: number }
    | { kind: 'pinch'; distance: number; scale: number; contentX: number; contentY: number }
  >()
  const [isPanning, setIsPanning] = useState(false)
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

  // --- viewport and zoom ---
  const viewportObserverRef = useRef<ResizeObserver | null>(null)
  const onCanvasWheelRef = useRef<(event: WheelEvent) => void>(() => {})

  useEffect(() => {
    onCanvasWheelRef.current = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = canvasRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      zoomAtRef.current(
        scaleRef.current * Math.exp(-event.deltaY * 0.002),
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    }
  })

  // Callback ref: (re)attach viewport measurement and the non-passive wheel
  // listener whenever the canvas mounts, surviving late topology and tab swaps.
  const attachCanvas = useCallback((element: HTMLDivElement | null): void => {
    viewportObserverRef.current?.disconnect()
    viewportObserverRef.current = null
    const previous = canvasRef.current
    if (previous !== null) previous.removeEventListener('wheel', onCanvasWheelRef.current)
    canvasRef.current = element
    if (element === null) return
    const measure = (): void => {
      setViewport(previousViewport => {
        const width = element.clientWidth
        const height = element.clientHeight
        return previousViewport !== null && previousViewport.width === width && previousViewport.height === height
          ? previousViewport
          : { width, height }
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    viewportObserverRef.current = observer
    element.addEventListener('wheel', onCanvasWheelRef.current, { passive: false })
  }, [])

  const layoutKey = model === null ? '' : `${model.layout.width}x${model.layout.height}`
  // A degenerate viewport (canvas hidden or not yet laid out) is "unmeasured":
  // fitting into 0x0 would clamp to MIN_SCALE and paint a shrunken graph.
  const fitScale = model === null || viewport === null || viewport.width <= 0 || viewport.height <= 0
    ? undefined
    : Math.min(1, Math.max(MIN_SCALE, Math.min(
        (viewport.width - VIEWPORT_INSET * 2) / model.layout.width,
        (viewport.height - VIEWPORT_INSET * 2) / model.layout.height,
      )))

  const zoomAt = (target: number, anchorX: number, anchorY: number): void => {
    if (model === null || viewport === null) return
    const current = scale ?? fitScale ?? 1
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, target))
    const contentX = (anchorX - offset.x) / current
    const contentY = (anchorY - offset.y) / current
    const nextOffset = {
      x: anchorX - contentX * next,
      y: anchorY - contentY * next,
    }
    userZoomedRef.current = true
    scaleRef.current = next
    offsetRef.current = nextOffset
    setScale(next)
    setOffset(nextOffset)
  }
  const zoomIn = (): void => {
    if (viewport === null) return
    zoomAt((scale ?? fitScale ?? 1) * ZOOM_STEP, viewport.width / 2, viewport.height / 2)
  }
  const zoomOut = (): void => {
    if (viewport === null) return
    zoomAt((scale ?? fitScale ?? 1) / ZOOM_STEP, viewport.width / 2, viewport.height / 2)
  }
  const fitView = (): void => {
    if (model === null || viewport === null || fitScale === undefined) return
    const nextOffset = {
      x: (viewport.width - model.layout.width * fitScale) / 2,
      y: (viewport.height - model.layout.height * fitScale) / 2,
    }
    userZoomedRef.current = false
    scaleRef.current = fitScale
    offsetRef.current = nextOffset
    setScale(fitScale)
    setOffset(nextOffset)
  }
  const zoomOnDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as Element
    if (target.closest('[data-fabric-node]') !== null) return
    const rect = event.currentTarget.getBoundingClientRect()
    zoomAt(
      (scaleRef.current || fitScale || 1) * ZOOM_STEP,
      event.clientX - rect.left,
      event.clientY - rect.top,
    )
  }

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch' || event.button !== 0) return
    const target = event.target as Element
    if (target.closest('[data-fabric-node]') !== null) return
    const canvas = event.currentTarget
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    }
    userZoomedRef.current = true
    canvas.setPointerCapture(event.pointerId)
    setIsPanning(true)
    event.preventDefault()
  }
  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (pan === undefined || pan.pointerId !== event.pointerId) return
    const nextOffset = {
      x: pan.offsetX + event.clientX - pan.x,
      y: pan.offsetY + event.clientY - pan.y,
    }
    offsetRef.current = nextOffset
    setOffset(nextOffset)
    event.preventDefault()
  }
  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId !== event.pointerId) return
    panRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setIsPanning(false)
  }
  const beginTouchGesture = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const touches = event.touches
    const rect = event.currentTarget.getBoundingClientRect()
    if (touches.length === 2) {
      const first = touches[0]
      const second = touches[1]
      if (first === undefined || second === undefined) return
      const midpointX = (first.clientX + second.clientX) / 2 - rect.left
      const midpointY = (first.clientY + second.clientY) / 2 - rect.top
      const currentScale = scaleRef.current
      touchGestureRef.current = {
        kind: 'pinch',
        distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        scale: currentScale,
        contentX: (midpointX - offsetRef.current.x) / currentScale,
        contentY: (midpointY - offsetRef.current.y) / currentScale,
      }
      userZoomedRef.current = true
      setIsPanning(true)
      event.preventDefault()
      return
    }
    const touch = touches[0]
    const target = event.target as Element
    if (touch === undefined || target.closest('[data-fabric-node]') !== null) return
    touchGestureRef.current = {
      kind: 'pan',
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      offsetX: offsetRef.current.x,
      offsetY: offsetRef.current.y,
    }
    userZoomedRef.current = true
    setIsPanning(true)
  }
  const moveTouchGesture = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const gesture = touchGestureRef.current
    if (gesture === undefined) return
    if (gesture.kind === 'pinch' && event.touches.length === 2) {
      const first = event.touches[0]
      const second = event.touches[1]
      if (first === undefined || second === undefined || gesture.distance === 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
        gesture.scale * Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY) / gesture.distance,
      ))
      const nextOffset = {
        x: (first.clientX + second.clientX) / 2 - rect.left - gesture.contentX * nextScale,
        y: (first.clientY + second.clientY) / 2 - rect.top - gesture.contentY * nextScale,
      }
      scaleRef.current = nextScale
      offsetRef.current = nextOffset
      setScale(nextScale)
      setOffset(nextOffset)
      event.preventDefault()
      return
    }
    if (gesture.kind !== 'pan' || event.touches.length !== 1) return
    const touch = Array.from(event.touches).find(value => value.identifier === gesture.identifier)
    if (touch === undefined) return
    const nextOffset = {
      x: gesture.offsetX + touch.clientX - gesture.x,
      y: gesture.offsetY + touch.clientY - gesture.y,
    }
    offsetRef.current = nextOffset
    setOffset(nextOffset)
    event.preventDefault()
  }
  const endTouchGesture = (event: ReactTouchEvent<HTMLDivElement>): void => {
    touchGestureRef.current = undefined
    const touch = event.touches[0]
    if (touch === undefined) {
      setIsPanning(false)
      return
    }
    touchGestureRef.current = {
      kind: 'pan',
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      offsetX: offsetRef.current.x,
      offsetY: offsetRef.current.y,
    }
  }

  // Fit the whole graph by default; once the user zooms, keep their view and
  // only reset to fit when the graph itself changes shape. Runs as a layout
  // effect so the fit lands before the browser paints: the canvas mounts at
  // scale 1, and a passive effect would paint an uncentered, unscaled graph
  // for a frame (the flash when opening the Fabric tab).
  useLayoutEffect(() => {
    if (model === null || viewport === null || fitScale === undefined) return
    if (layoutKey !== layoutKeyRef.current) {
      layoutKeyRef.current = layoutKey
      userZoomedRef.current = false
    }
    if (scale === undefined || !userZoomedRef.current) {
      userZoomedRef.current = false
      setScale(fitScale)
      setOffset({
        x: Math.max(0, (viewport.width - model.layout.width * fitScale) / 2),
        y: Math.max(0, (viewport.height - model.layout.height * fitScale) / 2),
      })
    }
  }, [layoutKey, fitScale, viewport, scale, model])

  // Keep refs current so the stable canvas listeners always call the latest zoom closure.
  useEffect(() => {
    zoomAtRef.current = zoomAt
    scaleRef.current = scale ?? fitScale ?? 1
    offsetRef.current = offset
  })

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
            <button type="button" role="tab" aria-selected={tab === 'delegations'} onClick={() => { setTab('delegations') }}>{t('tabs.delegations')} {model.activeWorkerCount === 0 ? '' : `(${model.activeWorkerCount})`}</button>
            <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => { setTab('activity') }}>{t('tabs.activity')}</button>
            <button type="button" role="tab" aria-selected={tab === 'topology'} onClick={() => { setTab('topology') }}>{t('tabs.topology')}</button>
          </div>
        </div>
      </header>
      {tab === 'delegations'
        ? <DelegationView delegations={model.delegations} openNode={openNode} cancelWorker={cancelWorker} messageWorker={messageWorker} t={t} />
        : tab === 'activity'
          ? <ActivityList records={model.activity} selectableNodeIds={graphNodeIds} onSelectNode={(id) => { setSelectedId(id); setTab('topology') }} t={t} />
        : (
          <div className={css.topologyShell}>
            <div className={css.canvasColumn}>
              <div
                ref={attachCanvas}
                className={css.canvas}
                data-panning={isPanning}
                onPointerDown={beginPan}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                onDoubleClick={zoomOnDoubleClick}
                onTouchStart={beginTouchGesture}
                onTouchMove={moveTouchGesture}
                onTouchEnd={endTouchGesture}
                onTouchCancel={endTouchGesture}
              >
                {scale === undefined ? null : (
                <div
                  className={css.graphViewport}
                  style={{
                    width: model.layout.width,
                    height: model.layout.height,
                    transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale ?? 1})`,
                  }}
                >
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
                )}
              </div>
              <div className={css.zoomControls} role="group" aria-label={t('zoom.aria')} title={t('zoom.wheel')}>
                <button type="button" onClick={zoomOut} aria-label={t('zoom.out')} title={t('zoom.out')}>−</button>
                <span className={css.zoomLevel} aria-live="polite">{Math.round((scale ?? fitScale ?? 1) * 100)}%</span>
                <button type="button" onClick={zoomIn} aria-label={t('zoom.in')} title={t('zoom.in')}>+</button>
                <button type="button" className={css.zoomFitButton} onClick={fitView} aria-label={t('zoom.fit')} title={t('zoom.fit')}>{t('zoom.fit')}</button>
              </div>
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
      data-fabric-node=""
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
