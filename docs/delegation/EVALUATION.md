# Delegation behavior evaluation

## Method

This battery compares the prior Fabric behavior with the new `delegate` surface under the same coordinator policy objective. The baseline is the old prompt-only path: no compact delegation Consumer, no tier schema, no route verification, and no delegation projection. The candidate is the implementation in this PR.

Each case records whether delegation is appropriate, the expected worker shape, and the automated evidence that makes the result falsifiable. Token and latency numbers are adapter-dependent, so the table names the exact telemetry source instead of fabricating a cross-provider dollar estimate.

| Case | Useful split | Baseline | Candidate expectation | Automated evidence |
| --- | --- | --- | --- | --- |
| Trivial one-file fix | None | Main | Main, 0 workers | `autoPolicy` guidance explicitly rejects trivial delegation. |
| Repository exploration | Independent package maps | Ad hoc/manual | 2–4 cheap workers in one parallel call | Integration test proves two children start before either ends. |
| Three independent investigations | Three read-only questions | Ad hoc/manual | 3 workers, `max_parallel: 3` | Dogfood capture `02-three-workers-running.png`; native lifecycle projection test. |
| Broad refactor | Map/test/edit seams, then Main synthesis | Main-heavy | Cheap mapping and tests; default implementation only when separable | Tier policy tests plus mandatory `verificationRequired`. |
| Test failure diagnosis | Logs, failing test, implementation | Main-heavy | 2–3 cheap/default investigators in parallel | Out-of-order success/failure replay test. |
| Repetitive migration | File shards | Main-heavy | Cheap workers, bounded batches, hard ceiling 20 | Config/task validation and token-budget batching tests. |
| Hard tightly coupled reasoning | None or one strong isolated critic | Main | Mostly Main, at most one strong worker | Guidance keeps tightly coupled reasoning on Main. |

## Measured acceptance results

| Metric | Baseline | Candidate | Evidence |
| --- | ---: | ---: | --- |
| Appropriate delegation rate across the seven-case policy battery | 0/5 delegable cases had a first-class route | 5/5 have an explicit cheap/default/strong route | Pure policy tests and the `delegate` schema. |
| Inappropriate delegation rate | Not enforceable | 0/2 non-delegable cases are recommended for delegation | Prompt policy tests cover trivial and tightly coupled work. |
| Workers per call | Manual, unbounded by Fabric | 1–20, deployment-capped | Config max 20; per-call validation. |
| Actual parallelism | Not represented | Proven for two independent children | Both `workflow/agent-start` timestamps occur before the first `workflow/agent-end`. |
| Cheap-model routing | Not observable through Fabric | 100% (1/1 cheap worker) in the real composed routing assertion; 2/2 configured worker routes verified overall | Child `request/context` facts; parent model adapter receives zero worker requests. |
| Parent input/output tokens | Provider telemetry only, no Fabric attribution | Preserved as DSH session usage; worker totals no longer inflate Main's request usage | DSH parent session metrics; worker tokens are reported separately. |
| Total worker tokens | Unavailable | Sum of child `assistant/message.usage` values | Delegation result `totalTokens` and Mission Control group metric. |
| Latency | Sequential/manual | Batch wall-clock plus optional validator | Result `durationMs`; concurrent-start assertion proves overlap. |
| Correctness | Existing workspace checks | Full workspace check passes | `pnpm run check`. |

The cheap-routing percentage deliberately counts only workers whose observed `request/context` matches the configured route. A requested model without child telemetry is not counted as verified. The live dogfood capture demonstrates fan-out and lifecycle telemetry, not a distinct cheap-model route; the real composed adapter integration test is the routing acceptance authority.

## Dogfood evidence

The feature was used to review itself after the first stable build:

- one three-worker call launched accessibility, test-gap, and architecture reviews concurrently; the active profile had no distinct `cheapModel`, so those live workers inherited the profile route and are not counted as cheap-routing evidence;
- the cheap reviewers then decomposed work further, which exposed an unsafe recursive fan-out in the first version;
- the finding was synthesized on Main into a hard `maxDelegationDepth: 1` guard plus an integration regression test;
- Mission Control screenshots captured the idle state, three concurrent workers, deeper parallel activity from the pre-guard run, failure, and worker inspection;
- final repository claims were verified on Main with the complete workspace check rather than accepted from reviewer output.

The pre-guard nested-work screenshot is retained because it records the dogfood defect that led to the safety limit. The shipped behavior rejects that recursion.

## Reproducing the checks

```bash
pnpm exec vitest run packages/delegation/tests/policy.spec.ts packages/delegation/tests/integration.spec.ts packages/host/tests/projection.spec.ts packages/client-ui/tests/model.spec.ts
pnpm run check
```
