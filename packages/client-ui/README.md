# @dsh-fabric/client-ui

Browser feature plugin contributing a full `Fabric` conversation tab and compact session-header action.

The Activity view combines session summaries with the host's bounded durable timeline. The Topology view renders general directed graphs containing sessions, workflow phases/members, topics, state, actors, and routed messages. While mounted, it lazily refreshes standard DSH subagent catalogs for visible session nodes and uses authoritative catalog addresses for navigation.

## Model Experience

### Prompt effect

None. This package contributes no prompt section or tool definition.

### Token effect

None. Activity and topology data are presentation-only.

### KV Cache effect

None.

## Known Limitations and Deferred Work

- Durations advance when another session snapshot causes a render. A shared clock source belongs to DSH's projection/runtime layer.
- The topology is a deterministic layered SVG layout, not an interactive force simulation; viewport interaction remains client-local future work.
