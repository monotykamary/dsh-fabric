# @dsh-fabric/host

DSH-native adapter for Fabric activity. It registers a bounded `fabricActivity` session projection, folds the existing `tool-workflow/*` and `compaction/*` event families, and accepts complete post-commit `fabric/activity` records from Fabric capabilities. The projection carries compact timeline facts plus topology nodes and edges to browser clients. Private workflow-member correlation survives bounded topology eviction, while public projection output stays bounded.

The projection reconstructs from serialized logs and DSH projection checkpoints. It does not own business state: workflow and compaction authority remain in DSH, while mesh authority remains in `@deepseek-ai/dsh-storage-domain`.

DSH 0.1.0-rc.6 has a runtime persistence compatibility gap for external required event types: stock persistence refuses to reload `fabric/activity` because it is absent from `KNOWN_SESSION_EVENT_TYPES`. See the root adaptation sweep; making this event ignorable is not safe because it would erase the projection.
