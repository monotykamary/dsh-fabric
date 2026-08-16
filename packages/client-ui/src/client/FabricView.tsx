import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  FabricActivityRecord,
  FabricGraphNode,
  FabricNodeKind,
  FabricNodeStatus,
} from '@dsh-fabric/protocol'
import { buildFabricClientModel } from './model.ts'
import type { FabricControls } from './types.ts'
import css from './fabric.module.css'

/** Complete props delivered to the Fabric conversation view. */
export type FabricViewProps = ConvViewProps & InjectFace<FabricControls>

/** Render the selected lineage as Activity and Topology views. */
export function FabricView({ useSessions, sessionId, openNode, refreshCatalogs }: FabricViewProps) {
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
    return <div className={css.empty}>当前会话尚无可用的 Fabric 拓扑。</div>
  }

  const selectedNode = model.graph.nodes.find(node => node.id === selected) ?? model.graph.nodes[0]
  return (
    <section className={css.view} aria-label="Fabric 编排视图">
      <header className={css.toolbar}>
        <div>
          <h2 className={css.title}>Fabric</h2>
          <p className={css.subtitle}>{model.graph.nodes.length} 个拓扑节点 · {model.active.length} 个活动节点</p>
        </div>
        <div className={css.tabs} role="tablist" aria-label="Fabric 视图">
          <button
            className={mode === 'activity' ? css.tabActive : css.tab}
            type="button"
            role="tab"
            aria-selected={mode === 'activity'}
            onClick={() => { setMode('activity') }}
          >活动</button>
          <button
            className={mode === 'topology' ? css.tabActive : css.tab}
            type="button"
            role="tab"
            aria-selected={mode === 'topology'}
            onClick={() => { setMode('topology') }}
          >拓扑</button>
        </div>
      </header>

      <div className={css.content}>
        <div className={css.primary}>
          {mode === 'activity'
            ? <ActivityList activities={model.activity} nodes={model.graph.nodes} onSelect={node => { setSelected(node.id) }} />
            : (
              <div className={css.canvas}>
                <svg
                  className={css.graph}
                  viewBox={`0 0 ${model.layout.width} ${model.layout.height}`}
                  role="tree"
                  aria-label="会话、工作流与 Fabric Mesh 拓扑"
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
                      {...node.sessionId === undefined ? {} : { onOpen: () => { openNode(node.sessionId as string) } }}
                    />
                  ))}
                </svg>
              </div>
            )}
        </div>
        {selectedNode === undefined ? null : (
          <NodeDetails
            node={selectedNode}
            {...selectedNode.sessionId === undefined ? {} : { onOpen: () => { openNode(selectedNode.sessionId as string) } }}
          />
        )}
      </div>
    </section>
  )
}

function GraphNode({ node, x, y, selected, onSelect, onOpen }: {
  node: FabricGraphNode
  x: number
  y: number
  selected: boolean
  onSelect: () => void
  onOpen?: () => void
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
      aria-label={`${node.label}，${statusLabel(node.status)}`}
      onClick={onSelect}
      {...onOpen === undefined ? {} : { onDoubleClick: onOpen }}
      onKeyDown={activate}
    >
      <title>{node.label}</title>
      <rect className={css.nodeBody} width="164" height="60" rx="12" />
      <circle className={css.statusDot} cx="15" cy="18" r="5" />
      <text className={css.nodeLabel} x="27" y="22">{truncate(node.label, 18)}</text>
      <text className={css.nodeMeta} x="15" y="44">
        {kindLabel(node.kind)}{node.jobCount > 0 ? ` · ${node.jobCount} 个任务` : ''}
      </text>
    </g>
  )
}

function ActivityList({ activities, nodes, onSelect }: {
  activities: readonly FabricActivityRecord[]
  nodes: readonly FabricGraphNode[]
  onSelect: (node: FabricGraphNode) => void
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
                <small>{activity.action} · {statusLabel(activity.status)}{activity.detail === undefined ? '' : ` · ${activity.detail}`}</small>
              </span>
              <span className={css.activityMetric}>{activity.kind.toUpperCase()}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function NodeDetails({ node, onOpen }: { node: FabricGraphNode; onOpen?: () => void }) {
  return (
    <aside className={css.details} aria-label="节点详情">
      <span className={css.eyebrow}>{node.kind === 'main' ? 'MAIN' : node.kind.toUpperCase()}</span>
      <h3>{node.label}</h3>
      <dl className={css.metrics}>
        <div><dt>状态</dt><dd>{statusLabel(node.status)}</dd></div>
        <div><dt>令牌</dt><dd>{node.tokens === undefined ? '—' : formatTokens(node.tokens)}</dd></div>
        <div><dt>时长</dt><dd>{node.durationMs === undefined ? '—' : formatDuration(node.durationMs)}</dd></div>
        <div><dt>后台任务</dt><dd>{node.jobCount}</dd></div>
      </dl>
      {node.detail === undefined ? null : <p className={css.nodeDetail}>{node.detail}</p>}
      {onOpen === undefined ? null : <button className={css.openButton} type="button" onClick={onOpen}>打开会话</button>}
    </aside>
  )
}

function statusLabel(status: FabricNodeStatus): string {
  switch (status) {
    case 'running': return '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'blocked': return '受阻'
    case 'stopped': return '已停止'
    case 'pending': return '等待中'
    case 'idle': return '非活动'
  }
}

function kindLabel(kind: FabricNodeKind): string {
  switch (kind) {
    case 'main': return '主会话'
    case 'session': return '会话'
    case 'subagent': return '子代理'
    case 'workflow': return '工作流'
    case 'phase': return '阶段'
    case 'job': return '后台任务'
    case 'actor': return 'Actor'
    case 'topic': return '主题'
    case 'message': return '消息'
    case 'state': return '状态'
    case 'component': return '组件'
    case 'compaction': return '上下文压缩'
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function formatTokens(value: number): string {
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
