# @dsh-fabric/code-runtime-quickjs

QuickJS WASM provider for DSH's existing `CodeRuntime` service. Every run receives a fresh context, is typechecked against the exact binding names supplied by Code Mode, enforces source-compilation, whole-run wall-time, memory, stack, and output budgets, validates JSON bridge traffic, and drains or aborts host calls during teardown.

QuickJS is a stronger isolation boundary than the default worker thread for JavaScript globals and host module access, but it is not a complete process or operating-system security boundary. Binding functions remain the only host capabilities exposed to guest code. Binding globals are lexical arguments, so every DSH-portable name remains usable and guest mutation cannot replace runtime deadline gates.

## Config

The provider row accepts these optional positive-integer budgets:

| Field | Default | Constraint |
|---|---:|---|
| `maxWallMs` | `600000` | At most `2147483647`, Node's maximum timer delay; includes TypeScript checking, cold WASM initialization, and guest execution. |
| `maxSourceBytes` | `262144` | Caps the program plus generated binding declarations before TypeScript parsing. |
| `memoryLimitBytes` | `536870912` | At most `4294967295`, the WASM32 address ceiling. |
| `maxStackBytes` | `262144` | Positive safe integer. |
| `maxOutputBytes` | `67108864` | At least `128`; applies to the combined serialized result. |

A full workspace composition test verifies the central path `run_code` → DSH ToolRuntime sub-dispatch → `fabric_mesh` → DSH storage and session projection. The provider does not register tools or own orchestration.

The current DSH `CodeRunRequest` does not carry the detailed generated SDK declaration prelude, so this provider checks namespace/member existence and ordinary TypeScript semantics with generic JSON argument types and permissive result types. DSH ToolRuntime remains the execution and policy authority.
