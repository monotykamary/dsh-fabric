# Mission Control screenshot review

The images in `screenshots/` come from the composed DSH web profile at `http://127.0.0.1:3080`, not a standalone story or mock app.

| Capture | Scenario | What it verifies |
| --- | --- | --- |
| `01-idle.png` | Idle/no workers | The Fabric tab stays quiet and explains why no delegation appears. |
| `02-three-workers-running.png` | 3 workers running | Parallel grouping, running-first order, tier labels, and active count are visible at a glance. |
| `03-parallel-nested-work.png` | More parallel work / partial completion | Dense worker lists and mixed progress remain scannable. This records the pre-guard recursive run that prompted the depth limit. |
| `04-failed-group-inspector.png` | Failed delegation | Failure is high contrast and worker inspection remains available. |
| `05-completed-worker-inspector.png` | Completed worker selected | Task, status, model availability, usage, and authoritative child-session control are grouped in the inspector. |
| `06-narrow-viewport.png` | Narrow embedded Fabric pane | The conversation remains primary and the Fabric surface follows its container-query breakpoint without becoming a separate app. |

## Iterations

1. The first pass used a wide three-column layout. Problems: long tasks clipped, completed groups carried too much visual weight, and narrow widths squeezed all three panes.
2. The second pass added bounded scrolling, ellipsis/wrapping rules, running-first ordering, status dots, and de-emphasized terminal rows. Problems: model provenance was ambiguous and worker actions were absent.
3. The final pass distinguishes requested versus observed model routes, shows `Resolving model…` rather than a false route during startup, warns on mismatches, and adds open/cancel/message/steer/continue-after-failure controls backed by DSH APIs. The inspector also shows parent → child and current activity when those facts exist. Narrow breakpoints use container queries so the embedded Fabric pane stacks even when the Safari window is still wide.

Known limitation: DSH's existing settings surface owns startup plugin configuration, so tier mappings, concurrency, and auto-policy are changed in the Fabric preset/plugin config rather than duplicated as client-owned state. Runtime worker controls are available in the inspector.
