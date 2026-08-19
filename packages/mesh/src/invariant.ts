/** Package-owned invariant companion for dsh-fabric-mesh. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = 'dsh-fabric-mesh'

export const name = 'dsh-fabric-mesh-invariant'
export const inject = ['invariants']

/** No additional invariant: storage-domain validates records and commit-order change events. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
