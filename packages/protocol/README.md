# dsh-fabric-protocol

Host-independent records shared by dsh-fabric adapters, services, and renderers. It imports no DSH host or browser package.

The package separates three concerns:

- **Participants** — FabricParticipantRecord gives roots, peer sessions, delegated agents, and durable actors one portable identity with explicit parentage, residency, status, and truthful capabilities. buildParticipantDirectory projects those records from an authoritative session mirror and observed actor records; it owns no lifecycle.
- **Topology** — buildFabricTopology produces a single-parent structural tree rooted at Main. Participant categories and mesh namespaces are synthetic groups; publish, actor-route, and state-access edges are marked as traffic rather than layout parentage.
- **Activity and mesh** — bounded event projections, revisioned state, durable topics, and crash-conservative actor mailbox records remain portable and replayable. Workflow, phase, message, and compaction records stay in Activity instead of becoming hierarchy nodes.

buildLineageGraph remains available as the compatibility projection for consumers that need the earlier ungrouped graph.
