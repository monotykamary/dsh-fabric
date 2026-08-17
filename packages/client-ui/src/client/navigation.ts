import type { ClientContext, SessionId } from '@monotykamary/dsh-client-runtime/client'
import type { FabricControls } from './types.ts'

export interface FabricNavigationContext {
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
