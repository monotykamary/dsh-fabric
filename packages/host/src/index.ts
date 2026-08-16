/** DSH session-event and projection adapter for Fabric activity. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import { createFabricActivityProjection } from './projection.ts'
import type { FabricActivityEventData } from './types.ts'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'

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

/** Register the bounded Fabric activity projection. */
export function apply(ctx: Context, config: Config): void {
  const activityLimit = config.activityLimit as number
  const topologyLimit = config.topologyLimit as number
  ctx.sessionProjections.register(createFabricActivityProjection(activityLimit, topologyLimit))
}

/** Append one complete post-commit Fabric activity fact to a session. */
export function appendFabricActivity(session: Session, data: FabricActivityEventData): void {
  const append = session.append.bind(session) as (
    type: 'fabric/activity',
    value: SessionEventMap['fabric/activity'],
  ) => void
  append('fabric/activity', data)
}
