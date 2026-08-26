# Fabric delegation architecture

Fabric delegation is a policy and projection layer over DeepSeek Harness, not an agent runtime.

## Authority split

| Concern | Authority | Fabric contribution |
| --- | --- | --- |
| Tool registration and execution policy | DSH `ToolRuntime` | One preset-scoped `delegate` Consumer with a compact task/tier schema. |
| Agent execution and cancellation | DSH agent loop and subagent runtime | Tier-to-provider/model routing passed to native workflow `agent()` calls. |
| Workflow scheduling and concurrency | DSH `WorkflowEngine` | Bounded batching, labels, optional validation, and token-budget stop checks between batches. |
| Session creation and durable events | DSH sessions | Replayable native `tool-workflow/*`, `tool/call`, `tool/result`, and request lifecycle facts. |
| Component lifecycle | Cordis | A normal plugin row and package invariant registration. |
| Model naming | `dsh-fabric-models` alias vocabulary | `cheap`, `default`, `strong`, and validator selectors resolve through the same alias parser. |
| Visible delegation state | Host projection over DSH events | Bounded delegation/worker records, observed route, usage, output, error, and parent/child correlation. |
| UI interaction | DSH conversation slots and host API | A client-only selection/expansion layer over replayed records; open, cancel, queue, steer, and continue-after-failure call authoritative DSH child-session APIs. There is no separate pause surface. |

No Fabric-owned executor, session store, cancellation protocol, or React business-state store is introduced.

## Execution path

1. The parent calls `delegate` with self-contained tasks and tiers.
2. Fabric validates the hard 20-worker ceiling, deployment concurrency ceiling, delegation depth, labels, and optional token budget.
3. Each tier resolves to a provider/model pair through `dsh-fabric-models` alias helpers.
4. Fabric starts the native DSH worker-thread workflow. Independent tasks in a batch use workflow `parallel()` and `agent()`.
5. DSH creates child sessions. Fabric observes their durable `request/context` events and reports the actual route, never merely the requested argument.
6. Native workflow lifecycle events are mirrored into the parent session so replay can reconstruct workers even if the result is interrupted.
7. The optional validator runs only after worker batches settle. Main always receives `verificationRequired: true` and remains responsible for authoritative checks and synthesis.
8. The host projection folds the native events. Refreshing during or after execution produces the same Mission Control state.

## Safety and bounds

- `maxWorkersPerDelegation` is schema-capped at 20.
- `maxDelegationDepth` defaults to 1. A delegated child cannot call `delegate`; this prevents recursive fan-out while allowing Main to coordinate one bounded layer.
- `maxParallelWorkers` bounds each batch. `parallel: false` forces one worker at a time.
- `tokenBudget` is checked between batches. DSH's current workflow seam does not expose per-child token ceilings, so an in-flight batch may cross it.
- Requested and observed routes are both retained. A mismatch is visible as `routingVerified: false` and a Mission Control warning.
- Interrupted, failed, cancelled, out-of-order, and terminal-result replay paths are projection-tested.

## Why this belongs in Fabric

The tier policy, low-friction abstraction, coordinator guidance, bounded result shape, replay projection, and Mission Control layout are product policy and UX. They belong in Fabric. Agent creation, model requests, sessions, workflow scheduling, controls, and lifecycle already have supported DSH seams and remain there. No upstream DSH patch was needed: the required version emits authoritative child request facts and honors per-child workflow provider/model options.
