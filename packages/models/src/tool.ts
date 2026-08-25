/**
 * Model-facing dsh-fabric session-model Consumer: inspect the calling
 * session's live model, list the served catalog, and switch the selection in
 * place through the host `sessionModels` authority (mounted by the ApiProxy
 * gateway, the same authority behind the web session.models/session.selectModel
 * RPC pair).
 */
import type { Context } from '@monotykamary/cordis'
import z from '@monotykamary/schemastery'
import type { Agent } from '@monotykamary/dsh-agent'
import type { ModelSelection } from '@monotykamary/dsh-agent'
import type { SessionModels, SessionModelTarget } from '@monotykamary/dsh-host-apiproxy'
import { defineTool } from '@monotykamary/dsh-tools'
import { snapshotJsonValue } from '@monotykamary/dsh-session'
import type { JsonValue } from '@monotykamary/dsh-session'
import {
  normalizeModelAliases,
  resolveModelQuery,
  splitModelTarget,
  type FabricServedModel,
  type FabricServedProviderGroup,
} from './domain.ts'

/** Cordis plugin name. */
export const name = 'dsh-fabric-models'
/** Only the tool registry is required; sessionModels resolves per call so headless hosts degrade cleanly. */
export const inject = ['tools']

const ACTIONS = ['current', 'list', 'select'] as const
type Action = typeof ACTIONS[number]

const MAX_LIST_MODELS_PER_GROUP = 100

export interface Config {
  /** Alias name -> provider/model target or ordered fallback chain, like pi-fabric's models.aliases. */
  aliases: Record<string, string | string[]>
}

export const Config: z<Config> = z.object({
  aliases: z.dict(z.union([z.string(), z.array(z.string())])).default({}),
})

function json(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError('fabric_models produced a non-JSON value')
  return snapshot as JsonValue
}

function requireSessionModels(ctx: Context): SessionModels {
  const sessionModels = ctx.get('sessionModels') as SessionModels | undefined
  if (sessionModels === undefined) {
    throw new Error('fabric_models requires the DSH API proxy host (ctx.sessionModels is unavailable)')
  }
  return sessionModels
}

function sameSelection(left: ModelSelection, right: { provider: string; model: string }): boolean {
  return left.provider === right.provider && left.model === right.model
}

interface SelectSuccess {
  readonly switched: boolean
  readonly selected: ModelSelection
  readonly previous: ModelSelection
  readonly alias?: string
  readonly name?: string
}

async function attemptSelect(
  sessionModels: SessionModels,
  agent: Agent,
  target: SessionModelTarget,
  extras: { alias?: string; name?: string } = {},
): Promise<SelectSuccess> {
  const previous = sessionModels.current(agent)
  if (sameSelection(previous, target)) {
    return {
      switched: false,
      selected: previous,
      previous,
      ...extras.alias === undefined ? {} : { alias: extras.alias },
      ...extras.name === undefined ? {} : { name: extras.name },
    }
  }
  const selected = await sessionModels.select(agent, target)
  return {
    switched: true,
    selected,
    previous,
    ...extras.alias === undefined ? {} : { alias: extras.alias },
    ...extras.name === undefined ? {} : { name: extras.name },
  }
}

/** Register the model-facing fabric_models Consumer. */
export function apply(ctx: Context, config: Config): void {
  const aliases = normalizeModelAliases(config.aliases)
  ctx.tools.register(defineTool({
    name: 'fabric_models',
    description:
      'Inspect or switch this session\'s live model. current shows the active selection; list shows the served model catalog plus configured aliases; select switches in place, keeping the new model until another switch. select resolves alias names (fallback chains try each target until one succeeds), an exact provider/model, an exact model id, or a unique search-term match; switching applies to the next request onward.',
    parameters: {
      action: { type: 'string', required: true, enum: ACTIONS },
      model: {
        type: 'string',
        description: 'For select: provider/model, alias name, or search term.',
      },
      provider: { type: 'string', description: 'Optional provider filter for search-term matching.' },
      reasoning_effort: {
        type: 'string',
        description: 'Optional adapter reasoning effort for select; invalid efforts are rejected with the supported set.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('fabric_models requires a DSH agent scope')
      const sessionModels = requireSessionModels(ctx)
      const agent = exec.agent
      switch (args.action as Action) {
        case 'current':
          return json({ current: sessionModels.current(agent) })
        case 'list': {
          const catalog = await sessionModels.catalog()
          return json({
              current: sessionModels.current(agent),
              aliases: Object.keys(aliases),
              groups: catalog.groups.map(group => ({
                id: group.id,
                name: group.name,
                models: group.models.slice(0, MAX_LIST_MODELS_PER_GROUP),
                ...group.models.length > MAX_LIST_MODELS_PER_GROUP
                  ? { truncated: group.models.length - MAX_LIST_MODELS_PER_GROUP }
                  : {},
              })),
              failures: catalog.failures,
          })
        }
        case 'select': {
          const query = typeof args.model === 'string' ? args.model.trim() : ''
          if (!query) throw new Error('fabric_models select requires a model provider/model, alias, or search term')
          const effort = typeof args.reasoning_effort === 'string' && args.reasoning_effort.trim() !== ''
            ? args.reasoning_effort.trim()
            : undefined
          const catalog = await sessionModels.catalog()
          const groups: FabricServedProviderGroup[] = catalog.groups.map(group => ({
            id: group.id,
            name: group.name,
            models: group.models.map(entry => ({ id: entry.id, name: entry.name } satisfies FabricServedModel)),
          }))
          const resolution = resolveModelQuery(query, {
            aliases,
            catalog: groups,
            ...typeof args.provider === 'string' && args.provider.trim() !== ''
              ? { provider: args.provider.trim() }
              : {},
          })
          if (resolution.kind === 'alias') {
            const errors: string[] = []
            for (const target of resolution.targets) {
              const { provider, model } = splitModelTarget(target)
              try {
                return json(await attemptSelect(
                  sessionModels,
                  agent,
                  { provider, model, ...effort === undefined ? {} : { reasoningEffort: effort } },
                  { alias: resolution.alias },
                ))
              } catch (error: unknown) {
                errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            throw new Error(`alias "${resolution.alias}" has no selectable target: ${errors.join('; ')}`)
          }
          if (resolution.kind === 'ambiguous') {
            throw new Error(
              `"${resolution.query}" matches multiple models: ${resolution.candidates.join(', ')}. Pass an exact provider/model.`,
            )
          }
          if (resolution.kind === 'not-found') {
            throw new Error(`no served model matches "${resolution.query}"`)
          }
          return json(await attemptSelect(
            sessionModels,
            agent,
            {
              provider: resolution.provider,
              model: resolution.model,
              ...effort === undefined ? {} : { reasoningEffort: effort },
            },
            { ...(resolution.name === undefined ? {} : { name: resolution.name }) },
          ))
        }
      }
    },
  }))
}
