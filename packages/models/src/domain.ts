/** Alias normalization and selector resolution for the fabric_models Consumer. */

/** One model entry inside a served provider group. */
export interface FabricServedModel {
  readonly id: string
  readonly name: string
}

/** One served provider group from the host model catalog. */
export interface FabricServedProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly FabricServedModel[]
}

const PROVIDER_MODEL_RE = /^[^\s/]+\/[^\s/]+$/

/**
 * Normalize the raw aliases config into name -> ordered provider/model
 * targets. Same contract as pi-fabric's models.aliases; entries with a blank
 * name, an empty chain, or any malformed target are dropped whole so a
 * half-valid chain never silently skips a member.
 */
export function normalizeModelAliases(input: unknown): Record<string, string[]> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const aliases: Record<string, string[]> = {}
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim()
    if (!name) continue
    const values = typeof rawValue === 'string' ? [rawValue] : rawValue
    if (!Array.isArray(values) || values.length === 0) continue
    const targets: string[] = []
    let valid = true
    for (const candidate of values) {
      if (typeof candidate !== 'string') {
        valid = false
        break
      }
      const target = candidate.trim()
      if (!PROVIDER_MODEL_RE.test(target)) {
        valid = false
        break
      }
      if (!targets.includes(target)) targets.push(target)
    }
    if (valid && targets.length > 0) aliases[name] = targets
  }
  return aliases
}

/** Split one normalized provider/model target; guaranteed by the alias regex. */
export function splitModelTarget(target: string): { provider: string; model: string } {
  const separator = target.indexOf('/')
  return { provider: target.slice(0, separator), model: target.slice(separator + 1) }
}

export type FabricModelQuery =
  | { readonly kind: 'alias'; readonly alias: string; readonly targets: readonly string[] }
  | { readonly kind: 'exact'; readonly provider: string; readonly model: string; readonly name?: string }
  | { readonly kind: 'ambiguous'; readonly query: string; readonly candidates: readonly string[] }
  | { readonly kind: 'not-found'; readonly query: string }

/**
 * Resolve a model selector: alias names resolve first (chains stay intact for
 * the caller's fallback walk), then an exact provider/id passthrough — the
 * host adapter set, not the catalog, is the availability authority — then an
 * exact bare id, then a single catalog partial across provider, id, and
 * display name.
 */
export function resolveModelQuery(
  query: string,
  options: {
    aliases: Record<string, string[]>
    catalog: readonly FabricServedProviderGroup[]
    provider?: string
  },
): FabricModelQuery {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return { kind: 'not-found', query }

  const aliasKey = Object.keys(options.aliases).find(key => key.toLowerCase() === normalized)
  if (aliasKey !== undefined) {
    const targets = options.aliases[aliasKey] ?? []
    return { kind: 'alias', alias: aliasKey, targets }
  }

  const providerFilter = options.provider?.trim().toLowerCase()
  const groups = providerFilter === undefined || providerFilter === ''
    ? options.catalog
    : options.catalog.filter(group => group.id.toLowerCase() === providerFilter)

  if (normalized.includes('/')) {
    const { provider, model } = splitModelTarget(normalized)
    const servedName = groups
      .find(group => group.id.toLowerCase() === provider)
      ?.models.find(entry => entry.id.toLowerCase() === model)?.name
    return {
      kind: 'exact',
      provider,
      model,
      ...servedName === undefined ? {} : { name: servedName },
    }
  }

  const exactId = groups.flatMap(group =>
    group.models
      .filter(entry => entry.id.toLowerCase() === normalized)
      .map(entry => ({ group, entry })),
  )
  if (exactId.length > 0) {
    const first = exactId[0]
    if (first === undefined) return { kind: 'not-found', query }
    return { kind: 'exact', provider: first.group.id, model: first.entry.id, name: first.entry.name }
  }

  const matches = groups.flatMap(group =>
    group.models
      .filter(entry =>
        entry.id.toLowerCase().includes(normalized)
        || entry.name.toLowerCase().includes(normalized)
        || group.id.toLowerCase().includes(normalized)
        || group.name.toLowerCase().includes(normalized),
      )
      .map(entry => ({ group, entry })),
  )
  if (matches.length === 1) {
    const only = matches[0]
    if (only === undefined) return { kind: 'not-found', query }
    return { kind: 'exact', provider: only.group.id, model: only.entry.id, name: only.entry.name }
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      query,
      candidates: matches.map(match => `${match.group.id}/${match.entry.id}`),
    }
  }
  return { kind: 'not-found', query }
}
