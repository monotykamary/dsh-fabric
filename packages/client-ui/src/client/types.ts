/** Plain callback face injected into Fabric browser components. */
export interface FabricControls {
  /** Open one graph node through the authoritative session/subagent route. */
  openNode(sessionId: string): Promise<void>
  /** Refresh direct-child catalogs for currently visible session nodes. */
  refreshCatalogs(sessionIds: readonly string[]): Promise<void>
}
