import { realpathSync } from 'node:fs'
import type { Context } from '@monotykamary/cordis'
import type { AssembleContext } from '@monotykamary/dsh-system-prompt'
import type { Agent } from '@monotykamary/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@monotykamary/dsh-tools'
import { defineTool } from '@monotykamary/dsh-tools'
import { snapshotJsonValue } from '@monotykamary/dsh-session'
import type { JsonValue } from '@monotykamary/dsh-session'
import z from '@monotykamary/schemastery'
import { resolveWorkspaceIdentity } from 'dsh-fabric-mesh/tool'
import { DEFAULT_SCHEMA_CONFIG, SchemaController, type FabricSchemaConfig, type FabricSchemaMode } from './controller.ts'
import { StateStore } from './state-store.ts'
import type { SchemaEvidence, SchemaFileOperation } from './types.ts'

/** Cordis plugin name. */
export const name = 'dsh-fabric-schema/tool'
/** The tool registry, the durable mesh service, and the prompt registry are all required. */
export const inject = ['tools', 'fabricMesh', 'systemPrompt']

/** Schema plugin configuration; defaults match pi-fabric's schema defaults. */
export interface Config {
  mode?: FabricSchemaMode
  certificateTtlMs?: number
  maxFiles?: number
  maxBytes?: number
  trustedCommands?: Record<string, { command: string; args: string[]; shell: boolean; timeoutMs: number }>
}

export const Config: z<Config> = z.object({
  mode: z.union([z.const('off'), z.const('audit'), z.const('enforce')]).default('off'),
  certificateTtlMs: z.number().step(1).min(1).default(DEFAULT_SCHEMA_CONFIG.certificateTtlMs),
  maxFiles: z.number().step(1).min(1).default(DEFAULT_SCHEMA_CONFIG.maxFiles),
  maxBytes: z.number().step(1).min(1).default(DEFAULT_SCHEMA_CONFIG.maxBytes),
  trustedCommands: z.dict(z.object({
    command: z.string(),
    args: z.array(z.string()),
    shell: z.boolean(),
    timeoutMs: z.number().step(1).min(1),
  })).default({}),
})

const MAX_TEXT_BYTES = 8 * 1024

const SCHEMA_GUIDANCE = [
  '## Schema world state',
  '',
  'The world model is a labeled state machine plus a falsifiable workspace transaction gate. Raw mesh records back it; the typed tools validate the calls that use it.',
  '',
  "- 'state_get' reads the current head, goal, complexity summary, and certification; 'state_transition' appends a labeled transition and CAS-advances the head (declare 'from' matching the current head, or set 'force'); 'state_history' folds the label graph; 'state_complexity' counts structural decision points.",
  "- A transition's 'evidence' commands are attached, NOT certified — 'state_verify' must run at least one command and confirm every result to certify (or it fails closed and revokes).",
  "- Workspace transactions: 'schema_hypothesize' binds a falsifiable hypothesis plus nonempty typed evidence to the current state and workspace fingerprint; 'schema_verify' fail-closed confirms every evidence item against the unchanged fingerprint and may issue one single-use certificate; 'schema_commit' consumes the certificate and atomically applies declared write/edit/delete operations with SHA-256 preconditions, postconditions, and rollback/quarantine on failure.",
  "- Evidence is typed: 'file_exists', 'file_absent', 'file_contains', 'file_sha256', or 'trusted_command' (configured names only). Complexity reductions require replayable evidence, and 'representation' transitions archive earlier labels.",
].join('\n')

/** Resolve the per-workspace controller cache keyed by the stable DSH workspace identity. */
export function resolveSchemaController(
  cache: Map<string, SchemaController>,
  ctx: Context,
  agent: Agent | undefined,
  config: FabricSchemaConfig,
): SchemaController | undefined {
  if (agent === undefined) return undefined
  const identity = resolveWorkspaceIdentity(ctx, agent)
  const cached = cache.get(identity)
  if (cached !== undefined) return cached
  const cwd = agent.session.header.cwd
  if (cwd === undefined) return undefined
  let canonical = cwd
  try {
    canonical = realpathSync(cwd)
  } catch {
    return undefined
  }
  const mesh = ctx.fabricMesh.forWorkspace(identity)
  const state = new StateStore(mesh, identity)
  const controller = new SchemaController(canonical, config, mesh, identity, state)
  cache.set(identity, controller)
  return controller
}

/** Register the model-facing Schema/state tools, the guidance section, and the enforce-mode gate. */
export function apply(ctx: Context, config: Config): void {
  const schemaConfig: FabricSchemaConfig = {
    mode: config.mode as FabricSchemaMode,
    certificateTtlMs: config.certificateTtlMs as number,
    maxFiles: config.maxFiles as number,
    maxBytes: config.maxBytes as number,
    trustedCommands: config.trustedCommands as FabricSchemaConfig['trustedCommands'],
  }
  const controllers = new Map<string, SchemaController>()

  const visible = (context: AssembleContext) =>
    ctx.tools.get('schema_status', context.scope) !== undefined
  ctx.systemPrompt.section({
    name: 'fabric:schema-guidance',
    order: 116,
    text: context => visible(context) ? SCHEMA_GUIDANCE : '',
  })

  const invocationOf = (agent: Agent | undefined): string =>
    agent === undefined ? 'diagnostic' : 'session:' + agent.id

  // Enforce/audit gate for the direct mutation tools. In enforce mode,
  // edit/write are denied with the Schema route; in audit mode the
  // would-block event is published without denying. Bash stays outside this
  // gate (pi-fabric's prewalk shell-mutation interception is a separate
  // deferred surface); evidence commands run through the controller.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (exec.name !== 'edit' && exec.name !== 'write') return next()
    const controller = resolveSchemaController(controllers, ctx, exec.agent, schemaConfig)
    if (controller === undefined) return next()
    try {
      await controller.authorize(exec.name, invocationOf(exec.agent))
    } catch (error) {
      return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) }
    }
    return next()
  })

  const register = (
    toolName: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>, agent: Agent | undefined) => Promise<unknown>,
    readOnly = false,
  ): void => {
    ctx.tools.register(defineTool({
      name: toolName,
      description,
      parameters: parameters as never,
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error(`${toolName} requires a DSH agent workspace`)
        return json(await execute(args as Record<string, unknown>, exec.agent))
      },
      presentCall: args => ({ card: 'generic', title: `Schema: ${toolName}`, kind: readOnly ? 'read' : 'other' }),
      ...(readOnly ? { isConcurrencySafe: () => true } : {}),
    }))
  }

  const controller = (agent: Agent | undefined): SchemaController => {
    const instance = resolveSchemaController(controllers, ctx, agent, schemaConfig)
    if (instance === undefined) throw new Error('Schema requires an agent workspace with a cwd')
    return instance
  }

  // ── state.* surface ──────────────────────────────────────────────────────
  register('state_get', 'Return the current world-state head, goal, complexity summary, and current/recent certification state', {}, async (_args, agent) => {
    const state = controller(agent).state
    if (!state) throw new Error('State store unavailable')
    return state.get()
  }, true)

  register('state_transition', 'Append a labeled, validated state transition and compare-and-swap advance the world-state head', {
    label: { type: 'string', required: true, description: 'Name of this transition (the move), e.g. "applied auth patch"' },
    from: { type: 'string', description: 'State label this transition moves from. Must equal the current head to-label when a head exists; rejected on mismatch unless force is set.' },
    to: { type: 'string', required: true, description: 'Resulting state label (the new world-model version)' },
    summary: { type: 'string', required: true, description: 'Short human-readable claim this transition asserts' },
    evidence: { type: 'json', description: 'Trusted shell commands attached as evidence. Attachment is not certification; state_verify must run at least one command and confirm every result.' },
    tags: { type: 'json', description: 'Optional string tags.' },
    kind: { type: 'string', enum: ['state', 'representation'], description: 'Default "state". "representation" revises the state schema and archives all earlier labels.' },
    complexity: { type: 'json', description: 'Object with a project-relative "files" array whose TS/JS/TSX/JSX decision points this transition changes.' },
    force: { type: 'boolean', description: 'Override the from-mismatch and contention guards.' },
  }, async (args, agent) => {
    const state = controller(agent).state
    if (!state) throw new Error('State store unavailable')
    const cwd = agent!.session.header.cwd!
    return state.transition({
      label: text(args.label, 'label'),
      ...(args.from !== undefined ? { from: text(args.from, 'from') } : {}),
      to: text(args.to, 'to'),
      summary: text(args.summary, 'summary'),
      ...(args.evidence !== undefined ? { evidence: stringArray(args.evidence, 'evidence') } : {}),
      ...(args.tags !== undefined ? { tags: stringArray(args.tags, 'tags') } : {}),
      ...(args.kind !== undefined ? { kind: args.kind as 'state' | 'representation' } : {}),
      ...(args.complexity !== undefined ? { complexity: complexityInput(args.complexity) } : {}),
      ...(args.force === true ? { force: true } : {}),
    }, cwd)
  })

  register('state_history', 'Fold the transition log from its representation archive boundary into an ordered label graph', {
    label: { type: 'string', description: 'Filter transitions by label, from, or to' },
    limit: { type: 'integer', description: 'Maximum transitions returned' },
    includeArchived: { type: 'boolean', description: 'Reveal labels before the last representation transition.' },
  }, async (args, agent) => {
    const state = controller(agent).state
    if (!state) throw new Error('State store unavailable')
    return state.history({
      ...(args.label !== undefined ? { label: text(args.label, 'label') } : {}),
      ...(args.limit !== undefined ? { limit: integer(args.limit, 'limit') } : {}),
      ...(args.includeArchived === true ? { includeArchived: true } : {}),
    })
  }, true)

  register('state_complexity', 'Count current structural decision points and compare them with the complexity ledger', {
    files: { type: 'json', description: 'Project-relative files to count. Omit to inspect all recorded files.' },
  }, async (args, agent) => {
    const state = controller(agent).state
    if (!state) throw new Error('State store unavailable')
    return state.complexity({
      ...(args.files !== undefined ? { files: stringArray(args.files, 'files') } : {}),
      cwd: agent!.session.header.cwd!,
    })
  }, true)

  register('state_verify', 'Re-run evidence for the current head (or given labels); fail closed unless at least one command runs and every result is confirmed', {
    labels: { type: 'json', description: 'Verify transitions matching these labels (by transition.label, from, or to). Omit to verify the current head; an empty or unmatched selection fails closed.' },
    includeArchived: { type: 'boolean', description: 'Also replay evidence from labels before the last representation transition.' },
    timeoutMs: { type: 'integer', description: 'Per-command timeout in ms (default 30000)' },
  }, async (args, agent) => {
    const state = controller(agent).state
    if (!state) throw new Error('State store unavailable')
    return state.verify({
      ...(args.labels !== undefined ? { labels: stringArray(args.labels, 'labels') } : {}),
      ...(args.includeArchived === true ? { includeArchived: true } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: integer(args.timeoutMs, 'timeoutMs') } : {}),
      cwd: agent!.session.header.cwd!,
    })
  })

  register('state_goal', 'Set the executable goal predicate (Schema is_goal)', {
    check: { type: 'string', required: true, description: 'Executable shell predicate; exit 0 means the goal is met.' },
    description: { type: 'string' },
  }, async (args, agent) => {
    const state = controller(agent).state
    if (!state) throw new Error('State store unavailable')
    return state.goal({
      check: text(args.check, 'check'),
      ...(args.description !== undefined ? { description: text(args.description, 'description') } : {}),
    })
  })

  register('state_check_goal', 'Run the goal predicate and report pass/fail; publishes a state.goal.met event when it passes', {
    timeoutMs: { type: 'integer', description: 'Per-run timeout in ms (default 30000)' },
  }, async (args, agent) => {
    const state = controller(agent).state
    if (!state) throw new Error('State store unavailable')
    return state.checkGoal({
      ...(args.timeoutMs !== undefined ? { timeoutMs: integer(args.timeoutMs, 'timeoutMs') } : {}),
      cwd: agent!.session.header.cwd!,
    })
  })

  // ── schema.* surface ─────────────────────────────────────────────────────
  register('schema_status', 'Read the fixed session Schema mode, transaction bounds, generation, and invocation hypotheses', {}, async (_args, agent) => {
    return controller(agent).status(invocationOf(agent))
  }, true)

  register('schema_hypothesize', 'Durably bind a falsifiable hypothesis and nonempty typed evidence to the current state and workspace', {
    label: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    evidence: { type: 'json', required: true, description: 'Nonempty array of typed evidence items: {kind:"file_exists"|"file_absent"|"file_contains"|"file_sha256"|"trusted_command", ...}' },
    complexityReduction: { type: 'boolean', description: 'Mark this hypothesis as a certified complexity reduction.' },
  }, async (args, agent) => {
    return controller(agent).hypothesize({
      label: text(args.label, 'label'),
      summary: text(args.summary, 'summary'),
      evidence: evidenceArray(args.evidence, 'evidence'),
      ...(args.complexityReduction === true ? { complexityReduction: true } : {}),
    }, invocationOf(agent))
  })

  register('schema_verify', 'Fail-closed verification that may issue one fresh session-bound single-use certificate', {
    hypothesisId: { type: 'string', required: true },
  }, async (args, agent) => {
    return controller(agent).verify(text(args.hypothesisId, 'hypothesisId'), invocationOf(agent))
  })

  register('schema_commit', 'Consume one same-session certificate and atomically attempt bounded declared-file operations with rollback and postconditions', {
    hypothesisId: { type: 'string', required: true },
    certificate: { type: 'string', required: true },
    operations: { type: 'json', required: true, description: 'Nonempty array of {kind:"write"|"edit"|"delete", path, ...} with SHA-256 preconditions.' },
    postconditions: { type: 'json', required: true, description: 'Nonempty array of typed evidence items confirmed after the operations apply.' },
  }, async (args, agent) => {
    return controller(agent).commit({
      hypothesisId: text(args.hypothesisId, 'hypothesisId'),
      certificate: text(args.certificate, 'certificate'),
      operations: operationsArray(args.operations, 'operations'),
      postconditions: evidenceArray(args.postconditions, 'postconditions'),
    }, invocationOf(agent))
  })

  register('schema_abort', 'Abort an uncommitted same-session hypothesis and optionally its active certificate', {
    hypothesisId: { type: 'string', required: true },
    certificate: { type: 'string' },
  }, async (args, agent) => {
    return controller(agent).abort({
      hypothesisId: text(args.hypothesisId, 'hypothesisId'),
      ...(args.certificate !== undefined ? { certificate: text(args.certificate, 'certificate') } : {}),
    }, invocationOf(agent))
  })
}

function json(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new TypeError('schema tool produced a non-JSON value')
  return snapshot as JsonValue
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a nonempty string`)
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > MAX_TEXT_BYTES) throw new TypeError(`${field} must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes`)
  return value
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`)
  const items = value.map((item) => text(item, `${field} item`))
  if (items.length === 0) throw new TypeError(`${field} must not be empty`)
  return items
}

const EVIDENCE_KINDS = new Set(['file_exists', 'file_absent', 'file_contains', 'file_sha256', 'trusted_command'])
const OPERATION_KINDS = new Set(['write', 'edit', 'delete'])

function evidenceArray(value: unknown, field: string): SchemaEvidence[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a nonempty array of typed evidence`)
  const items: SchemaEvidence[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new TypeError(`${field} item must be an object`)
    const raw = item as Record<string, unknown>
    const kind = raw.kind
    if (typeof kind !== 'string' || !EVIDENCE_KINDS.has(kind)) {
      throw new TypeError(`${field} item has an unknown evidence kind: ${String(kind)}`)
    }
    const evidenceKind = kind as SchemaEvidence['kind']
    if (evidenceKind === 'trusted_command') {
      items.push({ kind: evidenceKind, name: text(raw.name, `${field}.name`) })
    } else {
      if (typeof raw.path !== 'string' || raw.path.trim() === '') throw new TypeError(`${field}.path must be a nonempty string`)
      if (evidenceKind === 'file_contains') {
        if (typeof raw.literal !== 'string') throw new TypeError(`${field}.literal must be a string`)
        items.push({ kind: evidenceKind, path: raw.path, literal: raw.literal })
      } else if (evidenceKind === 'file_sha256') {
        if (typeof raw.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(raw.sha256)) {
          throw new TypeError(`${field}.sha256 must match sha256:<64 hex>`)
        }
        items.push({ kind: evidenceKind, path: raw.path, sha256: raw.sha256 })
      } else {
        items.push({ kind: evidenceKind, path: raw.path })
      }
    }
  }
  return items
}

function operationsArray(value: unknown, field: string): SchemaFileOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a nonempty array of file operations`)
  const items: SchemaFileOperation[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new TypeError(`${field} item must be an object`)
    const raw = item as Record<string, unknown>
    const kind = raw.kind
    if (typeof kind !== 'string' || !OPERATION_KINDS.has(kind)) {
      throw new TypeError(`${field} item has an unknown operation kind: ${String(kind)}`)
    }
    const operationKind = kind as SchemaFileOperation['kind']
    const path = typeof raw.path === 'string' ? raw.path : ''
    if (path.trim() === '') throw new TypeError(`${field}.path must be a nonempty string`)
    if (operationKind === 'write') {
      const expected = raw.expected as Record<string, unknown> | undefined
      if (!expected || typeof expected !== 'object') throw new TypeError(`${field}.expected must be {absent:true} or {sha256:...}`)
      if (expected.absent === true) {
        items.push({ kind: operationKind, path, content: typeof raw.content === 'string' ? raw.content : '', expected: { absent: true } })
      } else if (typeof expected.sha256 === 'string' && /^sha256:[a-f0-9]{64}$/.test(expected.sha256)) {
        items.push({ kind: operationKind, path, content: typeof raw.content === 'string' ? raw.content : '', expected: { sha256: expected.sha256 } })
      } else {
        throw new TypeError(`${field}.expected must be {absent:true} or {sha256:...}`)
      }
    } else {
      const sha = raw.expectedSha256
      if (typeof sha !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(sha)) {
        throw new TypeError(`${field}.expectedSha256 must match sha256:<64 hex>`)
      }
      if (operationKind === 'edit') {
        const oldText = raw.oldText
        const newText = raw.newText
        if (typeof oldText !== 'string' || oldText.length === 0) throw new TypeError(`${field}.oldText must be a nonempty string`)
        if (typeof newText !== 'string') throw new TypeError(`${field}.newText must be a string`)
        items.push({ kind: operationKind, path, oldText, newText, expectedSha256: sha })
      } else {
        items.push({ kind: operationKind, path, expectedSha256: sha })
      }
    }
  }
  return items
}

function complexityInput(value: unknown): { files: string[] } {
  if (!value || typeof value !== 'object') throw new TypeError('complexity must be an object with a files array')
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.files)) throw new TypeError('complexity.files must be an array')
  if (raw.files.length === 0) throw new TypeError('complexity.files must not be empty')
  return { files: raw.files.map((item) => text(item, 'complexity.files item')) }
}
