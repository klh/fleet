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

See the per-doc sections appended below.
