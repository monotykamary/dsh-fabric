/** Package-owned invariant companion for @dsh-fabric/compaction. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = '@dsh-fabric/compaction'

export const name = 'dsh-fabric-compaction-invariant'
export const inject = ['invariants']

/** DSH compaction and preset companions validate the reused transaction and realm contracts. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
