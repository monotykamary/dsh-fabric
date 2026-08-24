/** Browser entry for dsh-fabric's Activity and Topology surfaces. */
import type { ClientContext, SessionId } from '@monotykamary/dsh-client-runtime/client'
import type { BoundActions } from '@monotykamary/dsh-client-ui-slots'
import type {} from '@monotykamary/dsh-client-locale/client'
import type { ChatStore } from '@monotykamary/dsh-client-ui-conversation/client'
import { en, zh } from './locales.ts'
import { createFabricControls } from './navigation.ts'
import { FabricView } from './FabricView.tsx'
import type { FabricControls } from './types.ts'

export { createFabricControls } from './navigation.ts'

/** Services required by the browser plugin. */
export const inject = ['slots', 'sessions', 'locale']

// The conversation owner remains the sole view-state authority; Fabric only mounts its existing handle.
function conversationChatStore(ctx: ClientContext): ChatStore {
  const store = ctx.slots.entriesOfSlot('conversation.session')
    .find(entry => entry.store !== undefined)?.store
  if (store === undefined || typeof store === 'function' || !('setView' in store.spec.actions)) {
    throw new Error('dsh-fabric: conversation session did not expose its shared Chat store')
  }
  return store as unknown as ChatStore
}

/** Register the full Fabric conversation view. */
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
}
