# DSH Fabric adaptation sweep

This document records the completion sweep for the focused DeepSeek Harness adaptation. It distinguishes verified behavior from upstream blockers and from pi-fabric features that were intentionally not copied.

## Boundary

The adaptation reuses DSH as the authority for tools, workflows, sessions, the compaction service/transaction seam, client navigation, and Cordis lifecycle. It adds a deterministic Fabric compaction provider and a host-native roster restricted to Fabric-owned presets, a checked QuickJS `CodeRuntime` provider, mesh/CAS/mailboxes, a bounded Fabric projection, Activity/Topology presentation, and a semantic memory/recall surface over DSH's native session-query facilities.

It is not a line-for-line port of pi-fabric's component system, workflow engine, agent transports, or TUI. FabricParticipantRecord is a host-independent read projection over the DSH session mirror and Fabric actors; it does not create a second participant directory, executor, or control plane.

## Reuse and composition matrix

| Concern | Authority | Fabric contribution | Evidence | Status |
|---|---|---|---|---|
| Tool registration, policy, nested calls | DSH ToolRuntime | `fabric_mesh` Consumer | Native and Code Mode composition tests | Verified |
| Code Mode orchestration | DSH `run_code` and CodeRuntime seam | QuickJS WASM provider | `run_code` dispatches `fabric_mesh`, commits storage and session projection | Verified |
| Workflows and subagents | DSH workflow/subagent services | Activity projection plus semantic agent participants | Fold tests include phases, bounded member correlation, settlement, and participant derivation | Verified |
| Mesh business state | DSH `storage-domain` | Topics, CAS state, actor mailboxes | Restart composition tests and claim-token replay tests | Verified |
| Session-derived Fabric UI | DSH SessionProjectionRegistry | Bounded `fabricActivity` fold over native `tool/result.meta`, `tool/code-dispatch`, workflow, and compaction events | Live composition, native-event serialized replay, checkpoint restore | Verified |
| Context compaction | DSH service, token meter, command, durable transaction, invariants | Exclusive Fabric deterministic compiler/provider, source-event reconstruction, bounded typed snapshots, masked preset roster, lifecycle projection, reassembled mesh context | Real `/compact`, recursive source recovery, compiler/activity/provenance, preset-mask, standing-mount, fold/replay, and system-prompt tests | Verified |
| System prompt and continuation surfaces | DSH SystemPrompt registry and assemble waterfall | Fabric-owned operating prompt section plus a waterfall listener that minimizes native prose; DSH todo ledger, goal tools, `/goal`, goal round driver, and goal bar masked | Preserved structural/dynamic sections, dropped per-tool one-liners, and masked todo/goal rows verified by `scripts/verify-workspace.mjs` | Verified |

| Browser slots and navigation | DSH client slots and sessions service | Activity, grouped participant/mesh Topology, header action | Left-to-right structural layout, deterministic keyboard navigation, and authoritative session opening | Verified |
| Client HMR | DSH client module loader | Package-owned CSS module update | Rebuilt bundles replace existing style-tag text | Verified by build contract |
| Component lifecycle | Cordis | Ordinary plugins/effects | No second registry or lifecycle | Verified by workspace structure |

## Compaction and continuation

The bundle installs one Fabric compaction backend and masks every stock DSH backend/pruner composition row. DSH still owns the abstract service contract, token meter, `/compact` command, durable lock and surface-replacement transaction, persistence flush, and compaction invariants.

1. `dsh-fabric-compaction` subclasses DSH's supported `BasicCompactionEngine` extension point, replacing its model summarizer with a deterministic Fabric compiler while reusing the audited range selection and durable transaction.
2. The root layer disables `compaction-basic`, `tool-result-pruner`, and `agent-presets`, then inserts the Fabric engine plus a Fabric-owned roster. All five pinned presets compose one isolated Fabric engine and the backend-independent DSH command; none composes the stock backend or pruner.
3. Typed DSH messages are normalized without reasoning blocks. Native `tool/result.meta`, paired `tool/code-dispatch-start`/`tool/code-dispatch`, and `tool-workflow/*` lifecycle events supply structured Fabric runs, phases, and operations. Graded projections preserve goals, exact file operations, Fabric activity, unresolved and resolved failures, earlier turns, current status, and a bounded recent transcript.
4. The adapter reconstructs cumulative originals by recursively following immutable `sourceEventSeqs` citations and excludes generated checkpoint prose. Each summary still carries a bounded strict snapshot in `rawOutput` for diagnostics and detached compiler callers, but the adapter never trusts that snapshot as the next compaction source.
5. `dsh-fabric-host` folds `compaction/start`, `compaction/summary`, and `compaction/end` into bounded Activity/Topology records without deleting existing Fabric facts. Stock `compaction/prune` is no longer emitted while Fabric is active because the stock pruner is masked.
6. `dsh-fabric-mesh/tool` contributes count- and byte-bounded, metadata-only durable coordination context through DSH SystemPrompt. DSH materializes that context after a compacted checkpoint, so the model can rediscover topic, state, actor, and mailbox identifiers.
7. Removing the bundle restores exact pre-existing direct dependency specifications, removes only locally owned links, and reveals the inherited DSH preset roster and stock per-preset compaction composition without overriding independent overlays.

## Progressive tool disclosure

The `dsh-fabric-system-prompt` row now applies progressive disclosure to the generated `tools:sdk` catalog block, porting pi-fabric's split between always-on ambient guidance and on-demand references:

1. **Tiered SDK block** (`src/disclosure.ts`): the assemble listener splices the rendered type block down to the core tool set (`DISCLOSURE_CORE_TOOLS` — bash, read, grep, glob, edit, write, ask_user_question, job_*, exit_plan_mode). Removed tools stay registered and callable; only the prompt shrinks. The guest type checker is built from the binding map, so programs may still call every tool. The intro, fences, and all other sections stay byte-identical.
2. **Runtime discovery** (`dsh-fabric-code-runtime-quickjs`): the QuickJS provider wraps the DSH-built `tools` namespace with `tools.describe(name)` (contract lookup against the per-agent catalog published at `agent/pre-step`) and `tools.call({ name, args })` (dispatch through the exact binding closures, preserving ordering and exclusive-call policy). Guest errors now carry their message beside the stack, and the ported pi `typeErrorRecoveryHint` names edit/write payload syntax failures.
3. **Capability advisory with combustion** (`src/advisory.ts`): the pi-fabric hint engine — 1/df scoring over tool name + first-sentence descriptions, pi's exact stopword list and tokenizer, the two-word gate, phrase window 2τ, warmth EWMA with retention 1 − 1/τ, scatter cap q = 1, threshold θ = 0.9, and a burned-namespace fire budget (default 3 per session branch). Fired hints are injected as bounded `fabric-advisory` user messages (budget ≈512 tokens) listing matched tools with `tools.describe()` pointers.

Documented v1 divergences from pi: the advisor scores current user messages only (not the assembled prompt); habituation episodes, the script-boundary exception, and smoke feedback are not ported; ash state is per-agent in-memory (not yet transcript- or CAS-derived); skills are carried by the entry model but not yet scored.

## Native persistence and legacy logs

New Fabric activity does not append a plugin-owned event family. Top-level mesh calls attach validated presentation metadata to DSH-native `tool/result` events, Code Mode contributes native `tool/code-dispatch*` events, and the host projection folds those together with DSH workflow and compaction events. `packages/host/tests/persistence-compat.spec.ts` verifies the native event path survives JSON round-trip and projection rebuild.

DSH `0.1.0-rc.6` still cannot reload older session logs that already contain the retired required `fabric/activity` event: its persisted-event allowlist is static. Mesh business records remain durable in `storage-domain`, but legacy session-log replay requires an upstream external-event codec seam or an explicit offline conversion. This caveat applies only to pre-native-event logs; new Fabric mutations do not create it.

## Semantic memory and recall

pi-fabric's `memory` provider is not ported as a second transcript index. Fabric memory composes DSH's native session-query facilities, which the base bundles mount but leave search-disabled:

1. `cordis.patch.yml` restates `session-query-sqlite` with a durable `dshHomePath('session-query')` index and `openAt: first-search`, overriding the base/web-app layers' `openAt: never`. The service's exact reads and lineage traces were already mounted; this enables SQLite FTS5, deferring the `node:sqlite` import to the first search (the harness's lazy-search startup posture).
2. The `fabric` preset mounts `@monotykamary/dsh-tool-session-query`, registering DSH's five model-facing tools: `session_search` (cross-session recall; the caller session is excluded, workspace-scoped), `session_event_search` (one session; the current session covers only pre-step events), `session_trace`, `session_event_trace`, and `session_event_read` (lineage and exact-data recovery).
3. `dsh-fabric-system-prompt` registers a visibility-gated `fabric:memory-guidance` section (kept by the minimization) plus a `## Memory` block in the Fabric operating prompt; the compaction block now points at `session_search` for re-establishing dropped context after `/compact`.

Deployment note: the dsh CLI resolves a profile bundle's patch from its own installation node_modules before the profile directory (installation-first), so a checkout-linked bundle can be shadowed by a published copy. The `session-query-sqlite` restatement therefore also ships in the profile's user patch layer (the live `web` profile carries it), which is applied after every bundle layer and hot-reloaded.

Functional parity with pi's `memory` provider:

| pi memory | dsh-fabric surface |
|---|---|
| `memory.recall(query, scope, filters, paging)` | `session_search` (project/global scope) and `session_event_search` (session scope), with session/event filters and paging |
| `memory.expand(session, range/ids)` | `session_event_read` / `session_event_trace` |
| `memory.sessions(scope)` | no model-facing list tool; `ctx.sessionQuery.listSessions` is the service seam if a browse tool is ever wanted |
| literal token search | FTS5 literal query over the live-preferred corpus (query text sanitized by DSH) |
| regex query mode | not ported; DSH search is literal-token FTS |
| role/tool/ref/provider/action/outcome filters | DSH event-type/surface/time/seq filters (pi's taxonomy is pi's own) |
| source-hash / lineage staleness guards | DSH cursor generations and `session_trace` lineage replace pointer hashes |
| hot/cold tiers and digests | one live-preferred FTS5 index; no separate tiered index |
| guest `memory` global | Code Mode guests call `tools.session_search(...)` through the same `tools` namespace; `tools.describe()` discloses it |

## Deliberately deferred parity surfaces

These are not represented as completed features:

- schema-enforced world state, evidence digests, and fail-closed certification;
- an always-resident actor execution host (mailboxes are durable, but a Consumer drives claims);
- a Fabric-owned workflow engine, agent transport layer, or component calculus;
- a cross-provider USD budget ledger and a Fabric audit archive;
- pi-fabric's full TUI controls, retained-run lens, settings editor, and transcript preview system.

When these are added, they should remain separate DSH capabilities. Memory/recall composes DSH session-query (see "Semantic memory and recall") rather than a second transcript index, and orchestration should extend native workflow/subagent seams rather than register another executor.

## Acceptance ledger

The sweep is complete when all of the following remain true:

- `pnpm run check` passes from a clean build;
- native ToolRuntime and QuickJS Code Mode both execute `fabric_mesh` end to end;
- mesh state reopens through DSH storage composition;
- `/compact` commits a deterministic Fabric summary without an auxiliary LLM call, and later compaction recursively reconstructs the cited original source events rather than checkpoint prose;
- all five Fabric preset compositions contain exactly one automatic Fabric compactor and no stock compactor/pruner, and a linked no-server profile can standing-mount all five through the host-native roster;
- a JSON-round-tripped session log reconstructs Fabric and compaction projections;
- prompt assembly re-emits current count- and byte-bounded mesh metadata from detached authoritative records;
- topology settlement survives bounded edge/node eviction;
- fabric sessions expose `session_search`/`session_event_search`/`session_trace`/`session_event_trace`/`session_event_read` over an enabled durable FTS index, and the assembled prompt carries `fabric:memory-guidance`;
- the rc.6 incompatibility of legacy logs containing the retired `fabric/activity` event stays explicit;
- `cordis.patch.yml` disables `command-goal`, `goal-round-driver`, and `ui-goal`, and every Fabric preset either masks `tool-todo`/`tool-goal` or omits them (`minimal`);
- prompt assembly keeps the Fabric operating prompt plus the persona, plan policy, cordis toolset, subagent reporting, Code-Mode SDK/collapse sections, and mesh guidance while dropping the native per-tool prose, with tool schemas and the runtime-context snapshot untouched.

- package manifests, licenses, exclusive compaction masks, localized client dictionaries, bundle rows, and client artifacts pass `scripts/verify-workspace.mjs`.
