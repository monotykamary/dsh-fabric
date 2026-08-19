# dsh-fabric-mesh

Complete DSH capability for durable Fabric topics, revisioned compare-and-swap state, and actor mailboxes.

- The root export is the `FabricMesh` Service Definition.
- `dsh-fabric-mesh/provider` stores records through DSH `storage-domain`.
- `dsh-fabric-mesh/tool` registers the `fabric_mesh` Consumer, attaches validated `presentationMeta` to native post-commit tool results for browser topology, supplies model-facing operating rules, and contributes a bounded metadata-only DSH runtime-context snapshot.

The context contribution is assembled from an authoritative count-limited provider snapshot before each model request, including after DSH compaction. It carries bounded identifiers, revisions, statuses, counts, and truncation metadata—not arbitrary payloads—and shrinks to a final 16 KiB UTF-8 ceiling. Snapshot/read record counts default to 100 and reject values above 500. Explicit topic and terminal-mailbox pruning provides storage retention; mailbox pruning never removes queued or claimed commands. QuickJS evaluations remain fresh, so cross-run coordination belongs here rather than in JavaScript globals.

Every mesh view is scoped by one synchronous resolver shared by prompt assembly and tool execution: registered session membership first, canonical-path match to a registered workspace second, an unregistered canonical-path digest third, and session identity only when `cwd` is absent. Cwd-less sessions are intentionally isolated by session id and therefore do not automatically share mesh state with cwd-less subagents. Records written by builds that predate workspace scoping remain stored but are not exposed by workspace-bound reads; they require an explicit operator-selected re-key because no safe automatic destination can be inferred. Agent-less prompt assembly uses an isolated `diagnostic` view, while agent-less tool calls fail instead of silently reading that empty scope.

Caller-owned JSON is cloned before storage and every public read returns detached records, so mutations outside the service cannot rewrite authoritative in-memory state. Actor commands move from `queued` to `claimed` with an opaque token, then to `completed` or `failed`. A repeated settlement with the same token replays the stored result while that terminal record remains retained. A process failure after claim leaves the command claimed rather than risking duplicate execution.
