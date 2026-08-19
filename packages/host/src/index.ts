/** DSH session-event and projection adapter for Fabric activity. */
import type { Context } from '@monotykamary/cordis'
import z from '@monotykamary/schemastery'
import { DisclosureStore } from '@dsh-fabric/system-prompt'
import { createFabricActivityProjection } from './projection.ts'
import type {} from '@monotykamary/dsh-tool-workflow/types'

export type { FabricActivityEventData } from './types.ts'
export { createFabricActivityProjection } from './projection.ts'

/** Cordis plugin name. */
export const name = 'dsh-fabric-host'
/** The generic projection registry drives this package's pure fold. */
export const inject = ['sessionProjections']

/** Bounded host projection policy. */
export interface Config {
  activityLimit?: number
  topologyLimit?: number
}

export const Config: z<Config> = z.object({
  activityLimit: z.number().step(1).min(1).default(200),
  topologyLimit: z.number().step(1).min(1).default(256),
})

/**
 * Register the bounded Fabric activity projection and the host-plane
 * disclosure catalog.
 *
 * The DisclosureStore is provided HERE (host plane, root realm) so the
 * host code runtime can resolve it for `tools.describe()`; the
 * fabric-preset-scoped @dsh-fabric/system-prompt plugin consumes it and
 * publishes per-agent tool catalogs into it.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('fabricDisclosure', new DisclosureStore())
  const activityLimit = config.activityLimit as number
  const topologyLimit = config.topologyLimit as number
  ctx.sessionProjections.register(createFabricActivityProjection(activityLimit, topologyLimit))
}
