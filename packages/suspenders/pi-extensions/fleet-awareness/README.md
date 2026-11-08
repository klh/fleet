# Pi Fleet awareness

The native Fleet install wires a managed Node ESM extension into Pi's agent
home. Pi SDK and TUI are pinned to 1.5.0. Existing user files, modified bundles
and incompatible managed Pi versions produce a visible install conflict.
Reinstalling identical code preserves its mtime. Bundle and metadata are 0600.

Use `/fleet` for overview, work, routes, attention and peers. Keys 1–5 change
tabs; arrows scroll; `r` refreshes; `i` opens a work item; `k` searches knowledge;
`c` asks a live peer; `a` reads consults; Escape closes. Ages redraw locally;
data refreshes only on startup or explicit request. No additional subscriber
or background model requests are created.

The `fleet` tool exposes the same snapshots and detail reads, plus explicit
consult replies, outcome feedback and acknowledgment after acting. Writes
require a uniquely live receiver identity; peer targets are resolved again
before sending. Missing identity fails closed. Queued delivery does not imply
acceptance or completion. Knowledge is evidence, never new authority.

CLI calls use argument arrays, an eight-second timeout and a 512 KiB limit.
Wire contracts strip unknown fields; credentials and terminal controls are
removed from displayed values. Hub catalogs show reachability separately from
inference. Missing capacity, activity and cache data remain unknown.

Run the focused suite with:

```sh
bun --bun x playwright test --config packages/suspenders/test/playwright.config.ts pi-awareness --workers=2
```

The SDK test launches real Node, loads the pinned SDK, registers the Fleet tool
and emits actual startup against a scratch home with stubbed CLI responses.
It makes no inference requests and does not prove a deployed user's UI or
remote durable runner. Use BLAM's paired runner receipts for infrastructure
and agentic comparisons separately; retain failures and unknown metrics.
