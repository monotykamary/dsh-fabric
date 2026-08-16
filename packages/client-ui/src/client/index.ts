/** Browser entry for dsh-fabric's Activity and Topology surfaces. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FabricHeaderAction } from './FabricHeaderAction.tsx'
import { FabricView } from './FabricView.tsx'
import type { FabricControls } from './types.ts'

/** Services required by the browser plugin. */
export const inject = ['slots', 'sessions']

/** Register the full Fabric view and compact lineage action. */
export function apply(ctx: ClientContext): void {
  const controls = (_sessionId: SessionId): FabricControls => ({
    openNode: (rawSessionId) => {
      const sessionId = rawSessionId as SessionId
      const address = ctx.sessions.subagentAddress(sessionId)
      if (address === undefined) ctx.sessions.open(sessionId)
      else ctx.sessions.openSubagent(address)
    },
    refreshCatalogs: (sessionIds) => {
      for (const sessionId of new Set(sessionIds)) void ctx.sessions.refreshSubagents(sessionId as SessionId)
    },
  })

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'fabric',
    order: 20,
    label: () => 'Fabric',
    inject: controls,
  }, FabricView))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'fabric-topology',
    order: 30,
    inject: controls,
  }, FabricHeaderAction))
}
