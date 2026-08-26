/** Fabric-native delegation policy and model-facing Consumer. */
export { apply, Config, inject, name } from './tool.ts'
export type { Config as DelegationConfig } from './tool.ts'
export { delegationGuidance, resolveWorkerRoute, routeForTier } from './policy.ts'
export type { FabricDelegationRoutingConfig, FabricWorkerRoute } from './policy.ts'
export type {
  FabricAutoDelegationPolicy,
  FabricDelegationPresentationMeta,
  FabricDelegationResult,
  FabricDelegationTaskRecord,
  FabricDelegationWorkerResult,
  FabricObservedRoute,
  FabricWorkerTier,
} from './types.ts'
