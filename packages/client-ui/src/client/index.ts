/** Browser entry for dsh-fabric's Activity and Topology surfaces. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FabricHeaderAction } from './FabricHeaderAction.tsx'
import { en, zh } from './locales.ts'
import { FabricView } from './FabricView.tsx'
import type { FabricControls } from './types.ts'

/** Services required by the browser plugin. */
export const inject = ['slots', 'sessions', 'locale']

/** Build catalog-aware navigation callbacks for one mounted Fabric surface. */
export function createFabricControls(sessions: ClientContext['sessions']): FabricControls {
  const catalogs = new Set<SessionId>()
  const refreshCatalogs = async (sessionIds: readonly string[]): Promise<void> => {
    const ids = [...new Set(sessionIds.map(sessionId => sessionId as SessionId))]
    for (const sessionId of ids) catalogs.add(sessionId)
    await Promise.allSettled(ids.map(sessionId => sessions.refreshSubagents(sessionId)))
  }
  return {
    async openNode(rawSessionId) {
      const sessionId = rawSessionId as SessionId
      let address = sessions.subagentAddress(sessionId)
      if (address === undefined && catalogs.size > 0) {
        await Promise.allSettled([...catalogs].map(parent => sessions.refreshSubagents(parent)))
        address = sessions.subagentAddress(sessionId)
      }
      if (address !== undefined) {
        sessions.openSubagent(address)
      } else if (sessions.list.getSnapshot().ids.includes(sessionId)) {
        sessions.open(sessionId)
      }
    },
    refreshCatalogs,
  }
}

/** Register the full Fabric view and compact lineage action. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('fabric', { zh, en }), 'dsh-fabric: client dictionaries')
  const t = ctx.locale.bind('fabric')
  const controls = (_sessionId: SessionId): FabricControls => createFabricControls(ctx.sessions)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'fabric',
    order: 20,
    label: () => t('view.tab'),
    locale: 'fabric',
    inject: controls,
  }, FabricView))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'fabric-topology',
    order: 30,
    locale: 'fabric',
    inject: controls,
  }, FabricHeaderAction))
}
