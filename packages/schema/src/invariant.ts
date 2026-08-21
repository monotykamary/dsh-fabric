/** Package-owned invariant companion for dsh-fabric-schema. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = 'dsh-fabric-schema'

export const name = 'dsh-fabric-schema-invariant'
export const inject = ['invariants']

/** No additional invariant: storage-domain validates mesh records and state transitions are CAS-fenced. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
