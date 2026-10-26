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
| 6 | Validation | Zod defines every shape; types derived; `gen-openapi --check` | `JSON.parse` is the one config parser; zod in a handful of files, no discipline | SPLIT: config parser ACCEPTED-DIVERGENCE · wire contracts GAP | W1303.4 |
| 7 | HTTP kit | `@paas/http`: ETag/If-Match, Idempotency-Key, problem+json, shed, deadline | No kit: URLPattern 0, Idempotency-Key 0, problem+json 0, Retry-After unclamped | GAP (two kits) | W1303.2 · W1303.3 |
| 8 | Test framework | `@playwright/test` only, every test | bun:test (~458 suites in suspenders alone) + Playwright for e2e | ACCEPTED-DIVERGENCE | — |
| 9 | One version | npm fixed-mode: every manifest bumps together, tagged | `stack.json` `version:` pins buckle+suspenders+belt (config-level pin) | ACCEPTED-DIVERGENCE (pipeline part GAP) | W1303.6 |

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
- **Wire contracts — GAP → W1303.4.** Buckle proxy API, board API payloads
  and the hubctl `stack.json` shape have hand-written duplicate types and no
  schema discipline (measured: zod present in a handful of files only).
  W1303.4 (P4) lands zod wire contracts with derived types, deletes the
  hand-written duplicates, and adds `gen-openapi --check` to the push gate.
  The kernel stays zod-free (C83) — schema-first is a surface law, not a
  kernel law.

### 7 · HTTP contract kit — GAP → W1303.2 and W1303.3

Not a defensible divergence: measured absence (URLPattern 0, Idempotency-Key
0, problem+json 0, ETag partial, Retry-After unclamped — the unclamped value
is a known incident class: a quota wall can stall a client for weeks).
W1303.2 (P2) builds the server kit — semantic status matrix, one error-kinds
module emitting problem+json, Idempotency-Key replay, Retry-After clamp,
ETag/If-Match, 202 pattern, shed + `x-request-deadline` — proving on the
buckle gate and board routes. W1303.3 (P3) builds the client resilience kit
on the existing AIMD admission ledger (W1280) and gap escalation (W1273)
rather than duplicating them: timeouts, capped jittered backoff, retry
budget, breaker, failover ladder.

### 8 · bun:test vs Playwright-only — ACCEPTED-DIVERGENCE

The standard's single-framework rule is greenfield. Migrating ~458 bun:test
suites in suspenders alone (plus belt/buckle/blam) is pure churn with no
defect class behind it; Playwright stays for browser e2e where it is already
the tool. No migration item exists or is planned. Owner decision: Amendment
C — "no migration item".

### 9 · Config-level version pin vs manifest fixed-mode — ACCEPTED-DIVERGENCE, pipeline GAP

Where the version lives is deliberate: `stack.json` `version:` is the pin
hubs pull (config-over-code), not an npm fixed-mode bump. What is missing is
the proof that manifests, tag and pin agree at release time — tags exist but
no pipeline guarantees it. W1303.6 (P6) lands the release verb (bump all
package.json versions in one commit, rewrite `@klh/*` pins, tag, render the
stack hint) with dry-run and tests.

## Already aligned (no disposition needed)

Laws fleet and the standard share verbatim — 1500-line hard cap with the
1200 near-cap stop; DRY on the second duplicate; no shell scripts (TypeScript
on Bun); config off-repo (machine-level 0600, placeholders in repo); qlty
defaults untouched, committed `.githooks`; `CLAUDE.md → @AGENTS.md`;
native-first Lit with no `innerHTML`, bundled never CDN; agent-first review
riding `oracle review`; decisions-not-queues (`coord emit NEED_DECISION`);
every rule enforced by a check. Recorded in Amendment C; re-verified against
post-reorg main by W1302's structural-prevention plan (lands with the W1302
merge; `docs/structural-prevention-plan.md` rides branch
`suspenders/W1302` until then — verified 2026-10-25, W1301.1).

## Maintenance

A new divergence needs a row here the moment it is chosen — an untracked
deviation is a defect (W1238 class). A GAP row closes when its owning item
lands; the row then records the landed SHA. Related plan items: W1303
(parent), W1303.1–W1303.6 (P1–P6).
