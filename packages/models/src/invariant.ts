/** Package-owned invariant companion for dsh-fabric-models. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = 'dsh-fabric-models'

export const name = 'dsh-fabric-models-invariant'
export const inject = ['invariants']

/** No additional invariant: selection authority remains the DSH API proxy. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
