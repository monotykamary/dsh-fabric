# dsh-fabric-models

Model-facing session-model inspection and switching for dsh-fabric: the `fabric_models` Consumer with three actions.

- `current` reports the calling session's live provider/model/effort selection.
- `list` reports the served model catalog (grouped providers, bounded model lists, per-provider failures) and the configured alias names.
- `select` switches the session's live model in place and keeps it until the next switch, returning `{ switched, selected, previous, alias? }` (or `switched: false` when the target is already active).

Selector resolution tries, in order: a configured **alias** (a plain `provider/model` string, or an ordered fallback chain where the first resolvable target wins), an exact `provider/model` passthrough (availability is the adapter set, not the catalog, so advisory-unlisted models still switch), an exact bare model id, and a single catalog match on provider, id, or display name. Ambiguous or unknown selectors fail with the candidate list and leave the session unchanged. `provider` narrows catalog matching; `reasoning_effort` is forwarded to the adapter and validated against the model's supported efforts.

The switch authority is the host `sessionModels` service exposed by the DSH **ApiProxy gateway**, the same implementation behind the web `session.models`/`session.selectModel` RPCs — so tool-driven and UI-driven switches read and mutate one selection, with image-admission serialization and default persistence included. Hosts without the gateway (headless compositions) fail calls with a clear message instead of pretending to switch.

## Config

Aliases come from the plugin row's `config.aliases`, mirroring pi-fabric's `models.aliases`:

```yaml
- id: dsh-fabric-models-tool
  name: 'dsh-fabric-models/tool'
  config:
    aliases:
      cheap: google/gemini-2.5-flash
      budget: ['openai/gpt-5-mini', 'google/gemini-2.5-flash']
```

Entries with blank names, empty chains, or malformed targets are dropped at load.

Subagent model selection is intentionally OUT of scope here: the native `subagent` and `spawn_teammate` tools accept a per-call `model` that DeepSeek Harness threads into the child's agent options, and Fabric composes those tools unchanged.
