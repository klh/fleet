# Fleet standard dispositions (W1301)

Oct 25, 2026 · closes the W1238 review blocker class (untracked deviation)

Owner law: a deviation from the house standard without a tracked disposition
is a defect. This file is the disposition ledger for every deliberate
divergence of fleet from the TypeScript PaaS monorepo engineering standard
([paas-engineering-standard-2026-10-23.md](paas-engineering-standard-2026-10-23.md)).

Scope ruling (restructure proposal
[Amendment C](restructure-proposal-2026-10-23.md#amendment-c--alignment-with-the-paas-engineering-standard)):
the standard's mechanics govern the paas repo it was written for; fleet adopts
its principles and enforcement doctrine ("a rule without a check is a wish").
Every divergence below is deliberate, with rationale and the owner decision
that backs it. Divergences fleet does NOT defend are marked GAP and carry the
owning work item. The umbrella compliance plan is W1303 and its children
P1–P6.

## Disposition matrix

| # | Area | Standard | Fleet today | Disposition | Owning item |
| --- | --- | --- | --- | --- | --- |
| 1 | Main history | Rebase-only, linear `main`, no merge commits | Guarded merge ladder: `merge --no-ff` in a scratch worktree, `--ff-only` publish | ACCEPTED-DIVERGENCE | — |
| 2 | Worktree location | Beside the repo, under a shared tree root | `.worktrees/<id>` inside the repo, claim-bound (W870) | ACCEPTED-DIVERGENCE | — |
| 3 | Installer | npm workspaces, `install-strategy=linked`, `npm ci`, second lockfile banned | bun workspaces + one `bun.lock`, bun runtime throughout | ACCEPTED-DIVERGENCE (strictness via guards) | W1303.1 |
| 4 | Hub deploys | Images `npm install` their own package, never mount the repo | Hub containers mount git-pulled volumes at the pinned stack ref | ACCEPTED-DIVERGENCE | W1303.1 |
| 5 | File naming | `<namespace>.<thing>.<role>.<ext>` everywhere | kebab-case (layout convention W669); dot-roles for NEW modules only | ACCEPTED-DIVERGENCE (scoped adoption) | — |
| 6 | Validation | Zod defines every shape; types derived; `gen-openapi --check` | `JSON.parse` is the one config parser; zod in a handful of files, no discipline | SPLIT: config parser ACCEPTED-DIVERGENCE · wire contracts LANDED (`df2a3f0f`) | W1303.4 |
| 7 | HTTP kit | `@paas/http`: ETag/If-Match, Idempotency-Key, problem+json, shed, deadline | Kit LANDED as `packages/buckle/src/http-kit.ts` (in-package, NOT a separate `@paas/http` package): Retry-After clamped on every emission, problem+json error-kinds, Idempotency-Key replay, aids family on RouteTable | SPLIT: kit shape ACCEPTED-DIVERGENCE (in-package module, no standalone package) · mechanics LANDED (`10f1ccd4`/`7fc06769` server, `4db0f091`/`d3c0a839` client) | W1303.2 · W1303.3 |
| 8 | Test framework | `@playwright/test` only, every test | bun:test unit + Playwright for e2e/load, two frameworks BY LAYER (W1238.2 decision `d8563e1c`); the `*.test.ts` → `*.e2e.ts` port sweep (W1306 `c2ff563d`, W1294.17.*) is DONE + pushed, unmerged at audit time | ACCEPTED-DIVERGENCE (documented decision, ports in flight) | W1238.2 |
| 9 | One version | npm fixed-mode: every manifest bumps together, tagged | `stack.json` `version:` pins buckle+suspenders+belt (config-level pin) | ACCEPTED-DIVERGENCE · pipeline LANDED (`d69ec274`); the release cut itself rides W1311 | W1303.6 |
| 10 | Review usefulness | Round cap 3; incidents become evals, rescored on reviewer change; measure human time, revert/incident rate as guardrail | Review scheduler enforces the round cap; a revert or incident landing mints a review-arena case, and a reviewer prompt/model/tool change reruns the W792 arena on the whole sealed set; W846 measures decision latency (no approvals metric, no guardrail) | SPLIT: round cap LANDED (`4bfc1839`) · incidents→evals LANDED (`7b890e0f` trigger, `77a5ba4b` rescore) · human-time GAP | W1303.7 · W1476 · W1477 |
| 11 | CI enforcement | Every rule enforced by a check, wired in CI: 1500-line cap, `check-deps` phantom imports, qlty in pre-push + CI, generated OpenAPI diffed in CI | Checks exist (law guards, import-law ratchet, `.githooks/pre-push`) but ride local hooks + lane gates; no fleet-owned CI workflow runs them on push | GAP | W1759 |

## Rationale per row

### 1 · Merge ladder vs rebase-only main — ACCEPTED-DIVERGENCE

Fleet's actor model is dozens of concurrent agent lanes, not serialized human
branches. Each lane lands through the review-gated guarded merge ladder
(`guardedMerge`, `hooks/lib/fleet-loop/merge-guard.ts`): the candidate delta
is marker-scanned, scrub-scanned and quality-auto-fixed in a scratch worktree
(`qltyFixMergedFiles`), then published `--ff-only`, so `main` itself never
gains a non-ff commit from outside the ladder. The merge commit is the audit
unit — it pairs the review receipt with the lane's immutable closing SHA.
Rebase-only history would require every lane to rebase against a moving main
and would erase the immutable-baseline property the claim-check done gate
(W833) relies on. Owner decision: Amendment C — "revisit only on owner word".

### 2 · In-repo worktrees vs beside-repo tree root — ACCEPTED-DIVERGENCE

The standard moves worktrees outside the checkout so a worktree cannot
resolve the main checkout's `node_modules` (phantom deps). Fleet accepts that
resolution deliberately: the shared hoisted `node_modules` is what makes lane
spawn cheap (no per-worktree install), and the phantom-import hazard is
enforced statically instead by the W1249 import-law ratchet
(`tests/fleet.import-law.guard.test.ts`, shrink-only from the inherited edge
set). The stronger lane property the standard's layout would break is the
claim-to-worktree binding (W870): `locationVsClaim` in
`hooks/gates/governor.ts` denies any edit outside the claiming lane's
`.worktrees/<item>` tree. Lane worktrees are ephemeral (rogue-reap prunes
merged-and-clean trees), unlike the standard's long-lived human worktrees.
Owner decision: Amendment C.

### 3 · bun workspaces vs npm linked install — ACCEPTED-DIVERGENCE

Fleet is a Bun-native agent stack: every service and lane runs `bun`
entrypoints, and a second installer would mean a second lockfile class
serving no fleet consumer. The checkable intent behind the standard's npm
rules — per-package strictness, exact pins, no undeclared imports — is
enforced natively: the import-law ratchet today, and W1303.1 (P1) landing
`exports`/`files`/`bin`/`engines` manifests, exact `MAJOR.MINOR.PATCH` pins
including `@klh/*` siblings, and bun-native `check-versions` / `check-deps` /
`check-pack` law guards in the push gate. The standard itself flags npm's
linked strategy as freshly stable with open workspace bugs; fleet does not
bet a live multi-lane repo on it. Owner decision: Amendment C — "the
checkable equivalent is the manifest + import-direction guards, not an
installer switch". The missing strictness pieces are a GAP owned by W1303.1.

### 4 · Git-pulled volumes vs npm-pack installs — ACCEPTED-DIVERGENCE

The standard's "installed, not mounted" rule serves a published-registry
PaaS. Fleet's hubs (nas, desktop) are private, deploy from the single fleet
repo, and take the pinned `version:` ref from `~/.config/klh/stack.json` —
the git ref IS the release artifact (one-version law; no host-path deploys).
No registry exists to `npm install` from, and mounting keeps the deploy
provable against the exact ref. Repo health still needs the packability
proof: W1303.1's `check-pack` (pack every package, scratch-install the
tarball, import every export, run every `bin --help`) lands as a push-gate
guard without changing the deploy channel. Hub-side ref hygiene
(preflight that the pinned ref exists) is owned by W1302.3.

### 5 · Kebab-case vs namespace.thing.role naming — ACCEPTED-DIVERGENCE (scoped)

Mass-rename is rejected: the local-llm runtime home overlays package files
verbatim (W556; `docs/layout-convention.md`), so renames fork every deployed
host, and launchd plists plus `swarm.ts` name today's paths. kebab-case stays
the law for existing code (layout convention W669 is canonical). The
standard's dot-role naming is adopted for NEW surfaces only — kernel and
newly extracted modules — per Amendment C. No law guard enforces dot-roles
on new files yet; adopting one is future work under the W1303 umbrella, not a
tracked gap item today.

### 6 · JSON.parse config parser vs schema-first — SPLIT

- **Config parsing — ACCEPTED-DIVERGENCE.** The config-over-code law (W1253
  Amendment A) makes `JSON.parse` the ONE parser for every fleet config read;
  machine conf stays 0600 operator-owned. Zod may validate AFTER parse on new
  surfaces, but nothing replaces the parser.
- **Wire contracts — LANDED (W1303.4, `df2a3f0f`).** Zod wire contracts with
  derived types landed for the buckle proxy API, board API payloads and the
  hubctl `stack.json` shape; the hand-written duplicates are gone.
  `gen-openapi --check` runs in `.githooks/pre-push` (green at audit time,
  W1714 @ `b7d773f0`). The kernel stays zod-free (C83) — schema-first is a
  surface law, not a kernel law.

### 7 · HTTP contract kit — LANDED (server `10f1ccd4`/`7fc06769`, client `4db0f091`/`d3c0a839`)

The GAP was a measured absence (URLPattern 0, Idempotency-Key 0, problem+json
0, ETag partial, Retry-After unclamped — the unclamped value is a known
incident class: a quota wall can stall a client for weeks). It closed with a
recorded divergence: the standard's `@paas/http` standalone package became an
in-package module, `packages/buckle/src/http-kit.ts` — no separate `@klh/http`
package exists or is planned. W1303.2 (P2) landed the server kit — semantic
status matrix, one error-kinds module emitting problem+json, Idempotency-Key
replay, Retry-After clamp, ETag/If-Match, 202 pattern, shed +
`x-request-deadline` — wired onto the buckle gate and board decomposed
handlers (`7fc06769`), with the clamp proven on every Retry-After emission.
W1303.3 (P3) landed the client resilience kit on the existing AIMD admission
ledger (W1280) and gap escalation (W1273) rather than duplicating them:
timeouts, capped jittered backoff, retry budget, breaker, failover ladder
(bench rows `d3c0a839`).

### 8 · Test framework — ACCEPTED-DIVERGENCE, decided in W1238.2 (`d8563e1c`)

The standard's single-framework rule is greenfield. The owner decision is
W1238.2: two frameworks BY LAYER — bun:test for unit, Playwright for
e2e/load — with probes proving the PW runner cannot host bun-native specs
(`d8563e1c`). The migration direction exists and is in flight: the
`*.test.ts` → `*.e2e.ts` port sweep (W1306 `c2ff563d`, the W1294.17.*
slices; W1294's playwright-only migration plan itself FAILED) is DONE +
pushed, unmerged at audit time. This rationale supersedes the earlier "no
migration item exists or is planned" text, which contradicted W1238.2 and
the in-flight ports.

### 9 · Config-level version pin vs manifest fixed-mode — ACCEPTED-DIVERGENCE, pipeline LANDED (`d69ec274`)

Where the version lives is deliberate: `stack.json` `version:` is the pin
hubs pull (config-over-code), not an npm fixed-mode bump. The proof that
manifests, tag and pin agree at release time landed with W1303.6 (P6): the
release verb (bump all package.json versions in one commit, rewrite `@klh/*`
pins, tag, render the stack hint) with dry-run and tests (`d69ec274`). The
release cut itself rides W1311 (fleet-2026-10).

### 10 · Review usefulness mechanics — SPLIT: round cap + evals LANDED, human time GAP

The standard's "Keeping review useful" section carries three mechanics that
the W1303.5 tiers/CODEOWNERS/PR template do not cover; each is dispositioned
on its own, so the row never reads LANDED wholesale.

- **Round cap of 3 — LANDED (W1303.7, `4bfc1839`).** `scheduleReview`
  launches no reviewer once the item — plus the parents it repairs (children
  tagged `repair` and `review`) — holds three failed review passes: distinct
  (commit, base, instructions) contexts whose latest bound receipt FAILED;
  transport ERROR legs never count. At the cap it emits one NEED_DECISION to
  the completion author: rethink the approach (supersede the item) or raise
  `SUSPENDERS_REVIEW_ROUND_CAP` (`0` disables). Contexts, not commits, are
  the unit on purpose: the live non-converging loop is re-review of an
  unchanged commit on every main move — W1075's round-8 receipt reads
  "byte-identical to every prior FAIL round", and W1030.6 and W1124.20 show
  the same shape. Fail-open on an unreadable history (the cap guards effort,
  never correctness). Code `hooks/lib/gates/review-round-cap.ts`, tests
  `test/review-scheduler.test.ts`.
- **Incidents become evals — LANDED (W1476: trigger `7b890e0f`, rescore
  `77a5ba4b`).** Trigger: after each merge the ladder's
  `reviewEvalsAfterMerge` (`hooks/lib/fleet-loop/review-evals.ts`) reads the
  landing range — a revert of a main commit (branch-internal undos and
  re-lands drop) or a landing under an `incident`-tagged work root — banks
  one `review.incident` event per commit and mints one deduplicated
  `review,arena-case` work item per revert or incident root, naming the case
  home (`packages/belt/bench/arena/review-incident.ts`). Rescore:
  `review-run.ts --rescore-status` reports which arms (a, b, lane) saw their
  reviewer surface — prompt, model pin, tooling (`review-surface.json`) or
  the sealed set — change since their last scored run, from git and ledger
  reads with no LLM call; `--rescore` reruns each due arm over the whole
  sealed set on AC power and ledgers the per-arm score delta. The hourly
  W779 task `review-rescore` (`hooks/lib/fleet-loop/review-rescore.ts`;
  `SUSPENDERS_REVIEW_RESCORE=0` idles it) launches that run with a scoped,
  always-revoked lane key and banks a `review.rescore` event plus the
  `review.rescore.last` fact. Operator precondition: seal the set once
  (`review-run.ts --design`). Tests `tests/review-evals.e2e.ts`,
  `tests/review-rescore-arena.e2e.ts`, `tests/review-rescore.e2e.ts`.
- **Measure human time — GAP (W1477).** Exists: W846 pilot-measure reports
  NEED_DECISION emit→settle latency (p50/p90) and per-item human minutes
  (`packages/belt/bench/pilot-measure.ts`). Missing: approvals per landing
  (no human-approval connector exists — `how-to-review.md`, W1130) and the
  revert/incident-rate guardrail that tightens the tiers; its threshold is
  an owner decision.

### 11 · CI enforcement — GAP → W1759

The standard's enforcement doctrine ("a rule without a check is a wish",
:175/:198/:257/:587) assumes the checks run in CI: the 1500-line cap, the
check-deps phantom-import guard, `qlty check` in pre-push AND CI, generated
OpenAPI diffed in CI. Fleet has all the checks — law guards
(`tests/law-guards.test.ts`), the import-law ratchet,
`.githooks/pre-push` — but they ride local hooks and lane gates only; no
fleet-owned CI workflow runs them on push. W1759 owns wiring them into CI.

## Already aligned (no disposition needed)

Laws fleet and the standard share verbatim — 1500-line hard cap with the
1200 near-cap stop; DRY on the second duplicate; no shell scripts (TypeScript
on Bun); config off-repo (machine-level 0600, placeholders in repo); qlty
defaults untouched, committed `.githooks`; `CLAUDE.md → @AGENTS.md`;
native-first Lit with no `innerHTML`, bundled never CDN; agent-first review
riding `oracle review`; decisions-not-queues (`coord emit NEED_DECISION`);
every rule enforced by a check. Recorded in Amendment C; re-verified against
post-reorg main by W1302's structural-prevention plan (landed: W1302 merged
to main 2026-10-26; `docs/structural-prevention-plan.md` is on main —
verified 2026-10-26, W1301.1.1).

## Maintenance

A new divergence needs a row here the moment it is chosen — an untracked
deviation is a defect (W1238 class). A GAP row closes when its owning item
lands; the row then records the landed SHA. Related plan items: W1303
(parent), W1303.1–W1303.6 (P1–P6).
