# @dsh-fabric/host

DSH-native adapter for Fabric activity. It registers a bounded `fabricActivity` session projection and folds native `tool/result.meta`, `tool/code-dispatch`, `tool-workflow/*`, and `compaction/*` events. The projection carries compact timeline facts plus topology nodes and edges to browser clients. Private workflow-member correlation survives bounded topology eviction, while public projection output stays bounded.

The projection reconstructs from serialized native events and DSH projection checkpoints. It does not own business state: workflow and compaction authority remain in DSH, while mesh authority remains in `@deepseek-ai/dsh-storage-domain`.

Legacy session logs containing the retired required `fabric/activity` event remain incompatible with DSH 0.1.0-rc.6's static event allowlist. New writes use native event families and do not introduce that reload gap; see the root adaptation sweep.
