# dsh-fabric

Fabric-style activity, topology, checked code execution, durable coordination, and actor mailboxes for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Capabilities

The workspace root is an installable DSH bundle that composes five packages:

| Package | Responsibility |
|---|---|
| `@dsh-fabric/protocol` | Host-independent activity, topology, mesh, and actor records. |
| `@dsh-fabric/host` | Required `fabric/activity` vocabulary and bounded `fabricActivity` session projection; also folds DSH workflow and compaction events. |
| `@dsh-fabric/mesh` | Storage-domain-backed topics, compare-and-swap state, crash-conservative actor mailboxes, the `fabric_mesh` Consumer, and bounded continuation context. |
| `@dsh-fabric/code-runtime-quickjs` | Fresh-context QuickJS WASM provider with TypeScript checking, JSON bridge validation, deadlines, cancellation, memory/stack/output budgets, and quiescent disposal. |
| `@dsh-fabric/client-ui` | Fabric conversation tab, chronological Activity view, general directed Topology view, compact header popup, metrics, and authoritative subagent navigation. |

The bundle replaces the web profile's `code-runtime` row with QuickJS and mounts the other Fabric rows. DSH ToolRuntime remains the sole tool registry and policy authority; Cordis remains the component lifecycle.

## Develop

Requirements: Node `^22.19.0 || >=24`, pnpm 11, and DSH `0.1.0-rc.6`.

```sh
pnpm install
pnpm run check
```

For local development, run the installer from this repository. It installs dependencies, builds every workspace package, links the root and all five packages into `web`, validates the composed Fabric and inherited compaction rows, and does not start or restart DSH:

```sh
pnpm run install:local
```

Target another profile or profile root when needed:

```sh
pnpm run install:local -- --profile tui
DSH_HOME=/path/to/dsh-home pnpm run install:local -- --profile web
```

After the first build, `--skip-build` reuses the existing `lib` artifacts:

```sh
pnpm run install:local -- --skip-build
```

Remove all six local links with the matching command:

```sh
pnpm run uninstall:local
```

Use the same `--profile` or `DSH_HOME` selection as installation. Fabric only shadows the profile's `code-runtime` row; it does not uninstall the inherited provider. Removing the Fabric bundle recomposes the profile without that later row, so the inherited CodeRuntime becomes authoritative again. Other profile overlays can still replace it independently.

A registry installation of `dsh-fabric` pulls these packages through ordinary dependencies. The initial installation changes the profile plugin graph and therefore takes effect on the next profile load. This project never starts, stops, or restarts the DSH server automatically.

### Client HMR

DSH can hot-reload an already loaded client plugin only when both watchers run:

1. The DeepSeek Harness checkout serving the GUI runs `pnpm run dev:web` so its client-module registry watches bundles.
2. This workspace runs `pnpm run watch:client` so `packages/client-ui/lib/client.js` is rebuilt. CSS modules ride that bundle and replace their package-owned style tags on hot evaluation.

A running server by itself does not compile this repository, and adding a new profile row is not equivalent to reloading an active row.

## Mesh tool

`fabric_mesh` supports:

- `snapshot`;
- `create_topic`, `publish`, and `read_topic`;
- `get_state` and revision-checked `cas_state` (`expected_version: 0` creates an absent key);
- `create_actor`, `send_actor`, `read_mailbox`, `claim_actor_message`, and `settle_actor_message`.

Actor claims are crash-conservative. A claimed command remains claimed after a process failure; settlement requires its opaque token, and repeating the same settlement token returns the stored result instead of executing twice. Snapshot and read counts are bounded; arbitrary payloads are fetched explicitly rather than copied into continuation context.

## Compaction and continuation

The bundle keeps DSH's existing compaction provider and lifecycle. Fabric does not replace or wrap the compaction engine.

- The host projection folds DSH `compaction/*` lifecycle events into Activity and Topology.
- `fabric_mesh` contributes a bounded, metadata-only DSH runtime-context snapshot. DSH reassembles it after compaction so models can rediscover durable state, actor, topic, and mailbox identifiers.
- Model guidance requires inspecting durable state after compaction or `TOOL_OUTCOME_UNKNOWN`, then resuming with CAS revisions and claim tokens rather than conversational memory.
- A real Code Mode composition test covers `run_code` → ToolRuntime sub-dispatch → `fabric_mesh` → storage → session event → client projection.

See [ADAPTATION_SWEEP.md](ADAPTATION_SWEEP.md) for the reuse matrix, acceptance evidence, and deferred parity surfaces.

## Architecture

- Durable mesh records use DSH `storage-domain`; session events contain only model-visible post-commit activity facts and topology updates.
- Existing `tool-workflow/*` events are folded rather than duplicated. Workflow phases and members appear in the same topology as sessions, actors, topics, state, and routed messages.
- The browser lazily refreshes standard DSH subagent catalogs for visible session nodes. It creates no polling protocol or business-state store.
- QuickJS receives only `CodeRuntimeBinding` functions. It cannot import Node modules or reach host globals.

## Known limitations

- **Session persistence blocker:** DSH 0.1.0-rc.6 validates loaded logs against a static `KNOWN_SESSION_EVENT_TYPES` set that declaration merging cannot extend. A required `fabric/activity` event therefore works live and in detached replay, but stock persistence refuses to reload a session containing it. Mesh business state remains durable. This needs an upstream external-event registration/codec seam or native event recognition; marking the event ignorable would silently lose the projection.
- DSH `CodeRunRequest` does not carry the generated detailed SDK declaration prelude. The QuickJS provider checks namespace/member existence and ordinary TypeScript semantics with generic JSON arguments and permissive result signatures; ToolRuntime still performs authoritative argument and result validation.
- Actor mailboxes provide durable claim/settle semantics, not an always-resident autonomous actor host. A Consumer can drive claims through the service without changing the stored protocol.
- DSH client discovery caches newly added package rows for the process lifetime; the first installation requires a later profile load. Source edits hot-reload after the row is active and both watchers are running.
- This is a focused DSH adaptation, not literal pi-fabric parity. Schema certification, semantic recall, resident actor execution, cross-provider cost budgets, and the full Pi TUI remain deferred; see the sweep document.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
