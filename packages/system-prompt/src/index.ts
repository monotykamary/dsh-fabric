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
 * @module @dsh-fabric/system-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = '@dsh-fabric/system-prompt'

/** The prompt registry this override contributes to and minimizes. */
export const inject = ['systemPrompt']

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
  "Compaction is deterministic — it never makes an auxiliary model call. After '/compact', rediscover durable identifiers through 'fabric_mesh' and re-read state; never trust prior checkpoint prose.",
  '',
  '## Code Mode',
  "Inside 'run_code', call tools as 'await tools.name(args)'; a failed call rejects with 'ToolCallError' — catch it to continue.",
  "Overlap independent read-only calls under 'Promise.all'; sequence dependent work.",
  "Only what you 'return' or print comes back — curate results, because intermediate tool output never enters context.",
  "Search before reading: 'grep'/'glob' first, then bounded 'read' with 'offset'/'limit'.",
  '',
  '## Delegation',
  "Delegate self-contained work to subagents in the background by default and start independent delegations together.",
  "Use 'workflow' only for large multi-agent orchestration the user asks for; prefer plain subagents for one or two delegations.",
  "Track background jobs; collect still-relevant results before finishing and kill jobs that stop mattering.",
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
  'fabric:system-prompt',
  'plan:policy',
  'tool:cordis',
  'tool:report',
  'tool:session-query',
  'fabric:mesh-guidance',
  'tools:code-only',
  'tools:sdk',
])

/**
 * Register the Fabric operating prompt and minimize the assembled
 * native prose. The listener defers through 'next()' so it sees the
 * waterfall's authoritative result, then keeps only PRESERVED_SECTIONS.
 * Tool schemas, dynamic runtime context, and prompt variables pass
 * through untouched.
 * @param ctx - host context carrying the prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'fabric:system-prompt',
    order: 10,
    text: FABRIC_SYSTEM_PROMPT,
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return {
      ...assembled,
      sections: assembled.sections.filter(section => PRESERVED_SECTIONS.has(section.name)),
    }
  }, { global: true, prepend: true })
}
