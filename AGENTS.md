# AGENTS.md

## Scope

This repository implements Fabric-style capabilities as external DeepSeek Harness plugins. Keep DSH adapters separate from portable runtime and protocol code.

## Runtime safety

Never start, stop, or restart the user's DSH server unless explicitly requested. Client HMR requires both a loaded plugin and the matching DeepSeek Harness checkout's `pnpm run dev:web` watcher. This repository's `pnpm run watch:client` only rebuilds `lib/client.js`.

## Package roles

- `dsh-fabric-protocol`: host-independent activity, topology, and mesh records.
- `dsh-fabric-compaction`: deterministic summary compiler, DSH compaction adapter, and masked preset roster.
- `dsh-fabric-client-ui`: browser Activity and Topology surfaces.
- `dsh-fabric-host`: DSH durable-event and session-projection adapter.
- `dsh-fabric-mesh`: storage-backed topics, CAS state, actor mailboxes, and the `fabric_mesh` Consumer.
- `dsh-fabric-code-runtime-quickjs`: checked QuickJS `CodeRuntime` provider.
- The workspace root is the installable `dsh-fabric` bundle.

Do not introduce a second tool registry or component lifecycle. DSH ToolRuntime and Cordis own those responsibilities. Business state must remain outside React stores; client-local state is limited to view selection, filters, expansion, and viewport state.

## Verification

Run `pnpm run check` after changes. Build the client bundle before testing it against DSH because the host serves `lib/client.js`, not source files.
