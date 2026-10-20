# Live consult-plane benchmark (W934.2.2)

The deterministic consult suite (`harness.ts`) scores policy mechanics over
scripted stand-ins. This runner scores the **real plane**: the coord CLI
consult ladder (kb → lesson → fact → expert/hub, W604/W934.2.1.2) spawns as
a subprocess against a scratch governor plane — temp HOME, fixture git
repo, real SQLite, real subprocess latency. The expert is a scripted
stand-in answering through the real `consult-reply` path. No model calls,
no network (kev pinned to a dead port), fully credentialless.

## Arms (matched, same question set)

| arm    | ask argv                                                | measures                                                          |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------- |
| expert | `consult --best "q" --scope blam-bench --no-kb --as …`  | full round trip: OPEN route → stand-in reply → asker-verified feedback |
| kb     | `consult --best "q" --scope blam-bench --as …`          | plane-side reuse: answered from consult_kb, no live lane          |

The expert pass runs first — the reuse arm is only answerable once its
verified feedback has landed (verified-only reuse, W934 doctrine). This
warm-cache bias favors the reuse arm; read kb latencies as an upper bound
for cold reuse.

## Metrics + properties

Per arm: asks, answered, refused, errors, mean/p50/p95 wall ms. Per ask:
consult ref, outcome, wall ms, answer chars. The run asserts four
properties and exits nonzero when any fails:

- **P1** every expert ask routes exactly one OPEN consult and completes
  the verified round trip (ANSWERED + resolved feedback).
- **P2** every plain ask answers from the KB — never routed to a live lane.
- **P3** the arms ran matched question sets.
- **P4** median kb reuse latency ≤ median expert round-trip latency.

Run: `bun packages/blam/bench/consult/live.ts [--asks manifest.json] [--out dir]`
(manifest: `{"questions": ["…"]}`). Writes `report.json` (0600) to the
output dir.

## Baseline (2026-10-20, 4 default questions, scratch plane)

| arm    | answered | mean | p50  | p95  |
| ------ | -------- | ---- | ---- | ---- |
| expert | 4/4      | 212ms | 203ms | 232ms |
| kb     | 4/4      | 78ms  | 77ms  | 80ms  |

Properties 4/4 hold. Expert round trip ≈ 2.7× the reuse ask on the same
plane — the measured cost the reuse ladder buys back per repeated
question. Absolute latencies are subprocess-spawn dominated (two CLI boots
per expert round trip vs one per reuse ask); the comparison is
same-plane, so the ratio is the signal, not the milliseconds.

## Limits

- Scratch plane, scripted expert: measures routing/reuse mechanics, not
  answer quality — the W447 deterministic suite owns policy scoring, the
  paired suite owns harness lift.
- Hub/federation arm: deferred. The outbound hub leg (W934.2.1.2) needs a
  live hub endpoint; spawned-process loopback to an in-process mock does
  not work on this macOS (see consult-federation.test.ts). Add the arm as
  `--hub-url` when a reachable hub is available.
- Token cost: consults move no model tokens in-plane; token accounting
  stays with the deterministic suites.
