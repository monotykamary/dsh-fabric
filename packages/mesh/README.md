# @dsh-fabric/mesh

Complete DSH capability for durable Fabric topics, revisioned compare-and-swap state, and actor mailboxes.

- The root export is the `FabricMesh` Service Definition.
- `@dsh-fabric/mesh/provider` stores records through DSH `storage-domain`.
- `@dsh-fabric/mesh/tool` registers the `fabric_mesh` Consumer, appends post-commit activity records for the browser topology, supplies model-facing operating rules, and contributes a bounded metadata-only DSH runtime-context snapshot.

The context contribution is assembled from authoritative storage before each model request, including after DSH compaction. It carries identifiers, revisions, statuses, counts, and truncation metadata—not arbitrary payloads. Snapshot/read record counts default to 100 and reject values above 500. QuickJS evaluations remain fresh, so cross-run coordination belongs here rather than in JavaScript globals.

Actor commands move from `queued` to `claimed` with an opaque token, then to `completed` or `failed`. A repeated settlement with the same token replays the stored result. A process failure after claim leaves the command claimed rather than risking duplicate execution.
