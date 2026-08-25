/**
 * dsh-fabric-models: session model inspection and switching. The Consumer is
 * also mountable directly through this root entry (a preset row naming the
 * package without a subpath registers the same tool).
 */
export { apply, Config, inject, name } from './tool.ts'
export type {
  FabricModelQuery,
  FabricServedModel,
  FabricServedProviderGroup,
} from './domain.ts'
export { normalizeModelAliases, resolveModelQuery, splitModelTarget } from './domain.ts'
