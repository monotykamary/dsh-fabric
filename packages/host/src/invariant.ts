/** Package-owned invariant companion for @dsh-fabric/host. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = '@dsh-fabric/host'

/** Cordis companion plugin name. */
export const name = 'dsh-fabric-host-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: projection output is schema-validated by the DSH projection registry. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
