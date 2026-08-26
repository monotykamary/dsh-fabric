/** Package-owned invariant companion for dsh-fabric-delegation. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = 'dsh-fabric-delegation'
export const name = 'dsh-fabric-delegation-invariant'
export const inject = ['invariants']

/** Session replay and workflow invariants own the durable pairing checks. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
