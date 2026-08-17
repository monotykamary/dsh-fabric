# @dsh-fabric/client-ui

Browser feature plugin contributing a full `Fabric` conversation tab and compact session-header action.

The Activity view combines session summaries with the host's bounded durable timeline. The Topology view projects those facts into portable participants and observed mesh resources, then renders a single-parent tree under Main, Participants, and Mesh groups. Workflow, phase, message, and compaction records stay in Activity; publication, actor routing, and state access appear as dashed traffic overlays. The layout runs left-to-right, centers parents over vertically stacked children, and shares one deterministic child order with Arrow or H/J/K/L keyboard navigation. Its session-header overview lists participants only. The full tab follows DSH's composer-overlay contract and keeps scrolling and focus movement inside the available viewport. While mounted, it lazily refreshes standard DSH subagent catalogs for visible session participants and uses authoritative catalog addresses for navigation.

## Model Experience

### Prompt effect

None. This package contributes no prompt section or tool definition.

### Token effect

None. Activity and topology data are presentation-only.

### KV Cache effect

None.

## Known Limitations and Deferred Work

- Durations advance when another session snapshot causes a render. A shared clock source belongs to DSH's projection/runtime layer.
- The topology is a deterministic structural SVG tree, not an interactive force simulation. Traffic edges do not influence placement.
