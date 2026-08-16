# @dsh-fabric/mesh

Complete DSH capability for durable Fabric topics, revisioned compare-and-swap state, and actor mailboxes.

- The root export is the `FabricMesh` Service Definition.
- `@dsh-fabric/mesh/provider` stores records through DSH `storage-domain`.
- `@dsh-fabric/mesh/tool` registers the `fabric_mesh` Consumer and appends post-commit activity records for the browser topology.

Actor commands move from `queued` to `claimed` with an opaque token, then to `completed` or `failed`. A repeated settlement with the same token replays the stored result. A process failure after claim leaves the command claimed rather than risking duplicate execution.
