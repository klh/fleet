# Markdown corpus audit — W693 (2026-10-12)

Scope: every actionable recommendation in `toto-gpt.md` (ChatGPT research,
2026-10-05 @ `87e6218`) and the `docs/*.md` corpus, checked against code at
`2fad9810` and the work graph. Verdicts: **LANDED** (code cite + item),
**LIVE** (open item), **STALE** (doc claim no longer true), **GAP** (real, no
live item — minted). An already-landed recommendation gets a note, not an item.

## toto-gpt.md — findings table (P1/P2)

| Finding                               | Verdict | Evidence                                                                                                   | Item        |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| P1 clean install omits BLAM           | LANDED  | install ships blam (W422.14); isolated-home install proof in `docs/clean-install-w422.6.md`                | W422.14/.6  |
| P1 no root CI workflow                | LANDED  | `.github/workflows/ci.yml` (per-package matrix, `imports` job, `runtime-sqlite` job)                       | W422.13/W649 |
| P1 hub deploy assumes legacy repos    | LANDED  | `deploy/hub-compose.yaml` mounts `${HUB_FLEET_SRC}/packages`, probe sidecars use `packages/` paths         | W422.7/W552.2/W689 |
| P2 workspace/release contracts        | LANDED  | root `package.json` `workspaces: ["packages/*"]`, `bun.lock` present, all 7 packages carry manifests (v2.0.0) | W422.5/.19  |
| P2 umbrella installer clones legacy   | LANDED  | `packages/speedy/bin/install-fleet.ts:63` defaults `FLEET_REPO_URL` to `github.com/klh/fleet`              | W422.20/W595 |
| P2 board violates Lit law (innerHTML) | LANDED  | `rg innerHTML packages/suspenders/hooks/board-html` → only a test fixture + vendored Lit; `core.ts` 204 lines, `tasks.ts` 532 | W658.3/W184 |

## toto-gpt.md — additional findings A–C

| Finding                                   | Verdict | Evidence                                                                                                                     | Item |
| ----------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| A SQLite WAL-reset patch verification     | LANDED  | `deploy/runtime-info.ts`, CI `runtime-sqlite` job runs it inside `oven/bun:1`; digest-pinned image `hub-compose.yaml:58`   | W443 |
| B knowledge backup = VACUUM INTO + fail   | LANDED  | `hooks/bin/db-backup.ts:82` VACUUM INTO readonly, `:105` exit 2 on integrity failure; `test/db-backup.test.ts`              | W444 |
| B rotation picks newest per slot          | **GAP** | `db-backup.ts:176` `ksnaps.find()` on an unsorted list (governor list sorts at `:140`) — keeps oldest-in-slot, untested     | **W696** |
| C ledger pending caps + drop counters     | LANDED  | `packages/buckle/src/ledger.ts:143,218` `maxPendingEntries`/`maxPendingBytes`, `dropped` counter `:180`                      | W450 |
| C durable spool for critical audit        | STALE-ish | Recorded policy is freshest-wins with counted drops (ledger.ts:271); no durable spool. Policy choice, not a defect — owner decision if enterprise audit needs it; not minted | — |

## toto-gpt.md — enterprise gaps 1–10

| # | Gap                                  | Verdict | Evidence / note                                                                                                                         | Item |
| - | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1 | Reproducible release/upgrade/rollback | PARTIAL → GAP | digests pinned + one pinned fleet checkout landed (W552.2/W689/W692). No release manifest, SBOM, attestation or schema-upgrade/rollback test found (`rg` over `.github`, `deploy/`, docs) | **W698** |
| 2 | State ownership / fencing             | LANDED  | `claim_epoch` fencing + guarded transitions (W609), capsule fence `hooks/lib/capsule-fence.ts`; one authoritative store per hub by design | W609 |
| 3 | Tenant isolation matrix               | LIVE    | identity/project design in `cross-hub-project-identity.md`; staged items W459.1–.5 DONE, umbrella W459 FAILED; cross-tenant test matrix not minted here — see docs audit below for W459/W539.1 | W459/W539.1 |
| 4 | Replica-safe budgets                  | LANDED  | `packages/buckle/src/gov/budgets.ts`, `gov/slots.ts`, `test/gov-replica-budgets.test.ts`                                                | W468 |
| 5 | Deadlines / replay-safe side effects  | LANDED (deadlines) | `buckle/src/wire.ts:15-107` idle+total deadlines, `admission.ts`; decision-answer idempotency tokens pre-existing. Durable operation IDs for dispatch/mint/merge not found — not minted (single-owner claim_epoch fencing covers the double-claim case) | W450/W609 |
| 6 | SLOs, alerts, trace propagation       | LANDED  | `hooks/bin/metrics-alert.ts` + launchd plist (W452); `traceparent` in `buckle/src/wire.ts:34-38` (W461 stage 1)                          | W452/W461 |
| 7 | Restore drills / DR inventory         | LANDED  | `packages/suspenders/sim/dr-rehearsal.ts` (19-check live drill), `docs/hub-backup-dr-runbook.md`, identity files in `db-backup.ts`       | W178 |
| 8 | Resource isolation + draining         | PARTIAL → GAP | limits, log rotation (`x-default-logging`), digests landed (W451). No `cap_drop`/`security_opt`/`user:`/`read_only`/`stop_grace_period`/`pids_limit` in `hub-compose.yaml` (read_only only in `e2e-compose.yaml:346`) | **W697** |
| 9 | Audit retention/redaction/credentials | LANDED  | admin-audit retention (W174/W399), key rotation ring (W178), scrub gate (W236)                                                          | W174/W178/W236 |
| 10 | Capacity/failure qualification       | LANDED  | `packages/local-llm/lane-load-bench.ts` (W452), soak harness `hooks/bin/soak.ts` (W404), BLAM scenarios                                  | W452/W404 |

## toto-gpt.md — low-hanging optimizations 1–12

1 SQLite patch → W443 LANDED · 2 BLAM install smoke → W422.14 LANDED · 3 root CI
→ W422.13/W649 LANDED · 4 knowledge snapshot → W444 LANDED (sort residual W696)
· 5 metrics alerts → W452 LANDED · 6/7/8 ledger caps, SSE deadlines, prepared
stmts → W450 LANDED · 9/10/11 board coalescing, indexes, digest/limits → W451
LANDED · 12 residency/concurrency measurement → W452 LANDED.

## toto-gpt.md — later sections

| Section                                             | Verdict | Evidence                                                                                                                  | Item |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- | ---- |
| Consult CLI flag bug, KB-first, ranking, provenance | LANDED  | doc's own "Implemented (W471)" section; items W445–W449, W471, W480                                                       | W445–W449/W471 |
| Consult evaluation harness                          | LANDED  | W447, paired-arm evals W612                                                                                               | W447/W612 |
| Starter sessions / forks                            | LANDED (partial) | `scripts/lib/lane-starter.ts`, `dispatch-next.ts:822` (SUSPENDERS_LANE_STARTER flag), `hooks/lib/starter-materialize.ts`; W454 FAILED, W453 SUPERSEDED — benchmark-gated rollout evidence not collected | W458.1–.5 |
| Starter registry first milestone                    | LANDED  | `packages/suspenders/docs/starter-milestone-w458-6.md` + `packages/blam/tools/starter-milestone.ts`; graph row W458.6 still FAILED (stale graph state — W695 triage owns) | W458.6/W695 |
| Health-policy workflow                              | LANDED  | `hooks/lib/policy-workflow/` (W462); pilot W539.1 READY                                                                   | W462/W539.1 |
| Cross-hub identity migration                        | LANDED (stages 1–4) | W459.1–.5 DONE; umbrella W459 FAILED — W695 triage owns                                                          | W459.x |
| Upstream observability stages 2–3                   | LIVE-ish | W461.1–.3 SUPERSEDED by W461 (DONE as architecture); stage 1 traceparent landed in buckle; stage 2/3 not found in code. Covered by W621 observation plane (DONE) | W461/W621 |
| Health/status contract (W485)                       | LANDED  | `docs/health-status-contract.md`; remote NAS activation still blocked → W632/W484.1 (FAILED, W695 triage)                  | W485/W632 |
| Governor recovery (W471), supervisor budgets        | LANDED  | `hooks/lib/failure-recovery.ts`, `packages/belt/bin/supervisor.ts`                                                        | W471 |
| Lane recovery / durable friction list               | LANDED  | atomic claim (W568), dispatch help safe (W538), installer doctor (W549), immutable evidence (W643), capability-aware fallback W588-W591 | various |

Not minted (no code-confirmed uncovered gap): Kubernetes / network DB / broker
(doc says conditional), SCIM (conditional on customers), durable audit spool
(policy choice noted above).

## docs/*.md corpus

Checked at `2fad9810`. Minted gaps: W696–W700. Everything else is a
landed-note or a record of what is stale.

### Monorepo / cutover / layout docs

| Doc | Verdict | Evidence | Item |
| --- | ------- | -------- | ---- |
| `monorepo-review-2026-10-05.md` P1s + P2 | LANDED | sync-harness links blam (`scripts/sync-harness.ts:304-318`); `ci.yml`; hub-compose `HUB_FLEET_REPO_URL`; 7 manifests at 2.0.0; `install-fleet.ts:63`; no `innerHTML` in `board-html/` | W422.5/.7/.13/.14/.19/.20, W658.3 |
| `monorepo-audit-2026-10-05.md` rows 1–7 | LANDED | root `bun.lock`, runtime state untracked, root `CLAUDE.md` stub, `ci.yml:240` docs guard, `buckle/package.json:23` license | W422.13–.19 |
| `monorepo-audit` P2 #8 hard-coded home-dir fallback + LAN hosts | **GAP** | `belt/bin/gateway.ts:12`; `spikes/w86/remote-provider.ts:22,38,43` | **W700** |
| `monorepo-audit` P2 #9 stale `examples/ pages/ spikes/` | GAP (low) | dirs still in `packages/suspenders`; noted, not a separate item | W700 |
| `monorepo-cutover-record.md` | RECORD | no actionable recommendation | — |
| `clean-install-w422.6.md` | LANDED | board import poison fixed; W422.6.1/.2 DONE. NEED_DECISION #25273 STALE (pin since bumped) | W422.6.x |
| `layout-convention.md` waves 0–5, `*-html.ts` Lit | LANDED | W669.1–.6, W669.11 DONE | W669.x |
| `layout-convention.md` verb-kit retrofit | LIVE-ish | W669.12.3 FAILED, no live cover; W695 owns the FAILED backlog | W669.12.3/W695 |
| `w612-fmt-churn-record.md` | RECORD | doctrine restated in AGENTS.md; W625 DONE | W625 |
| `w652-shatter-executed.md`, `w656-wave1-batch-map.md` | LANDED | `lane-liveness.ts:419`, `bus.ts:2`, 29 `hooks/bin` files on `defineVerb` | W652.x/W656.x |
| `w658-shatter-executed.md` | STALE | W658.4 NEED_DECISION #37872 moot; W658.4/W672 DONE | W658.4 |
| `w293-session-name-bridge-record.md` | LANDED | `tagNameOf` now `lib/govdb-sessions.ts:70` (doc cite `govdb.ts:1300` stale) | W293 |

### Control chain / lifecycle docs

| Doc | Verdict | Evidence | Item |
| --- | ------- | -------- | ---- |
| `control-chain-review-2026-10-07.md` liveness, recovery CAS, retry ownership, lease renewal | LANDED | `lane-liveness.ts:419,435`; `--expect-owner/--expect-updated-at` (`quota-sweep.ts:15`, `monitor.ts:654`); `lease-expiry.ts:14` | W573/W576.x/W652.1 |
| `control-chain-review` "three launch implementations" | PARTIAL | `scripts/supervise.ts:484-503` still calls `laneEnv`/`spawnClaude` directly; umbrella W576 FAILED | W576 (→ W695) |
| `lifecycle-launch-contract.md` `LaunchRequestV1`/`LaunchReceiptV1`, capacity admission, audited budget reset | GAP, not minted | no hits under `packages/`; W576 FAILED and W695 owns re-mint of real FAILED work — a new item would duplicate that triage | W576/W695 |
| `lifecycle-launch-contract.md` fencing, UNKNOWN holds, recovery CAS | LANDED | W572, W573 | W572/W573 |
| `parked-branch-audit-2026-10-07.md` option B/C | STALE / LIVE | 50+ `parked/*` branches (doc says 11); `refs/archive` empty; W165 `profile.ts`/`secrets-home.ts` absent from main. Recovery list is W695's deliverable | W385/W695 |

### Harness-lift / research docs

| Doc | Verdict | Evidence | Item |
| --- | ------- | -------- | ---- |
| `harness-lift-research.md` #2a tri-state liveness, #2b `work extend`, #4 steer delivery, #5 paired-arm evals | LANDED | `lib/reclaim-liveness.ts`, `work.ts:225,1305`; `gates/files.ts:197-202`; `packages/blam/bench/paired/*` | W610/W611/W612 |
| `harness-lift-research.md` #1 claim_epoch, #2d origin-scoped reclaim, #3 fail_count/--cause | **GAP — DONE but unmerged** | W609 `152382d2`, W613 `2df48987`, W616 `af7a1a33`: `git branch --contains` finds neither main nor W693; only `parked/*` and `origin/suspenders/W609,W613`. HEAD: `claim_epoch` only in `resume-from.ts`, no `fail_count`, blind `setState`, `lane-liveness.ts:372` `THIS_HOST = hostname()` | **W699** |
| `grid-coordination-research.md` A poison quarantine | GAP | same as W616 | W699 |
| `grid-coordination-research.md` B executor trust tally | LANDED | `lib/executor-cv.ts` | W620 |
| `grid-coordination-research.md` rest | RESEARCH-ONLY | no actionable ask | — |
| `swarm-comms-research.md` capsule, consult feedback/expiry, `coord targets --cap` | LANDED | `coord/facts.ts:160-231`, `coord/consult.ts:246-313`, `lib/consult-expiry.ts`, `coord/addressing.ts:311-313` | W617 |
| `swarm-comms-research.md` `--cause` | GAP | rides W616 | W699 |
| `swarm-comms-research.md` `work ready --json` requires-match hint | minor, not minted | nice-to-have, no defect | — |
| `owner-correction-taxonomy.md` | PARTIAL, not minted | `coord/wisdom.ts` implements C1, C2, C7 (W469/W470); C3/C4/C5/C8/C9/C10 absent — low-priority detector backlog | W469/W470 |

### Enterprise / NAS docs

Hub state is from graph state, not rendered config (`stack.yaml` read denied
to the audit agent).

| Doc | Verdict | Evidence | Item |
| --- | ------- | -------- | ---- |
| `enterprise-posture-audit.md` spokes/entitlements/usage/manifest/CR to overlay | LANDED | public `buckle/src/gov` holds only `federation*.ts`, `hub-seam.ts`; overlay `origin/main` carries the rest; no federation files left in `packages/belt` | W233.x, W688.1.1.3, W233.4 |
| `enterprise-posture-audit.md` ladder step 2 (hub flips) | Desktop LANDED, NAS GAP | desktop W689/W692; NAS W493.3/W632 FAILED, owner-blocked NEED_DECISION #30282 | W632 (→ W695) |
| `enterprise-gap-review-w688-2026-10-12.md` | LANDED / STALE | overlay published (tags stack-fdf90f0…6161cb2); "W233.3 MISSING" stale (`cr-provider.ts` on overlay main); desktop flip + bump W692 | W688.1.1, W692 |
| `enterprise-gap-review` hub-entry gov wiring | LIVE | `server.ts:351-375` `boot()` passes only `rootKey`/`adaptation` | W688.7.1 ◐ |
| `enterprise-gap-review` W235 `manifest.json`, enrollment walk e2e | GAP, owned | W688.4 / W688.6 FAILED; W695 triage re-mints or closes | W695 |
| `enterprise-packaging-v0.md` W231 gate-map row (`:40,82`) | STALE | contradicts W690 (admin GUI is base) | **W702** |
| `enterprise-packaging-v0.md` per-repo pin policies | STALE-claim | no pin-policy module in overlay; build or drop is an owner call, not minted | — |
| `overlay-flip-gate-w233-5-2026-10-11.md` | LANDED / STALE | desktop flip done; pin `stack-5234813` superseded by `stack-6161cb2` | W692, **W702** |
| `nas-dsm-7-4-1-upgrade-runbook.md`, `nas-flip-retry-w632.md`, `nas-route-blocker` | GAP, owner-blocked | route restore + `hubctl deploy nas` gated on #30282; W484.1 FAILED behind it | W632/W484.1 (→ W695) |
| same: ssh legs lack `ConnectTimeout` | **GAP** | `deploy/hubctl.ts:117,190,197` ssh and `:137` scp, no timeout flags (~75 s hang) | **W701** |
| `w232-remote-split-record.md` | STALE | "not on GitHub yet" and "suspenders-remote adds admin GUI" both superseded | **W702** |
| `adaptation-surface-v2.md` five seams, residency telemetry, docker e2e | LANDED | `gov/adaptation.ts`, `residency.ts:143`, `deploy/e2e/e2e-compose.yaml:311-347` | W235/W234 |
| `adaptation-surface-v2.md` tamper-evident audit stream | **GAP** | no `prev_hash`/hash-chain in `packages/buckle/src` | **W703** |
| `decision-w690-*` federation, teams/ceilings public | LANDED | `middleware.ts:515`, `schema.ts:154-157` | W690 |
| `decision-w690-*` teams-deltas mirror drops ceilings; `finding.auth-posture-split` W231 clause | conditional / STALE | `schema.ts:103`; fact refresh rides W702 | W702 |
| `identity-enrollment-pilot.md` verbs | LANDED | `hooks/coord/identity.ts:39,93,195,264` | W459.5 |
| `identity-enrollment-pilot.md` pilot G1–G6 | GAP, owned | never run (no `.klh/repo-hint.json`); parent W459 FAILED | W459 (→ W695) |
| `governance-mode-enrollment.md` | RECORD | `hooks/coord/governance.ts` exists; nothing actionable | — |

### Identity / observability / starter / demo docs

FAILED parents (W459, W458.6, W454, W491, W552, W552.6) are not coverage; W695
owns that triage, so their residual gaps are noted, not re-minted.

| Doc | Verdict | Evidence | Item |
| --- | ------- | -------- | ---- |
| `cross-hub-project-identity.md` stages 1–3, resolver use, rekey `decisions`, lane-id qualification, KB project filter, hub attribution | LANDED | `govdb-project.ts:37-62`, `lib/exec-namespace.ts`, `coord/identity.ts:93-280`, `coord/fleet.ts:1049`, `lib/laneslug.ts:16-19`, `coord/shared.ts:115`, `dispatch-next.ts:725-733` | W459.1/.2/.5, W460, W615 |
| same: resolver honours binding; writers enforce `writes_enabled`/`authority_epoch` | GAP, owned | `govdb-project.ts:29-55` ignores enrollment; no writer reads `writes_enabled` | W459 (→ W695), W539.1 |
| same: stages 4–8 migration verb (alias map, backup, orphan checks) | GAP, design only | rekey still rename-only `fleet.ts:903-1066`; low priority until a second clone | W459 (→ W695) |
| same: store RPC / WS feed tenant boundary | GAP, owned elsewhere | `store-server.ts:175-198` any SQL behind token; `:150` scope-only filter; W694 adversarial review in flight | W694 |
| `upstream-observability-architecture.md` traceparent, observations, projection | LANDED, off by default | `buckle/src/wire.ts:38`, `trace.ts`, `observe.ts:49`, `projection.ts:212` | W461, W621 |
| same: plane has no producer | **GAP** | `appendObservation` called only from its test | **W705** |
| same: origin vs peer; billing once per hop | **GAP** | `observe.ts:22-32`, `ledger.ts:61` | **W706** |
| same: OTLP export, broker/HA | DEFERRED | doc gates on measured need | — |
| same: relay config | GAP, operator | `observation-relay.ts:204` disabled until configured | W491 (→ W695) |
| `starter-registry-architecture.md` artifacts, grants, materialize lib, cache boundary, promotion | LANDED | `starter-artifacts.ts:73`, `starter-distribution.ts:49`, `starter-materialize.ts:104`, `cache-boundary.ts:28`, `promotion.ts:33` | W458.1–.5 |
| same: line 5 "nothing implemented yet" | STALE | rows above | — |
| same: materialization wired into dispatch | GAP, owned | `materializeStarter` has no caller outside module/tests; dispatch uses W454 fork path | W454/W458.6 (→ W695) |
| `gui-observability-review.md` findings 1–9, key-admin GUI | LANDED / STALE | W476–W478, W231 done | W476–W478 |
| same: orchestrate children readback | **GAP** | `board/orch.ts:301` normalizes, `:358` queries raw key | **W704** |
| `health-status-contract.md` | LANDED | `deploy/healthcheck/probe.ts:330-429`, `belt/bin/health.ts:56`, `deploy/hubctl.ts:319` | W485 |
| same: "NAS unreachable, nothing deployed" | STALE | NAS activation done | W486/W552.3 |
| `demo-single-request-take.md` | LIVE | routing/empty-output fix in flight; take needs owner GO #30663 | W552.6.1 ◐ |
| `silent-recording-capture-pipeline.md` | RECORD | only open action is the owner's recording | W552 |

## Minted by this audit

W696 db-backup rotation sort · W697 hub-compose hardening · W698 release
manifest/SBOM/rollback · W699 re-land W609/W613/W616 · W700 machine-state
leaks · W701 hubctl ssh timeouts · W702 stale-claim doc refresh · W703
tamper-evident audit stream · W704 orch readback key · W705 observation
producer · W706 hop attribution.
