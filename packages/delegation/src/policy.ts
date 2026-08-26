import { normalizeModelAliases, splitModelTarget } from 'dsh-fabric-models'
import type { FabricAutoDelegationPolicy, FabricWorkerTier } from './types.ts'

/** Provider/model pair passed to DSH's workflow agent call. */
export interface FabricWorkerRoute { provider: string; model: string }

/** Deployment routing fields needed by the pure policy resolver. */
export interface FabricDelegationRoutingConfig {
  aliases: Record<string, string | string[]>
  mainModel?: string
  cheapModel?: string
  defaultModel?: string
  strongModel?: string
  validatorModel?: string
  autoPolicy: FabricAutoDelegationPolicy
}

/** Resolve one configured selector as an exact target or first alias target. */
export function resolveWorkerRoute(
  selector: string | undefined,
  aliasesInput: Record<string, string | string[]>,
): FabricWorkerRoute | undefined {
  if (selector === undefined || selector.trim() === '') return undefined
  const normalized = selector.trim()
  const aliases = normalizeModelAliases(aliasesInput)
  const aliasKey = Object.keys(aliases).find(key => key.toLowerCase() === normalized.toLowerCase())
  const target = aliasKey === undefined ? normalized : aliases[aliasKey]?.[0]
  if (target === undefined || !target.includes('/')) {
    throw new Error('delegation model selector "' + selector + '" must be provider/model or a configured alias')
  }
  const route = splitModelTarget(target)
  if (route.provider === '' || route.model === '') {
    throw new Error('delegation model selector "' + selector + '" did not resolve to provider/model')
  }
  return route
}

/** Select the configured route for one worker tier. */
export function routeForTier(tier: FabricWorkerTier, config: FabricDelegationRoutingConfig): FabricWorkerRoute | undefined {
  switch (tier) {
    case 'cheap': return resolveWorkerRoute(config.cheapModel, config.aliases)
    case 'default': return resolveWorkerRoute(config.defaultModel, config.aliases)
    case 'strong': return resolveWorkerRoute(config.strongModel, config.aliases)
  }
}

/** Render deterministic coordinator guidance for the selected policy. */
export function delegationGuidance(config: FabricDelegationRoutingConfig): string {
  const policy = config.autoPolicy === 'off'
    ? 'Delegation is opt-in: use delegate only when the user or task explicitly calls for independent workers.'
    : config.autoPolicy === 'prefer'
      ? 'For a non-trivial decomposable task, delegate independent mechanical work before doing it on Main. Do not delegate trivial or tightly coupled work.'
      : 'Consider delegate for non-trivial independent mechanical work; keep trivial and tightly coupled reasoning on Main.'
  return [
    'Main is the scarce coordinator. Use delegate for repository mapping, search, enumeration, repetitive edits, test execution, extraction, and independent reviews.',
    'Use cheap workers for mechanical work, default for ordinary implementation, and strong only for hard isolated reasoning. Submit independent tasks together for concurrency.',
    'After delegate returns, inspect failures and routingVerified, verify material claims against authoritative files or checks, then synthesize the result yourself.',
    policy,
  ].join(' ')
}
