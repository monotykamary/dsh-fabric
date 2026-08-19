/** Shared localized labels for Fabric browser surfaces. */
import type { TranslateNS } from '@monotykamary/dsh-client-ui-slots'
import type { FabricActivityKind, FabricGraphNode, FabricNodeKind, FabricNodeStatus } from 'dsh-fabric-protocol'

export function statusLabel(status: FabricNodeStatus, t: TranslateNS<'fabric'>): string {
  return t(`status.${status}`)
}

export function kindLabel(kind: FabricNodeKind, t: TranslateNS<'fabric'>): string {
  return t(`kind.${kind}`)
}

/** Resolve stable structural labels without baking presentation copy into protocol data. */
export function topologyNodeLabel(node: FabricGraphNode, t: TranslateNS<'fabric'>): string {
  if (node.kind === 'main') return t('group.main')
  if (node.kind !== 'group') return node.label
  switch (node.group) {
    case 'participants': return t('group.participants')
    case 'sessions': return t('group.sessions')
    case 'agents': return t('group.agents')
    case 'actors': return t('group.actors')
    case 'mesh': return t('group.mesh')
    case 'topics': return t('group.topics')
    case 'topic-fabric': return t('group.topicFabric')
    case 'topic-project': return t('group.topicProject')
    case 'state': return t('group.state')
    case 'state-world': return t('group.stateWorld')
    case 'state-schema': return t('group.stateSchema')
    case 'state-project': return t('group.stateProject')
    case 'components': return t('group.components')
    default: return node.label
  }
}


export function activityKindLabel(kind: FabricActivityKind, t: TranslateNS<'fabric'>): string {
  return t(`activity.kind.${kind}`)
}

export function actionLabel(action: string, t: TranslateNS<'fabric'>): string {
  switch (action) {
    case 'created': return t('action.created')
    case 'published': return t('action.published')
    case 'compare-and-swap': return t('action.compareAndSwap')
    case 'sent': return t('action.sent')
    case 'claimed': return t('action.claimed')
    case 'failed': return t('action.failed')
    case 'completed': return t('action.completed')
    case 'started': return t('action.started')
    case 'summarized': return t('action.summarized')
    case 'pruned': return t('action.pruned')
    case 'updated': return t('action.updated')
    case 'cancelled': return t('action.cancelled')
    case 'running': return t('action.running')
    case 'blocked': return t('action.blocked')
    case 'idle': return t('action.idle')
    case 'error': return t('action.error')
    default: return action
  }
}

export function formatDuration(value: number, t: TranslateNS<'fabric'>): string {
  const seconds = Math.max(0, Math.floor(value / 1_000))
  if (seconds < 60) return t('duration.seconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('duration.minutes', { count: minutes })
  return t('duration.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}
