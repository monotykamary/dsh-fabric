# feat: add Fabric-native delegation policy and mission-control UX

## What changed

- adds a preset-scoped `delegate` Consumer that turns bounded task lists and cheap/default/strong tiers into native DSH workflow/subagent runs;
- resolves worker selectors through the `dsh-fabric-models` alias vocabulary and verifies actual child routing from durable request facts;
- adds concurrency, worker-count, depth, token-budget, automatic-policy, and optional validator controls;
- projects delegation lifecycle, routes, usage, output, errors, cancellation, interruption, and out-of-order completion from native DSH events;
- adds a persistent Mission Control surface with running-first workers, parallel groups, inspector, parent/child relationship, current activity, child navigation, cancel, message/steer, and continue-after-failure controls;
- keeps the main conversation primary and retains DSH/Cordis authority for execution, sessions, policy, and lifecycle.

## Safety

Delegations are hard-capped at 20 workers and depth 1 by default. The depth guard was added after dogfooding exposed recursive reviewer fan-out. Requested routes are never presented as verified unless the child session's observed request route matches.

## Verification

```bash
pnpm run check
```

The integration suite exercises the real composed DSH agent loop, worker-thread workflow engine, in-process subagent driver, child sessions, request contexts, and usage events. Projection tests cover reload/replay, failure, cancellation, interruption, and out-of-order completion.

## Evidence

- Architecture: `docs/delegation/ARCHITECTURE.md`
- Before/after evaluation: `docs/delegation/EVALUATION.md`
- Screenshot review: `docs/delegation/UX_REVIEW.md`
- Final screenshots: `docs/delegation/screenshots/`
