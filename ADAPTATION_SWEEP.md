# DSH Fabric adaptation sweep

This document records the completion sweep for the focused DeepSeek Harness adaptation. It distinguishes verified behavior from upstream blockers and from pi-fabric features that were intentionally not copied.

## Boundary

The adaptation reuses DSH as the authority for tools, workflows, sessions, the compaction service/transaction seam, client navigation, and Cordis lifecycle. It adds a deterministic Fabric compaction provider and a host-native roster restricted to Fabric-owned presets, a checked QuickJS `CodeRuntime` provider, mesh/CAS/mailboxes, a bounded Fabric projection, Activity/Topology presentation, a semantic memory/recall surface over DSH's native session-query facilities, and a schema-enforced world state with evidence digests and fail-closed certification.

It is not a line-for-line port of pi-fabric's component system, workflow engine, agent transports, or TUI. FabricParticipantRecord is a host-independent read projection over the DSH session mirror and Fabric actors; it does not create a second participant directory, executor, or control plane.

## Reuse and composition matrix

| Concern | Authority | Fabric contribution | Evidence | Status |
|---|---|---|---|---|
| Tool registration, policy, nested calls | DSH ToolRuntime | `fabric_mesh` Consumer | Native and Code Mode composition tests | Verified |
| Session model selection | DSH API proxy `sessionModels` service (the `session.models`/`session.selectModel` authority) | `fabric_models` Consumer (current/list/select, alias fallback chains) plus exact provider/model routes on native delegation surfaces | `packages/models` Consumer spec; DSH cross-provider subagent and agent-team route tests | Verified |
| Code Mode orchestration | DSH `run_code` and CodeRuntime seam | QuickJS WASM provider | `run_code` dispatches `fabric_mesh`, commits storage and session projection | Verified |
| Speculative programmatic tool calls | DSH ToolRuntime policy/dispatch and agent-loop stream ownership | Lazy TypeScript literal scanner; unforgeable owner-scoped take-once cache; read/no-effect registration gate; canonical workspace confinement; `read` version and full `glob`/`grep` serve-time revalidation; entry/flight/stream/retained-byte/TTL bounds; live `tool-speculation` settings card | Parser/store units, owner collision and final-identity cases, real streamed agent-loop call, policy denial, mutation/freshness fallback, symlink/outside-workspace filesystem suites, settings controller/runtime tests | Verified |
| Workflows and subagents | DSH workflow/subagent/command services | Exact background-first prompt recipe, `/delegate`, Activity projection, and semantic agent participants | DSH command start/route/lifecycle tests; prompt, fold, settlement, and participant tests | Verified |
| Mesh business state | DSH `storage-domain` | Topics, CAS state, actor mailboxes | Restart composition tests and claim-token replay tests | Verified |
| Session-derived Fabric UI | DSH SessionProjectionRegistry | Bounded `fabricActivity` fold over native `tool/result.meta`, `tool/code-dispatch`, workflow, and compaction events | Live composition, native-event serialized replay, checkpoint restore | Verified |
| Context compaction | DSH service, token meter, command, durable transaction, invariants | Exclusive Fabric deterministic compiler/provider, source-event reconstruction, bounded typed snapshots, masked preset roster, lifecycle projection, reassembled mesh context | Real `/compact`, recursive source recovery, compiler/activity/provenance, preset-mask, standing-mount, fold/replay, and system-prompt tests | Verified |
| System prompt and continuation surfaces | DSH SystemPrompt registry and assemble waterfall | Fabric-owned operating prompt section plus a waterfall listener that minimizes native prose; DSH todo ledger, goal tools, `/goal`, goal round driver, and goal bar masked | Preserved structural/dynamic sections, dropped per-tool one-liners, and masked todo/goal rows verified by `scripts/verify-workspace.mjs` | Verified |
| Schema world state and certification | DSH storage-domain mesh records + ToolRuntime pre-execute gate | Append-only transition Timeline with CAS head (`state/current`), complexity ledger, executable goal, fail-closed re-verification, and the hypothesis → certificate → commit workspace transaction gate | State/schema controller suites, ToolRuntime composition, and enforce/audit pre-execute tests | Verified |

| Browser slots and navigation | DSH client slots, settings scope, and sessions service | Activity, grouped participant/mesh Topology, and bilingual Schema/speculation settings cards | Left-to-right structural layout, deterministic keyboard navigation, authoritative session opening, and settings controller/build suites | Verified |
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

The `dsh-fabric-system-prompt` row now applies progressive disclosure to the generated `tools:sdk` catalog block, matching current pi-fabric's split between full core contracts, an ambient names-only roster, and deterministic on-demand discovery:

1. **Tiered SDK block** (`src/disclosure.ts`): the assemble listener keeps full declarations for the core tool set (`DISCLOSURE_CORE_TOOLS` — bash, read, grep, glob, edit, write, ask_user_question, job_*, exit_plan_mode) and removes optional schema bodies. DSH's fixed `describe`/`call` declarations, intro, fences, and guest typechecking remain intact.
2. **Names-only roster**: every removed tool name is deduplicated, sorted, and appended as compact JSON. The model can proactively notice `subagent`, `fabric_mesh`, `workflow`, skills, session search, and other optional capabilities without paying for all descriptions and schemas. JSON encoding prevents a plugin-supplied name from injecting roster prose.
3. **Runtime discovery** (DSH `ToolRuntime`): every `run_code` execution receives `tools.describe(name)` from the executing agent's catalog snapshot and `tools.call({ name, args })` through the ordinary nested scheduler. The QuickJS provider only typechecks and executes the bindings DSH supplies, so concurrent sessions cannot race through a process-global latest catalog. The ported pi `typeErrorRecoveryHint` still names edit/write payload syntax failures.

Current pi-fabric deliberately removed capability combustion after its names-only roster made heuristic prompt matching unnecessary. DSH now follows that decision: there is no per-turn advisory engine, ash ledger, prompt-derived hint injection, or `fabric-advisory` message source.

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

## Schema-enforced world state and certification

The Schema harness world-model pattern (state grounding + falsifiable mechanism hypotheses, verified by typed evidence, committed through certified transactions) is ported from pi-fabric's proven `state`/`schema` layers as `dsh-fabric-schema`:

1. **World state** (`state_transition`/`state_get`/`state_history`/`state_verify`/`state_complexity`/`state_goal`/`state_check_goal`): an append-only Timeline of labeled, typed transitions stored as mesh topic events on `fabric.state` (proposal → committed marker with CAS head proof, rejected/quarantine rollback events), a compare-and-swap head pointer at `state/current` recomputable from the log, the structural complexity ledger (`state/complexity/*`, TS/JS/TSX/JSX decision-point token fold), and the executable goal predicate at `state/goal`.
2. **Schema transactions** (`schema_hypothesize`/`schema_verify`/`schema_commit`/`schema_abort`/`schema_status`): `schema_hypothesize` durably binds a falsifiable hypothesis plus nonempty typed evidence (`file_exists`/`file_absent`/`file_contains`/`file_sha256`/`trusted_command`) to the current state binding, a git-aware workspace fingerprint, and the outer ToolRuntime `rootCallId`; `schema_verify` fail-closed re-snapshots the workspace, confirms every evidence item against the unchanged fingerprint, and may issue one fresh same-run single-use certificate (TTL-bounded, token-hashed at `schema/certificate/*`); `schema_commit` consumes the certificate in that execution tree and atomically applies declared write/edit/delete operations with SHA-256 preconditions, before-image journals, no-outside-drift checks, postconditions, rollback/quarantine on failure, crash recovery, and a follow-on `state_transition` (`schema:…` → `schema-commit-N`). Outer `run_code` settlement abandons unfinished hypotheses and certificates.
3. **Enforcement** (mode `off`/`audit`/`enforce`, default `off`): every resolved call crosses the ToolRuntime `tools/pre-execute` waterfall. `enforce` admits an exact observation allowlist, inert `run_code`/discovery transports, action-level mesh/model reads, and the certified `schema_*` channel; it fails closed on shell/terminal execution, direct workspace/state/mesh writes, agent/workflow control, compaction, model switching, network/interaction, and unknown tools. `audit` preserves behavior while publishing action-level `would_block` events. Evidence commands run only through the controller's bounded trusted-command runner. `fabric:schema-guidance` (preserved by minimization) plus the `## Schema` operating block carry the discipline to the model.
4. **Records are ordinary mesh records**: `fabric.state` and `fabric.schema` topic events plus `state/current`, `state/goal`, `state/complexity/*`, `schema/workspace`, `schema/hypothesis/*`, `schema/certificate/*` states — inspectable with `fabric_mesh` and folded into the same workspace-scoped durability as topics and mailboxes.

Documented divergences from pi: DSH uses the outer `run_code` `rootCallId` where pi uses the `fabric_exec` call id (equivalent one-execution-tree authority); mesh state has no delete, so an absent-before ledger write survives a failed transition's rollback and only feeds future delta measurements; transaction journals live under the OS temp directory keyed by workspace identity hash rather than below the mesh root.

## Deliberately deferred parity surfaces

These are not represented as completed features:

- an always-resident actor execution host (mailboxes are durable, but a Consumer drives claims);
- a Fabric-owned workflow engine, agent transport layer, or component calculus;
- a cross-provider USD budget ledger and a Fabric audit archive;
- pi-fabric's full TUI controls, retained-run lens, broad component settings editor, and transcript preview system (Fabric now ships focused Schema and speculative PTC cards through DSH's native settings surface).

When these are added, they should remain separate DSH capabilities. Memory/recall composes DSH session-query (see "Semantic memory and recall") rather than a second transcript index, world state and certification compose the durable mesh and the ToolRuntime policy seams (see "Schema-enforced world state and certification") rather than a second store or executor, and orchestration should extend native workflow/subagent seams rather than register another executor.

## Acceptance ledger

The sweep is complete when all of the following remain true:

- `bun run check` passes from a clean build;
- native ToolRuntime and QuickJS Code Mode both execute `fabric_mesh` end to end;
- Fabric composition enables speculative PTC while Harness remains safe-off by default; streamed literal `read`/`glob`/`grep` calls may prefetch, but final-code/owner mismatch, policy denial, argument/definition drift, mutation epochs, full search revalidation, workspace confinement, cancellation, parser failure, and entry/flight/stream/retained-byte/TTL caps all fall back without bypassing the natural ToolRuntime pipeline;
- the bilingual **Speculative Code Mode** settings card persists the live `tool-speculation` namespace and changing bounds cancels unserved hidden work;
- mesh state reopens through DSH storage composition;
- `/compact` commits a deterministic Fabric summary without an auxiliary LLM call, and later compaction recursively reconstructs the cited original source events rather than checkpoint prose;
- all five Fabric preset compositions contain exactly one automatic Fabric compactor and no stock compactor/pruner, and a linked no-server profile can standing-mount all five through the host-native roster;
- a JSON-round-tripped session log reconstructs Fabric and compaction projections;
- prompt assembly re-emits current count- and byte-bounded mesh metadata from detached authoritative records;
- topology settlement survives bounded edge/node eviction;
- fabric sessions expose `session_search`/`session_event_search`/`session_trace`/`session_event_trace`/`session_event_read` over an enabled durable FTS index, and the assembled prompt carries `fabric:memory-guidance`;
- fabric sessions expose `state_transition`/`state_get`/`state_history`/`state_verify`/`state_complexity`/`state_goal`/`state_check_goal` and `schema_status`/`schema_hypothesize`/`schema_verify`/`schema_commit`/`schema_abort` over durable mesh records, `schema_commit` advances the state head and generation with rollback/quarantine on failure, and the assembled prompt carries `fabric:schema-guidance` plus the `## Schema` operating block;
- `mode: enforce` fails closed across the complete ToolRuntime surface, preserving only exact reads, inert Code Mode transports, action-level mesh/model observations, and same-`run_code` certified transactions; the real QuickJS bridge proves shell and mesh-write containment, atomic commit, `rootCallId` ownership, and outer-run abandonment, while `audit` records action-level `would_block` refs without denying;
- the rc.6 incompatibility of legacy logs containing the retired `fabric/activity` event stays explicit;
- `cordis.patch.yml` disables `command-goal`, `goal-round-driver`, and `ui-goal`, and every Fabric preset either masks `tool-todo`/`tool-goal` or omits them (`minimal`);
- prompt assembly keeps the Fabric operating prompt plus the persona, trusted user system instructions, plan policy, reporting, Code-Mode discovery/SDK/collapse sections, and mesh guidance while dropping native per-tool prose, with tool schemas and runtime context untouched;
- the operating prompt contains the exact background-first `tools.subagent({ description, prompt, provider, model })` recipe, and each delegation-capable preset exposes exactly one fresh-first `/delegate` command with configured fork support;
- package manifests, licenses, exclusive compaction masks, localized client dictionaries, bundle rows, and client artifacts pass `scripts/verify-workspace.mjs`.
