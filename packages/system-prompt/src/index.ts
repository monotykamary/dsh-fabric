/**
 * Fabric-owned system prompt for DeepSeek Harness.
 *
 * Captures pi-fabric's well-tuned long-horizon operating disciplines
 * (durable coordination, deterministic compaction recovery, code-mode
 * economy, delegation fan-out, error recovery) as one high-priority
 * prompt section, adapted to DSH's run_code/fabric_mesh/subagent/
 * workflow surfaces.
 *
 * The native DSH prose is then minimized through the authoritative
 * 'system-prompt/assemble' waterfall: per-tool guidance sections whose
 * content the tool schemas already carry are dropped, while structural
 * and dynamic sections are preserved (persona, plan policy, cordis
 * toolset, subagent reporting, Code-Mode SDK/collapse rules, the mesh
 * guidance). Tool schemas and contexts are not filtered.
 *
 * Progressive disclosure: the generated `tools:sdk` catalog block keeps full
 * declarations for the core tool set (see disclosure.ts) and replaces every
 * optional declaration with a names-only roster. The model resolves unfamiliar
 * names on demand through run-scoped `tools.describe()` / `tools.call()`, matching
 * current pi-fabric without heuristic, turn-varying advisory messages.
 *
 * Scoping: the plugin mounts inside the `fabric` agent preset (see
 * cordis.patch.yml / presets/fabric/agent.cordis.yml), so the sections and
 * assemble listener apply only to fabric agents and their subagents. Other
 * presets' assemblies are never minimized or spliced.
 * @module dsh-fabric-system-prompt
 */

import type { Context } from '@monotykamary/cordis'
import type { PromptAssembly } from '@monotykamary/dsh-system-prompt'
import type {} from '@monotykamary/dsh-system-prompt'
import type {} from '@monotykamary/dsh-tools'
import { discloseSdkSection, DISCLOSURE_CORE_TOOLS } from './disclosure.ts'

/** Cordis plugin name. */
export const name = 'dsh-fabric-system-prompt'

/** The prompt registry this scoped override contributes to. */
export const inject = ['systemPrompt']

export {
  discloseSdkSection,
  DISCLOSURE_CORE_TOOLS,
  renderSdkRoster,
  SDK_CATALOG_MARKER,
  SDK_ROSTER_MARKER,
  sdkBlockEntryNames,
  spliceSdkBlock,
} from './disclosure.ts'

/**
 * The Fabric operating prompt: the bare minimums of pi-fabric's
 * guidance, adapted to DeepSeek Harness. Registered at order 10 so it
 * renders right after the persona and before any tool guidance.
 */
export const FABRIC_SYSTEM_PROMPT = [
  '# Fabric operating rules',
  '',
  "You are a Fabric agent on DeepSeek Harness. DSH ToolRuntime, sessions, and Cordis remain the authorities for tools, policy, and lifecycle. Never trust conversational memory for state a durable read can settle — inspect files, sessions, and 'fabric_mesh' before resuming uncertain work.",
  '',
  '## Durable coordination',
  "'fabric_mesh' is the coordination boundary for state that must survive tool calls, fresh 'run_code' runtimes, subagent handoffs, or compaction. Read 'snapshot', topics, state, and actor mailboxes before uncertain mutations.",
  "Compare-and-swap with the last observed 'expected_version' (revision '0' creates an absent key); on conflict, re-read before retrying.",
  "Actor commands are claim-token fenced: settle with the exact token from 'claim_actor_message', and expect replays to return the stored terminal outcome.",
  "'TOOL_OUTCOME_UNKNOWN' means the side effect may have happened — inspect durable state before retrying.",
  "'run_code' evaluations are fresh; persist cross-run identifiers through 'fabric_mesh', not JavaScript globals.",
  '',
  '## Compaction',
  "Compaction is deterministic — it never makes an auxiliary model call. After '/compact', rediscover durable identifiers through 'fabric_mesh', re-read state, and recall dropped context with 'session_search' before resuming; never trust prior checkpoint prose.",
  '',
  '## Memory',
  "Prior sessions are the durable record. Recall with 'session_search' (cross-session; the caller session is excluded) or 'session_event_search' (one session); 'session_trace'/'session_event_trace'/'session_event_read' recover lineage and exact data.",
  '',
  '## Schema',
  "The world model is a labeled state machine plus a falsifiable transaction gate: 'state_get'/'state_transition'/'state_history'/'state_verify' manage the certified head, and 'schema_hypothesize'/'schema_verify'/'schema_commit'/'schema_abort' bind typed evidence and SHA-256 preconditions to workspace transactions. Never claim world state from conversation — read 'state_get' and 'schema_status' first, and route workspace mutations through 'schema_commit' when the gate is enforcing.",
  '',
  '## Code Mode',
  "Inside 'run_code', call tools as 'await tools.name(args)'; a failed call rejects with 'ToolCallError' — catch it to continue.",
  "Overlap independent read-only calls under 'Promise.all'; sequence dependent work.",
  "Only what you 'return' or print comes back — curate results, because intermediate tool output never enters context.",
  "Search before reading: 'grep'/'glob' first, then bounded 'read' with 'offset'/'limit'.",
  "Tool contracts are progressively disclosed: 'tools.describe(name)' returns the exact arguments of a tool the prompt does not list. Match its shape before calling; retry from validation errors, never guess.",
  '',
  '## Delegation',
  "For one independent task, call 'await tools.subagent({ description, prompt, provider, model })' inside 'run_code'. Omit provider/model to inherit the current route; when provider is set, model is required.",
  "'subagent' runs in the background by default, returns a durable child id, and sends a settlement notice automatically. It is not a 'job_*' task; continue useful work instead of polling or collecting it.",
  "Use 'subagent_fork' only when the child needs completed parent turns. Start independent delegations together; reserve 'workflow' for explicit multi-agent orchestration.",
  '',
  '## Discipline',
  "Check the '[exit code: N]' marker on every bash result and investigate before moving on.",
  "Use the read/grep/glob/edit/write tools, not shell equivalents.",
  "Read errors, inspect schemas, and retry from the validation error instead of guessing.",
  "Verify with the repository check/test commands after changes.",
  "When you create or modify files, mention the primary outputs as Markdown inline-code paths in your final response.",
].join('\n')

/**
 * Prompt sections the minimization preserves. Everything else — the
 * native per-tool guidance one-liners whose content the tool schemas
 * already carry — is dropped. Preserved names are structural or
 * dynamic: identity and persona, plan policy, the cordis toolset
 * self-modification guidance, subagent reporting, the Code-Mode SDK
 * and collapse rules, and the Fabric mesh guidance.
 */
export const PRESERVED_SECTIONS = new Set([
  'harness:identity',
  'harness:source',
  'app:web-surface',
  'deployment:persona',
  'user:system-instructions',
  'fabric:system-prompt',
  'plan:policy',
  'tool:cordis',
  'tool:report',
  'tool:session-query',
  'fabric:memory-guidance',
  'fabric:mesh-guidance',
  'fabric:schema-guidance',
  'tools:code-only',
  'tools:sdk',
])

/**
 * Fabric memory guidance: pi-fabric's recall discipline adapted to DSH's
 * session-query tools. Registered as a visibility-gated section (empty while
 * the fabric preset does not compose the session-query toolset) so the
 * minimization keeps it without dangling prose in foreign scopes.
 */
export const MEMORY_GUIDANCE = [
  '## Fabric memory',
  '',
  "Session search is the semantic memory/recall surface: prior sessions, not the live transcript, are the durable record.",
  '',
  "- 'session_search' recalls relevant work from PRIOR sessions — the caller session is excluded — ranked by the strongest matching event, workspace-scoped, and filterable by session, creation time, parent, event type/surface, and event time.",
  "- 'session_event_search' searches EARLIER events in one session (the current session covers only events before the active step); pass 'session_id' to target another session.",
  "- Follow a useful hit with 'session_event_read' (exact data plus a bounded context window), 'session_event_trace' (replacement and citation links), or 'session_trace' (ancestor/descendant lineage) instead of guessing.",
  "- After '/compact', re-establish dropped context by recalling from memory before resuming — never trust prior checkpoint prose.",
].join('\n')

/**
 * Whether the fabric scope exposes the DSH session-query toolset (the
 * memory/recall surface). Resolved lazily through the tool registry so the
 * guidance degrades to an empty section in compositions without it.
 */
function sessionSearchVisible(ctx: Context, context: { scope?: unknown }): boolean {
  try {
    const registry = ctxTools(ctx)
    if (registry === undefined) return false
    return registry.get('session_search', context.scope) !== undefined
  } catch {
    return false
  }
}

/** The host tool registry, when composed; undefined otherwise. */
function ctxTools(ctx: Context): { get(name: string, scope?: unknown): unknown } | undefined {
  try {
    return ctx.get('tools') as { get(name: string, scope?: unknown): unknown }
  } catch {
    return undefined
  }
}

/**
 * Register the Fabric operating prompt and minimize the assembled
 * native prose, then apply progressive disclosure to the generated SDK
 * block. The listener defers through 'next()' so it sees the
 * waterfall's authoritative result, then keeps only PRESERVED_SECTIONS
 * and splices the `tools:sdk` catalog down to the core tool set.
 * Tool schemas, dynamic runtime context, and prompt variables pass
 * through untouched.
 *
 * Fabric-scoped: this plugin mounts inside the `fabric` agent preset,
 * so the section registration and assemble listener resolve to that preset's
 * standing scope. The listener omits the `global` flag on purpose — a global
 * listener would receive every preset's assemblies and minimize them too.
 * @param ctx - host context carrying the prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'fabric:system-prompt',
    order: 10,
    text: FABRIC_SYSTEM_PROMPT,
  })
  // Memory/recall guidance: empty unless the fabric preset composes the DSH
  // session-query toolset (see presets/fabric/agent.cordis.yml), so foreign
  // scopes and deployments without the tools never see dangling prose.
  ctx.systemPrompt.section({
    name: 'fabric:memory-guidance',
    order: 114,
    text: context => sessionSearchVisible(ctx, context) ? MEMORY_GUIDANCE : '',
  })
  ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, _context, next) => {
    const assembled = await next()
    return {
      ...assembled,
      sections: assembled.sections
        .filter(section => PRESERVED_SECTIONS.has(section.name))
        .map(section => section.name === 'tools:sdk'
          ? { ...section, text: discloseSdkSection(section.text, DISCLOSURE_CORE_TOOLS) }
          : section),
    }
  }, { prepend: true })
}
