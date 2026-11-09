# Artifact bench — scenario spec (W2904)

Deterministic, **LLM-optional** paired-arm benchmark over ARTIFACTS: base
images, package versions, toolchain pins. Extends the W612 paired protocol
(`../paired/`) from case-family arms to artifact-ref arms and adds the
decision-grade law the desktop bake-off (2026-11-09) exposed as missing:
rows exist to pick a winner or declare an explicit tie — a receipt that
cannot decide is dead weight and must not be emitted.

## The decision-grade law

1. Every `ScenarioSpec` declares a `DecisionRule` up front
   (`{stat: median|p95, lowerWins, tieEpsilon}`). No rule, no run.
2. Every scenario summary carries a REQUIRED `verdict` block: `winner` is
   an arm id, or the literal `tied` when all arms sit inside the
   `tieEpsilon` band around the best. Winnerless, verdict-less rows are
   schema-invalid by construction.
3. `decision` is a one-line human statement of what a winner MEANS
   (e.g. "lower median cold-start wins the runner-image selection").

## Arms are artifact refs

`ArmRef = {kind: image|package|toolchain, id, label, pinned}` — the id is
the exact artifact identity (`alpine:3.21@sha256:…`, `bun@1.4.4`). Loose
tags are recorded `pinned: false` and count for nothing in a matched
comparison. Cross-bed matched runs MUST pin the same digest on both beds
so the only variable is the bed (host/kernel/caps).

## Parity and ordering

- `Caps {bed, host, kernel, arch, cpu, memMiB}` is the parity witness:
  samples are comparable only inside one caps block. Cross-bed comparisons
  list both caps blocks side by side; beds differ ONLY in caps.
- Walk order is `seededOrder(arms, reps, seed + rep*7919)` over mulberry32
  (controlled ordering): same seed → same order → byte-identical receipts.

## Beds

| bed             | driver                                   | status        |
| --------------- | ---------------------------------------- | ------------- |
| docker-desktop  | live docker driver (exec-based)          | live          |
| colima-zram     | same driver, zram-generator host profile | available     |
| azure           | remote-carrier driver (BedDriver plug)   | PLANNED       |
| any             | `replay-fixture` driver                  | harness-test  |

The replay-fixture driver (`<bed>:replay-fixture`) replays fixed schedules
to exercise harness mechanics in CI (bun-only, no Docker). Fixture rows are
never ledger rows. Ledger rows come from live drivers only, and every bench
landing lands its rows in the root ledgers (`benchmarks.md`,
`doesnt_work.md`).

## Seed scenarios

| id          | arms (artifact refs)                      | reps | rule                          | decision                                        |
| ----------- | ----------------------------------------- | ---- | ----------------------------- | ----------------------------------------------- |
| cold-start  | base images (alpine/debian/wolfi/ubuntu/fedora @ digest) | 7 | median, lowerWins, ε 5% | lower median cold-start wins the image selection |
| tool-install | package-manager arms (apk/apt/dnf per image digest)      | 3 | median, lowerWins, ε 5% | lower median install time wins the toolchain leg |
| install-clone | install+clone end-to-end per image digest              | 3 | median, lowerWins, ε 5% | lower median end-to-end wins the runner pick    |

The 2026-11-09 desktop bake-off measured (live, docker-desktop, linuxkit
7.0.14, 18cpu/7.7GiB): cold-start medians alpine 170.7ms / debian-slim
170.7ms band, fedora 196.0ms; tool-install apk 4.1s vs apt 6.3s vs dnf
25.2s. Those ad-hoc numbers motivated the suite; the suite's OWN rows come
from these scenarios, and the first matched cross-bed run (desktop vs
remote hub) rides the receipt-v1 digest `oven/bun@sha256:9114c058…`.

## Verdict audit (properties every consumer may assume)

- `verdict-present` — the summary has a verdict block.
- `verdict-decides` — the winner names a stats row, or the verdict is `tied`.
- `stats-total` — every arm with samples has median+p95.
- `reps-accounted` — receipts + recorded failures cover the walk; failures
  shrink an arm's samples and are visible, never silently dropped.

Live runs take two or more distinct digest-pinned image references after
`--live`. Images must already be resident for the Docker daemon's native
platform. The receipt starts with resolved image identity rows. An incomplete
live run exits nonzero and omits the verdict. Use `--replay <receipts.ndjson>`
to verify a complete run and print its content hash.
