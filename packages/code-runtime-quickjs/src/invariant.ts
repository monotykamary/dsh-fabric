/** Package-owned invariant companion for @dsh-fabric/code-runtime-quickjs. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = '@dsh-fabric/code-runtime-quickjs'

export const name = 'dsh-fabric-code-runtime-quickjs-invariant'
export const inject = ['invariants']

/** No companion relation: CodeRuntime owns one service slot and validates every request directly. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
