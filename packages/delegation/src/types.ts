/** Worker tier exposed by the Fabric delegation Consumer. */
export type FabricWorkerTier = 'cheap' | 'default' | 'strong'

/** Automatic delegation posture advertised to the coordinator. */
export type FabricAutoDelegationPolicy = 'off' | 'suggest' | 'prefer'

/** Requested route and task metadata accepted for one worker. */
export interface FabricDelegationTaskRecord {
  index: number
  label: string
  task: string
  tier: FabricWorkerTier
  provider?: string
  model?: string
}

/** Route observed from a child session request rather than trusted from input. */
export interface FabricObservedRoute {
  provider: string
  model: string
}

/** One settled worker returned to the coordinator. */
export interface FabricDelegationWorkerResult {
  index: number
  label: string
  task: string
  tier: FabricWorkerTier
  childId?: string
  output: unknown
  outcome: 'completed' | 'failed' | 'cancelled'
  requested?: FabricObservedRoute
  actual?: FabricObservedRoute
  routingVerified: boolean
  tokens: number
  durationMs: number
}

/** Canonical result returned by one delegation call. */
export interface FabricDelegationResult {
  delegationId: string
  label: string
  status: 'completed' | 'failed' | 'cancelled' | 'budget-exhausted'
  workers: FabricDelegationWorkerResult[]
  validation: unknown
  validator: FabricDelegationWorkerResult | null
  orchestrator: {
    requested?: FabricObservedRoute
    actual?: FabricObservedRoute
    routingVerified: boolean
  }
  tokenBudget: number | null
  totalTokens: number
  durationMs: number
  verificationRequired: true
}

/** Replayable tool presentation metadata carried by direct delegate results. */
export interface FabricDelegationPresentationMeta {
  kind: 'fabric-delegation'
  result: FabricDelegationResult
}
