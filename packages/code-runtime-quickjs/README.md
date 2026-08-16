# @dsh-fabric/code-runtime-quickjs

QuickJS WASM provider for DSH's existing `CodeRuntime` service. Every run receives a fresh context, is typechecked against the exact binding names supplied by Code Mode, enforces wall-time, memory, stack, and output budgets, validates JSON bridge traffic, and drains or aborts host calls during teardown.

QuickJS is a stronger isolation boundary than the default worker thread for JavaScript globals and host module access, but it is not a complete process or operating-system security boundary. Binding functions remain the only host capabilities exposed to guest code.

## Config

The provider row accepts these optional positive-integer budgets:

| Field | Default | Constraint |
|---|---:|---|
| `maxWallMs` | `600000` | At most `2147483647`, Node's maximum timer delay. |
| `memoryLimitBytes` | `536870912` | At most `4294967295`, the WASM32 address ceiling. |
| `maxStackBytes` | `262144` | Positive safe integer. |
| `maxOutputBytes` | `67108864` | At least `128`; applies to the combined serialized result. |

The current DSH `CodeRunRequest` does not carry the detailed generated SDK declaration prelude, so this provider checks namespace/member existence and ordinary TypeScript semantics with generic JSON argument types and permissive result types. DSH ToolRuntime remains the execution and policy authority.
