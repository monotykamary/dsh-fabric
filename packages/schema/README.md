# dsh-fabric-schema

Schema-enforced world state, evidence digests, and fail-closed certification
for dsh-fabric — the Schema harness world-model pattern (hypothesis →
verification → certified transaction), adapted from pi-fabric's proven
`schema` and `state` layers onto DSH's durable `fabric_mesh` surface.

## What it provides

- **World state** (`state_*` tools): an append-only Timeline of labeled,
  typed transitions stored as mesh topic events, a compare-and-swap head
  pointer recomputable from the log (`state/current`), a structural
  complexity ledger (`state/complexity/*`, TS/JS/TSX/JSX decision-point
  token fold), the executable goal predicate (`state/goal`), and
  fail-closed re-verification that certifies or revokes.
- **Schema transactions** (`schema_*` tools): `schema_hypothesize` binds
  a falsifiable hypothesis plus nonempty typed evidence to the current state,
  a git-aware workspace fingerprint, and one ToolRuntime root invocation;
  `schema_verify` fail-closed confirms every evidence item against the unchanged
  fingerprint and may issue one fresh same-run single-use certificate;
  `schema_commit` consumes it in that run and atomically applies declared
  write/edit/delete operations with SHA-256 preconditions, postconditions,
  before-image journals, rollback/quarantine, and crash recovery, then records
  net committed text changes and complete-content SHA-1/SHA-256 transitions
  through the Harness mutation receipt API. `schema_abort` discards
  uncommitted artifacts, and outer `run_code` settlement abandons any remainder.
- **Enforcement** (`mode: off | audit | enforce`): every resolved ToolRuntime
  call crosses one fail-closed `tools/pre-execute` gate. `enforce` admits only
  exact observation refs, inert Code Mode transports, metadata-only mesh/model
  actions, and the certified `schema_*` channel. Shell/terminal execution,
  direct workspace or state writes, agent/workflow control, compaction, model
  switching, network/interaction, mesh writes, and unknown tools are denied.
  `audit` publishes action-level `would_block` records without denying.
- **Guidance**: a visibility-gated `fabric:schema-guidance` prompt section
  plus a `## Schema` block in the Fabric operating prompt.

## Records

All state and schema records are ordinary durable mesh records — inspectable
with `fabric_mesh` (`get_state`, `read_topic`, `snapshot`) and folded
into the same workspace-scoped durability as topics and actor mailboxes:

- topic `fabric.state`: `transition`, `transition.committed`,
  `transition.rejected`, `state.certified`, `state.violated`,
  `state.goal.met`
- topic `fabric.schema`: `hypothesized`, `verified`,
  `verification_failed`, `committed`, `rolled_back`, `quarantined`,
  `aborted`, `would_block`, `blocked`
- states: `state/current` (head), `state/goal`,
  `state/complexity/<file>`, `schema/workspace`,
  `schema/hypothesis/<id>`, `schema/certificate/<token-hash>`

## Model-facing tools

`state_get`, `state_transition`, `state_history`, `state_complexity`,
`state_verify`, `state_goal`, `state_check_goal`,
`schema_status`, `schema_hypothesize`, `schema_verify`,
`schema_commit`, `schema_abort`.

## Composition

The tool row mounts in the `fabric` agent preset
(`packages/compaction/presets/fabric/agent.cordis.yml`) so the tools and
the guidance stay fabric-scoped:

```yaml
- id: dsh-fabric-schema-tool
  name: 'dsh-fabric-schema/tool'
  config:
    mode: off        # off | audit | enforce
```

The mesh provider and storage are host-plane; the controller resolves the
agent's workspace and cwd per call through the same identity rules as the
mesh Consumer. Transaction journals and the commit lock live under the OS
temp directory, keyed by the workspace identity hash.

## Divergences from pi-fabric (documented)

- State keys are CAS-fenced mesh records; the mesh has no state delete, so a
  failed transition's absent-before ledger writes are retained (harmless —
  they only feed future delta measurements), while present-before writes are
  restored.
- DSH propagates the outer `run_code` `rootCallId` instead of pi-fabric's
  `fabric_exec` tool-call id; both identify one execution tree. Certificates
  are single-use, TTL-bounded, and abandoned when that outer call settles.
- Transaction journals live under the OS temporary directory keyed by the
  workspace identity hash rather than below pi-fabric's mesh root.
