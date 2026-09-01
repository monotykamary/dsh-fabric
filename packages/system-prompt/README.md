# dsh-fabric-system-prompt

Fabric-owned system prompt for DeepSeek Harness: one high-priority operational section capturing pi-fabric's well-tuned long-horizon disciplines, adapted to DSH, plus an authoritative `system-prompt/assemble` waterfall listener that minimizes the native DSH prose.

- The root export registers the `fabric:system-prompt` section (order 10, right after the persona), the visibility-gated `fabric:memory-guidance` section (order 114, populated when the session-query toolset is composed), and the minimization listener.
- `FABRIC_SYSTEM_PROMPT` carries durable coordination, compaction, memory/recall, Code Mode, and the exact background-first `tools.subagent({ description, prompt, provider, model })` delegation recipe.
- `PRESERVED_SECTIONS` keeps identity, persona, trusted user system instructions, plan policy, reporting, the Code-Mode SDK/collapse rules, session-query guidance, Fabric memory, and mesh guidance.
- Tool schemas, dynamic runtime context, and variables are never filtered. Full optional declarations are replaced by a deterministic names-only JSON roster; DSH ToolRuntime owns run-scoped `tools.describe`/`tools.call` for exact on-demand contracts. No heuristic advisory messages mutate the turn prompt.
