/** Browser entry for dsh-fabric's Activity and Topology surfaces. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ChatStore } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FabricHeaderAction } from './FabricHeaderAction.tsx'
import { en, zh } from './locales.ts'
import { FabricView } from './FabricView.tsx'
import type { FabricControls } from './types.ts'

/** Services required by the browser plugin. */
export const inject = ['slots', 'sessions', 'locale']

interface FabricNavigationContext {
  readonly currentSessionId: SessionId
  readonly showChat: () => void
}

/** Build catalog-aware navigation callbacks for one mounted Fabric surface. */
export function createFabricControls(
  sessions: ClientContext['sessions'],
  navigation?: FabricNavigationContext,
): FabricControls {
  const catalogs = new Set<SessionId>()
  const refreshCatalogs = async (sessionIds: readonly string[]): Promise<void> => {
    const ids = [...new Set(sessionIds.map(sessionId => sessionId as SessionId))]
    for (const sessionId of ids) catalogs.add(sessionId)
    await Promise.allSettled(ids.map(sessionId => sessions.refreshSubagents(sessionId)))
  }
  return {
    async openNode(rawSessionId) {
      const sessionId = rawSessionId as SessionId
      if (navigation !== undefined && sessionId === navigation.currentSessionId) {
        navigation.showChat()
        return
      }
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

// The conversation owner remains the sole view-state authority; Fabric only mounts its existing handle.
function conversationChatStore(ctx: ClientContext): ChatStore {
  const store = ctx.slots.entriesOfSlot('conversation.session')
    .find(entry => entry.store !== undefined)?.store
  if (store === undefined || typeof store === 'function' || !('setView' in store.spec.actions)) {
    throw new Error('dsh-fabric: conversation session did not expose its shared Chat store')
  }
  return store as unknown as ChatStore
}

/** Register the full Fabric view and compact lineage action. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('fabric', { zh, en }), 'dsh-fabric: client dictionaries')
  const t = ctx.locale.bind('fabric')

  ctx.slots.inject('conversation.view', () => {
    const store = conversationChatStore(ctx)
    const controls = (sessionId: SessionId, actions: BoundActions<ChatStore>): FabricControls => createFabricControls(
      ctx.sessions,
      { currentSessionId: sessionId, showChat: () => { actions.setView('chat') } },
    )
    return ctx.slots.register({
      name: 'conversation.view',
      id: 'fabric',
      order: 20,
      label: () => t('view.tab'),
      locale: 'fabric',
      store,
      inject: controls,
    }, FabricView)
  })

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'fabric-topology',
    order: 30,
    locale: 'fabric',
    inject: (_sessionId: SessionId): FabricControls => createFabricControls(ctx.sessions),
  }, FabricHeaderAction))
}
