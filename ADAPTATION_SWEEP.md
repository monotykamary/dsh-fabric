# DSH Fabric adaptation sweep

This document records the completion sweep for the focused DeepSeek Harness adaptation. It distinguishes verified behavior from upstream blockers and from pi-fabric features that were intentionally not copied.

## Boundary

The adaptation reuses DSH as the authority for tools, workflows, sessions, compaction, client navigation, and Cordis lifecycle. It adds only capabilities DSH does not already own: a checked QuickJS `CodeRuntime` provider, mesh/CAS/mailboxes, a bounded Fabric projection, and Activity/Topology presentation.

It is not a line-for-line port of pi-fabric's component system, workflow engine, agent transports, or TUI.

## Reuse and composition matrix

| Concern | Authority | Fabric contribution | Evidence | Status |
|---|---|---|---|---|
| Tool registration, policy, nested calls | DSH ToolRuntime | `fabric_mesh` Consumer | Native and Code Mode composition tests | Verified |
| Code Mode orchestration | DSH `run_code` and CodeRuntime seam | QuickJS WASM provider | `run_code` dispatches `fabric_mesh`, commits storage and session projection | Verified |
| Workflows and subagents | DSH workflow/subagent services | Projection of `tool-workflow/*` into Fabric topology | Fold tests include phases, bounded member correlation, and settlement | Verified |
| Mesh business state | DSH `storage-domain` | Topics, CAS state, actor mailboxes | Restart composition tests and claim-token replay tests | Verified |
| Session-derived Fabric UI | DSH SessionProjectionRegistry | Bounded `fabricActivity` fold | Live composition, detached serialized replay, checkpoint restore | Verified with the persistence caveat below |
| Context compaction | DSH compaction engine/provider | Compaction lifecycle projection plus reassembled mesh context | Compaction fold/replay and system-prompt assembly tests | Verified |
| Browser slots and navigation | DSH client slots and sessions service | Activity, Topology, header action | Uses `sessions.subagentAddress()` and `openSubagent()` | Verified |
| Client HMR | DSH client module loader | Package-owned CSS module update | Rebuilt bundles replace existing style-tag text | Verified by build contract |
| Component lifecycle | Cordis | Ordinary plugins/effects | No second registry or lifecycle | Verified by workspace structure |

## Compaction and continuation

The bundle does not install a second compactor. The profile retains DSH's configured compaction provider.

1. DSH remains authoritative for selecting, summarizing, replacing, and replaying compacted history.
2. `@dsh-fabric/host` folds `compaction/start`, `compaction/summary`, `compaction/end`, and `compaction/prune` into bounded Activity/Topology records without deleting existing Fabric facts.
3. `@dsh-fabric/mesh/tool` contributes bounded, metadata-only durable coordination context through DSH SystemPrompt. DSH materializes that context again after a compacted snapshot, so the model can rediscover topic, state, actor, and mailbox identifiers.
4. The prompt tells the model to inspect durable state after compaction or `TOOL_OUTCOME_UNKNOWN`, and to use CAS revisions and actor claim tokens rather than conversational memory.
5. Mesh payloads are not copied into prompt context. The context carries identifiers, statuses, revisions, counts, and truncation metadata; records are read explicitly through `fabric_mesh`.

## Blocking gap in DSH 0.1.0-rc.6

Stock DSH session persistence uses the static runtime set `KNOWN_SESSION_EVENT_TYPES` when loading logs. Declaration merging makes `fabric/activity` type-safe, but does not extend that runtime set. Because Fabric activity is intentionally required rather than `ignorable`, a persisted session containing it is rejected on reload as an unsupported format.

Consequences:

- DSH `storage-domain` mesh records remain durable and reopen correctly.
- Fabric projections reconstruct from a supplied serialized event log and survive DSH compaction.
- A stock rc.6 persistence backend cannot honestly provide restart durability for a session log containing `fabric/activity`; in practice, one Fabric mutation can make that session refuse reload.

The compatibility sentinel is `packages/host/tests/persistence-compat.spec.ts`. The correct fix is an upstream external-event registration/codec seam or native recognition of the event family, followed by a real JSONL write-close-reopen test. Marking the event `ignorable` would silently erase the projection and is not an acceptable workaround.

## Deliberately deferred parity surfaces

These are not represented as completed features:

- schema-enforced world state, evidence digests, and fail-closed certification;
- semantic memory/recall beyond DSH's existing session-query facilities;
- an always-resident actor execution host (mailboxes are durable, but a Consumer drives claims);
- a Fabric-owned workflow engine, agent transport layer, or component calculus;
- a cross-provider USD budget ledger and a Fabric audit archive;
- pi-fabric's full TUI controls, retained-run lens, settings editor, and transcript preview system.

When these are added, they should remain separate DSH capabilities. In particular, recall should compose DSH session-query rather than introduce a second transcript index, and orchestration should extend native workflow/subagent seams rather than register another executor.

## Acceptance ledger

The sweep is complete when all of the following remain true:

- `pnpm run check` passes from a clean build;
- native ToolRuntime and QuickJS Code Mode both execute `fabric_mesh` end to end;
- mesh state reopens through DSH storage composition;
- a JSON-round-tripped session log reconstructs Fabric and compaction projections;
- prompt assembly re-emits current bounded mesh metadata;
- topology settlement survives bounded edge/node eviction;
- the rc.6 persistence incompatibility stays explicit until upstream support lands;
- package manifests, licenses, bundle rows, and client artifacts pass `scripts/verify-workspace.mjs`.
