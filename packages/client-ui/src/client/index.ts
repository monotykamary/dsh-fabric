/** Browser entry for dsh-fabric's Activity and Topology surfaces. */
import type { ClientContext, SessionId } from '@monotykamary/dsh-client-runtime/client'
import type { BoundActions } from '@monotykamary/dsh-client-ui-slots'
import type {} from '@monotykamary/dsh-client-locale/client'
import type {} from '@monotykamary/dsh-client-ui-settings/client'
import type {} from '@monotykamary/dsh-client-ui-settings-plugins/client'
import type { ChatStore } from '@monotykamary/dsh-client-ui-conversation/client'
import { en, zh } from './locales.ts'
import { createFabricControls } from './navigation.ts'
import { FabricView } from './FabricView.tsx'
import { SchemaSettingsCard } from './SchemaSettingsCard.tsx'
import { SpeculationSettingsCard } from './SpeculationSettingsCard.tsx'
import {
  FABRIC_SCHEMA_SETTINGS_NAMESPACE,
  FabricSchemaSettingsController,
  type FabricSchemaSettingsSection,
} from './schema-settings-controller.ts'
import {
  TOOL_SPECULATION_SETTINGS_NAMESPACE,
  ToolSpeculationSettingsController,
  type ToolSpeculationSettingsSection,
} from './speculation-settings-controller.ts'
import {
  settingsEn,
  settingsZh,
  speculationSettingsEn,
  speculationSettingsZh,
} from './settings-locales.ts'
import type { FabricControls } from './types.ts'

export { createFabricControls } from './navigation.ts'
export { FabricSchemaSettingsController } from './schema-settings-controller.ts'
export { ToolSpeculationSettingsController } from './speculation-settings-controller.ts'

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

  ctx.inject(['settingsScope'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.locale.register('fabric.settings', { zh: settingsZh, en: settingsEn }),
      'dsh-fabric: Schema settings dictionaries',
    )
    settingsCtx.effect(
      () => settingsCtx.locale.register('fabric.speculation.settings', {
        zh: speculationSettingsZh,
        en: speculationSettingsEn,
      }),
      'dsh-fabric: speculation settings dictionaries',
    )
    const schemaController = new FabricSchemaSettingsController(
      settingsCtx.settingsScope.bind<FabricSchemaSettingsSection>({ namespace: FABRIC_SCHEMA_SETTINGS_NAMESPACE }),
    )
    const speculationController = new ToolSpeculationSettingsController(
      settingsCtx.settingsScope.bind<ToolSpeculationSettingsSection>({
        namespace: TOOL_SPECULATION_SETTINGS_NAMESPACE,
      }),
    )
    settingsCtx.effect(() => () => { schemaController.dispose() }, 'dsh-fabric: Schema settings form')
    settingsCtx.effect(() => () => { speculationController.dispose() }, 'dsh-fabric: speculation settings form')
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      key: FABRIC_SCHEMA_SETTINGS_NAMESPACE,
      locale: 'fabric.settings',
      inject: () => schemaController.inject(),
    }, SchemaSettingsCard))
    settingsCtx.slots.inject('settings.plugin.item', () => settingsCtx.slots.register({
      name: 'settings.plugin.item',
      key: TOOL_SPECULATION_SETTINGS_NAMESPACE,
      locale: 'fabric.speculation.settings',
      inject: () => speculationController.inject(),
    }, SpeculationSettingsCard))
  })

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
