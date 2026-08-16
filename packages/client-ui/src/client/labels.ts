/** Shared localized labels for Fabric browser surfaces. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FabricActivityKind, FabricNodeKind, FabricNodeStatus } from '@dsh-fabric/protocol'

export function statusLabel(status: FabricNodeStatus, t: TranslateNS<'fabric'>): string {
  return t(`status.${status}`)
}

export function kindLabel(kind: FabricNodeKind, t: TranslateNS<'fabric'>): string {
  return t(`kind.${kind}`)
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
