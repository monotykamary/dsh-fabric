# dsh-fabric-delegation

The preset-scoped `delegate` Consumer turns independent tasks and worker tiers into native DSH workflow/subagent runs. DSH remains the execution, session, cancellation, and policy authority. This package resolves Fabric routing policy, batches workers to the configured concurrency limit, records replayable delegation events, inspects child session request facts, and returns bounded coordination data to Main.

## Configuration

- `aliases`: the alias vocabulary shared with `dsh-fabric-models`.
- `mainModel`: alias or exact `provider/model` expectation for the orchestrator. DSH still selects the parent route. Fabric validates the selector at load, then reports `orchestrator.requested`, `orchestrator.actual`, and `orchestrator.routingVerified`. Actual prefers the parent session's durable request facts and falls back to the live DSH agent route when no request has been issued yet.
- `cheapModel`, `defaultModel`, `strongModel`, `validatorModel`: alias or exact `provider/model` selectors. Unset worker mappings inherit the parent route and are reported as unverified until child telemetry is available.
- `maxParallelWorkers`: deployment ceiling for concurrent workers.
- `maxWorkersPerDelegation`: total task ceiling, hard-capped at `20`.
- `maxDelegationDepth`: absolute DSH delegation-depth ceiling for this coordinator tool; defaults to `1`, so workers must complete their assigned task directly instead of recursively delegating.
- `tokenBudget`: optional aggregate token limit checked between batches. One in-flight batch can cross the limit.
- `autoPolicy`: `off`, `suggest`, or `prefer` coordinator guidance. It never inserts another planning model call.

A delegation spends one worker request per task plus an optional validator request. Main receives requested and actual model routes, child outputs, usage when adapters report it, and `verificationRequired: true`. It remains responsible for checking material claims and synthesizing the answer.

## Limitations

The current DSH workflow seam accepts provider/model overrides but not per-child `maxTokens`, so the token budget is a between-batch stop rather than a hard in-flight cap. Cancel, queue, steer, and continue-after-failure remain authoritative DSH child-session operations and are not duplicated here. There is no separate pause API; cancel stops the active child turn.
