# @dsh-fabric/host

DSH-native adapter for Fabric activity. It registers a bounded `fabricActivity` session projection, folds the existing durable `tool-workflow/*` event family, and accepts complete post-commit `fabric/activity` records from Fabric capabilities. The projection carries compact timeline facts plus topology nodes and edges to browser clients.

The adapter does not own business state. Workflow authority remains in DSH, while mesh authority remains in `@deepseek-ai/dsh-storage-domain`.
