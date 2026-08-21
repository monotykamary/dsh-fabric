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
  a falsifiable hypothesis plus nonempty typed evidence to the current state
  and a git-aware workspace fingerprint; `schema_verify` fail-closed
  confirms every evidence item against the unchanged fingerprint and may
  issue one fresh session-bound single-use certificate; `schema_commit`
  consumes the certificate and atomically applies declared write/edit/delete
  operations with SHA-256 preconditions, postconditions, before-image
  journals, rollback/quarantine, and crash recovery; `schema_abort`
  discards uncommitted artifacts.
- **Enforcement** (`mode: off | audit | enforce`): in `enforce` mode the
  `tools/pre-execute` gate denies direct `edit`/`write` calls with the
  Schema route; `audit` publishes `would_block` events without denying.
  Shell-produced mutations are outside this gate (pi-fabric's prewalk
  shell-mutation interception is a separate deferred surface); evidence
  commands run through the controller's own bounded runner.
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
- Artifacts bind to the DSH session id (per-session invocation) instead of a
  per-run `fabric_exec` call id; certificates remain single-use and TTL-bounded.
- `mode: enforce` covers `edit`/`write`; bash and other tools are not
  gated (pi's prewalk handoff is a separate deferred surface).
