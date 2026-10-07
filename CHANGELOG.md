# Changelog

One version for the whole stack: every release is a single git tag (`v2.0.0`
style) and all `packages/*` manifests carry that version. The `version:` pin in
machine-level `~/.config/klh/stack.yaml` names the same ref and `hubctl` renders
it as what every hub pulls. Details for a release live in the work graph and
package docs, not here — this file records the release line only.

## 2.0.0 — 2026-10-05

First synchronized stack tag: the nine historical repositories consolidated
into this monorepo (`packages/*`), git-pulled repo sidecars on hubs, and the
stack version contract — one tag pins buckle, suspenders and belt together.

## 0.8.0 — 2026-09-29

Content gate (pre-write payload parse check), remote-aware routing, multi-machine
research spikes, BLAM scaffolded out-of-tree.

## 0.7.0 — 2026-09-29

Merge-state integrity (recovery refs, fail-loud ahead, marker identity, heal
post-condition), merge-guard gate, orchestration box, codex dual-backend lanes,
inbox polling, speedy rename anchors.

## 0.6.0 — 2026-09-28

Push-to-main enforcement: a gate rule, not prose.

## 0.5.0 — 2026-09-28

Gate-writes journal + governor bless, fleet loop, dependency-merge gate, board
filter, zombie reaper.

## 0.4.0 — 2026-09-28

Tracked `.qlty` config (Biome only — Prettier deadlocks Biome on format),
work-graph mirror sync.

## 0.3.0 — 2026-09-28

Control-plane release; see the v0.3.0 tag for scope.

## 0.2.0 — 2026-09-26

Fleet board v3 (views, drawer, setup checks, demo), consult knowledge base,
per-file lease TTL + lease release.
