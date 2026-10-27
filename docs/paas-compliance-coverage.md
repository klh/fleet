# PaaS standard compliance coverage (W1303 parent)

Oct 25, 2026 · lane autow1303 (W1303, parent plan). Companion to
[standard-dispositions.md](standard-dispositions.md) (W1301): that file records
every deliberate DIVERGENCE; this one proves COMPLETENESS — every clause of the
[standard](paas-engineering-standard-2026-10-23.md) is either enforced by a
landed fleet check, owned by a W1303 child, or has a disposition row. A clause
in none of the three states is a defect (owner law, W1238 class).

Child landing updates the owning row's Status to `LANDED <sha>` (same
maintenance rule as the dispositions ledger).

## Coverage matrix

Standard sections → fleet state. "Child" = the W1303.x item that owns closure.

| Standard clause | Fleet state today | Closed by | Status |
| --- | --- | --- | --- |
| Principles 1-2 (native first, boring/inspectable) | Platform APIs before wrappers is repo law (AGENTS.md code style); dep budget rows below | dispositioned | ALIGNED |
| 3 Composition: 1500 cap, 1200 near-cap stop, DRY 2nd dup | on-write gate blocks past 1500 (SUSPENDERS_MAX_MUTATION class), CI via `tests/law-guards.test.ts`; AGENTS.md DRY law | landed checks | ALIGNED |
| 3 Stateless leaves; variants compose | AGENTS.md code style (composition/mediator, Lit components) — principle, no per-file check | accepted (principle-level) | ALIGNED |
| 4 `<namespace>.<thing>.<role>` naming | kebab-case is canonical (W669 layout convention); dot-roles for NEW modules only | dispositions #5 | DISPOSITIONED |
| 5 Schema first (zod defines shapes, types derived) | zod in 13 files, no discipline; hand-written dup types on wire surfaces | W1303.4 | LANDED df2a3f0f |
| 6 Events up, data down (typed events, mediators) | Lit component law in AGENTS.md; event-mediator pattern in belt board-html — principle-level | accepted | ALIGNED |
| 7 One test framework (Playwright only) | bun:test ~458 suites + Playwright e2e; migration rejected as pure churn | dispositions #8 | DISPOSITIONED |
| 8 Semantic errors, one handler | No error-kinds module; problem+json absent | W1303.2 | LANDED 10f1ccd4 |
| 9 Good HTTP citizen (server) | URLPattern 0, Idempotency-Key 0, problem+json 0, ETag partial, Retry-After unclamped | W1303.2 | LANDED 10f1ccd4 |
| 9 Good HTTP citizen (client) | Timeouts/backoff/breaker scattered across buckle admission + belt router, no deadline propagation | W1303.3 | LANDED d3c0a839 |
| 10 Every folder a package, installed strictly | Conforms: exports/files/bin/engines + exact pins across all 10 packages (10 manifests on tree, 2026-10-27); telemetry manifest landed; guards green in push gate | W1303.1 (.1.6-.1.10) | LANDED 8826faf8 · 42f66ce0 · 756fb519 · 95da80fb · 346d14ed |
| 11 Same shape everywhere | Partial: shared qlty, .githooks, AGENTS.md; naming diverges (row 4) | W1303.1 + dispositions | SPLIT |
| 12 Config off-repo | Machine-level 0600 conf (stack.json, local-llm/*.env), repo placeholders only — law W1253 | landed checks | ALIGNED |
| Repository layout (six groups, workspaces) | packages/* monorepo, bun workspaces; layout differs by design | dispositions #3 #4 | DISPOSITIONED |
| Package contract (exports/files/bin/engines/exact pins) | Conforms everywhere (measured absent → repaired via .1.9/.1.10) | W1303.1 | LANDED 95da80fb · 346d14ed |
| Installed-not-mounted + check-pack | Hubs mount git-pulled volumes at the pinned ref (one-version law); check-pack proves scratch install of every package | W1303.1.8 | LANDED 756fb519 |
| Composition: hard caps + smells | Covered above (row 2) | landed checks | ALIGNED |
| npm workspaces linked install, .npmrc | bun workspaces + single bun.lock, runtime-native | dispositions #3 | DISPOSITIONED |
| Versions exact everywhere (incl. internal) | Exact MAJOR.MINOR.PATCH everywhere incl. @klh/* siblings; check-versions green | W1303.1.6/.1.9 | LANDED 8826faf8 · 95da80fb |
| Plain semver, no pre-release suffixes | Tags exist (60), versions agree at 2.0.0; no pipeline guarantees agreement | W1303.6 | LANDED d69ec274 |
| One version repo-wide (fixed mode) | stack.json `version:` pins buckle+suspenders+belt; manifest-tag agreement unproven | W1303.6 | LANDED d69ec274 |
| Dependency budget (7 deps, allowlist) | check-deps (42f66ce0) fails phantom/unused deps; numeric cap not enforceable under bun workspaces | gap #2 below | DISPOSITIONED |
| Dependency budget: no shell scripts | Banned by AGENTS.md law; tracked .sh set pinned by `tests/law-guards.test.ts` | landed checks | ALIGNED |
| UI: native first → Lit → compose, tokens | Lit + design tokens law; vendored Lit, never CDN (AGENTS.md) | accepted | ALIGNED |
| Events/mediators (typed events, handled()) | Principle-level in AGENTS.md; no check | accepted | ALIGNED |
| Zod boundary table (safeParse etc.) | Absent on wire surfaces | W1303.4 | LANDED df2a3f0f |
| Errors: 8 kinds, problem+json, guards | Absent | W1303.2 | LANDED 10f1ccd4 |
| Debug levels (namespaced logger, redaction) | Namespaced logging exists (buckle observe.ts, NDJSON to stdout); scrub redaction law W236 | partial, accepted | ALIGNED |
| Health outside-process | Owner law 2026-10-05: every hub service has a probe sidecar (deploy/healthcheck/probe.ts) | landed checks | ALIGNED |
| HTTP server kit (@paas/http surface) | Absent | W1303.2 | LANDED 10f1ccd4 |
| HTTP client kit (@paas/resilience surface) | Scattered; AIMD ledger W1280 + gap escalation W1273 exist to build on | W1303.3 | LANDED d3c0a839 |
| Testing Playwright-only, shared config | bun:test retained | dispositions #8 | DISPOSITIONED |
| Load tests same specs | N/A (no PaaS traffic surface); e2e suite exists | accepted | ALIGNED |
| Code review: agents first, risk tiers | Guarded merge ladder + oracle review exist; NO tier classifier, no CODEOWNERS, no PR template, no area REVIEW.md | W1303.5 | LANDED 592a26a2; approval-consumption repair W1308 f7f10d0d |
| Review: decisions-not-queues | `coord emit NEED_DECISION` is fleet law | landed checks | ALIGNED |
| Keeping review useful (round cap 3, incidents→evals, human-time metric) | SPLIT — round cap LANDED 4bfc1839 (hooks/lib/gates/review-round-cap.ts: scheduleReview stops after 3 failed review passes, NEED_DECISION to the author); incidents→evals GAP W1476; human-time GAP W1477; rationale docs/standard-dispositions.md #10 | W1303.7 · W1476 · W1477 | SPLIT: 1 LANDED · 2 GAP |
| Enforcement table (npm ci, check-versions/deps/boundaries/pack/ui-laws, gen-openapi) | check-versions (8826faf8) + check-deps (42f66ce0) + check-pack (756fb519) + gen-openapi --check (df2a3f0f) wired in gates; import-law ratchet + law-guards CI + ui-laws pre-existing | W1303.1 + W1303.4 | LANDED 8826faf8 · 42f66ce0 · 756fb519 · df2a3f0f |
| Branch protection (no force-push main) | Guarded merge ladder + scrub gate; push gates in .githooks | landed checks | ALIGNED |
| .prefer harness lock-down | Implemented: examples/prefer.example + parsers (exec-chain, prefer, prefer-routing) | landed checks | ALIGNED |
| .editorconfig | Landed matching qlty's enforced format | this branch | LANDED 54600489 |

## Open gaps recorded (owned, not child-dispatched)

Two clauses failed all three completeness states at measurement (2026-10-25).
Both resolved since: #1 landed, #2 dispositioned below. Kept as the audit
trail per the W1303 completeness contract.

1. **`.editorconfig` absent** (standard: Tooling config). Fleet standardizes on
   qlty/biome for formatting, which supersedes editor-level config for
   check-purposes — but the file is cheap and the standard lists it as one of
   the three tooling files. Disposition: land a minimal `.editorconfig`
   (utf-8, lf, 2-space, trailing-whitespace trim, md exempt) matching what
   qlty already enforces. LANDED: 54600489 (this branch).
2. **Dependency budget has no repo-wide allowlist check** (standard: seven
   deps). Fleet's law is platform-first curation, but nothing fails CI when a
   new runtime dep appears. Disposition: the honest fleet equivalent is the
   import-law ratchet + review; a hard allowlist would fight bun workspaces
   (dispositions #3). W1303.1.7 landed `scripts/check-deps.ts` (42f66ce0):
   phantom/unused/reach-in/kernel findings over the ONE W1249 scanner, exit 1
   on findings — every declared dep must have an importer. That closes the
   failure-mode half (stale/phantom deps now fail); the numeric cap (≤7)
   stays a documented accepted-divergence per dispositions #3.

## Completeness statement

W1303 (this parent) is complete when: (a) every row above is `ALIGNED`,
`DISPOSITIONED`, `LANDED <sha>` via its child, or an explicit OPEN-GAP with a
disposition; (b) all six children W1303.1-.6 are done with landed shas; (c) the
two open gaps are closed or dispositioned. Verified against the standard's own
Enforcement table (lines 855-875) and Review log corrections.
