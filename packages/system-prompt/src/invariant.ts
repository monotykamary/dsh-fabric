/** Package-owned invariant companion for dsh-fabric-system-prompt. */
import type { Context } from '@monotykamary/cordis'
import type { InvariantInstaller } from '@monotykamary/dsh-invariants'

const PACKAGE_NAME = 'dsh-fabric-system-prompt'

export const name = 'dsh-fabric-system-prompt-invariant'
export const inject = ['invariants']

/**
 * No additional invariant: the minimized assembly is validated by the
 * dsh-system-prompt invariant, and this package only filters registered
 * sections by their existing names.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
