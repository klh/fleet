# Skills catalog audit (W1144)

Nine-category structure audit of the fleet skill surfaces, landed 2026-10-22.
Source taxonomy: "Lessons from building Claude Code: how we use skills"
(claude.dev/blog/lessons-from-building-claude-code-how-we-use-skills/, read
2026-10-22 via the lane) — "The best skills fit cleanly into one [category];
the ones that try to do too much straddle several and confuse the agent."

Surfaces audited:

- **Catalog** — `skills/` (this repo; the W772 distribution surface, 12
  packages, synced by install via `npx skills add`)
- **Active install** — `~/.claude/skills/` (38 packages: catalog + klh-\*
  twins + kept third-party)
- **Parked** — `~/.claude/skills-available/` (30 packages, parked 2026-09-03
  on retroactive `skillUsage` evidence; see its README)

Live usage evidence: `bun packages/suspenders/hooks/bin/skill-usage.ts`
(W1144 pre-skill gate → `~/.claude-insights/skill-invocations.ndjson`) —
the never-triggered set is now continuous, not a one-off cleanup.

## The nine categories (article taxonomy, verbatim)

1. **Library and API reference** — how to correctly use a library, CLI, or
   SDK; reference snippets + a gotchas list.
2. **Product verification** — how to test/verify code works, often paired
   with playwright/tmux; the article: verification skills have had the most
   measurable impact on output quality.
3. **Data fetching and analysis** — connect to data/monitoring stacks;
   dashboards, query patterns.
4. **Business process and team automation** — repetitive workflows as one
   command (standup, ticket creation).
5. **Code scaffolding and templates** — generate framework boilerplate.
6. **Code quality and review** — enforce quality, review code; includes
   testing practices ("how to write tests and what to test").
7. **CI/CD and deployment** — fetch/push/deploy code.
8. **Runbooks** — symptom → multi-tool investigation → structured report.
9. **Infrastructure operations** — routine maintenance and operational
   procedures, some destructive, benefiting from guardrails.

## Category map

### Catalog (skills/, 12) — the shippable surface

| Skill | Category | Note |
|---|---|---|
| review | 6 · quality/review | verdict contract + fleet-trap gotchas (W1144) |
| test | 6 · quality/review | testing practices; Prove-It borrows cat-2 verification |
| build | 4 → 6 ⚠ | TDD task-loop straddles process and testing practice |
| plan | 4 · process | |
| spec | 4 · process | |
| ship | 7 · CI/CD + deploy | |
| fleet-install | 7 ⚠ | deploy/install core with cat-9 onboarding spillover |
| fleet | 3 + 9 ⚠ | kitchen-sink: state render (3) + governance mode switch (9) |
| fleet-pulse | 3 · data/analysis | the fleet's monitoring-read face |
| local | 9 · infra ops | inference-posture switch, guarded |
| cloud | 9 · infra ops | inverse of local |

⚠ = straddler. One true kitchen-sink: **fleet** renders live state AND flips
a guarded global (governance mode). Split candidate: narrow `fleet` to the
mode switch (cat 9, guardrail-worthy) and let `fleet-pulse` own all state
renders (it already does, minus the watchdog emphasis). **build** straddles
4/6 tolerably (its TDD cadence IS its content); **fleet-install** is
cat-7-core and stays.

### Active install (~/.claude/skills, 38) beyond the catalog

| Skill | Category |
|---|---|
| ast-grep, zsh, docker, az, sqlite, sql-best-practice, csharp-best-practice, md-format, zod4, context-engineering | 1 · reference |
| klh-electron-dev, klh-paddle, agentaccess, photoshop-uxp-drive, gmail-access | 1 · reference (external API/service) |
| browser-testing-with-devtools, verification-before-completion | 2 · verification |
| skill-security-review, klh-code-simplifier, git-workflow-and-versioning | 6 · quality |
| test-driven-development, quiet-work, find-skills, skill-lookup | 6/4 · process-adjacent |
| dinero-regnskab | 4 ⚠ + 8 (browser runbook character) |
| klh-product-launch | 7 · deploy-adjacent |

### Parked (~/.claude/skills-available, 30)

| Skill | Category | Parked-state note |
|---|---|---|
| find-bugs | 6 | base twin of active klh-find-bugs |
| lit-dev, core-components, cli-speed-tools, openapi-directory-first, project-memory, settings-audit, systematic-debugging, testing-patterns, zod-validation, agents-md, code-simplifier | 1/6 | byte-identical twins of active klh-\* versions |
| api-and-interface-design, code-review-and-quality, code-simplification, debugging-and-error-recovery, deprecation-and-migration, documentation-and-adrs, frontend-ui-engineering, performance-optimization, security-and-hardening | 1/6/8 | unused addyosmani set, never invoked since 2026-06 |
| planning-and-task-breakdown, incremental-implementation, shipping-and-launch, ci-cd-and-automation, code-documenter, idea-refine | 4/5/7 | same unused set |
| using-agent-skills, all skills | meta | trigger-heavy meta; taxonomy has no meta bucket |
| csharp-docstrings | 1 | twin |

## Gap analysis (what the nine-bucket lens exposes)

- **Category 2 (verification) is the proven quality lever and the fleet's
  thinnest active category**: one dedicated browser-verification skill plus
  verification-before-completion guidance. The parked `find-bugs` twin is
  the nearest dormant asset. W1144 invests here (see "Verification-skill
  investment" below).
- **Category 5 (scaffolding) is empty** — the fleet scaffolds via law docs
  and verb-kit templates, not skills. A `new-hook-gate` or `new-verb`
  scaffolding skill is the obvious candidate if scaffold asks recur.
- **Category 8 (runbooks) is empty by design** — incident knowledge lives in
  coord facts (`lesson.*`) per the W142 knowledge architecture, not skills.
  A hub/NAS incident runbook skill would only duplicate facts; revisit only
  if an investigation recurs often enough to want a scripted driver.
- **Category 3 is one skill deep** (fleet-pulse). The usage-report and
  credit-forecast faces are hook bins, not skills — correct per the
  install-grade law; skills would fork their documentation from the code.
- **Meta skills** (find-skills, skill-lookup, using-agent-skills) sit outside
  the taxonomy; the W1144 invocation log will show whether they ever fire.

## Verification-skill documentation changes

The article: verification skills have had the most measurable impact on
output quality — worth a disproportionate share of skill effort. W1144
invested in `review` (the catalog's named verification candidate):

Before: five generic axes, no fleet traps, no output contract. After: five
axes plus an evidence contract (file:line on every finding, declared
read-status per file, machine-parseable `VERDICT:` final line) and eight
fleet-documented trap gotchas (A/B baseline, pipe-to-tail, shared stash,
read-what-you-cite, bun:sqlite null-vs-undefined, empty-string env knobs).

`tests/skills-catalog.test.ts` checks that the skill documentation names
trap classes also represented in `tests/fixtures/review-eval/seed.ts`.
This is a documentation contract: it does not run a reviewer, detect the
seeded defects, or measure an improvement in review quality. An agent
quality evaluation remains outstanding; Fleet-pulse verification and the
find-bugs/verify lanes remain candidates for that work.

## Tools become constraints — the gate re-verification pass

The article's TodoWrite lesson: tools that forced care under weaker models
become pure friction under stronger ones — audit periodically. The hook-gate
plane re-verified against today's carrier mix (glm-5.3-flash lanes,
claude-sonnet-5 escalations):

| Gate | Verdict | Reasoning |
|---|---|---|
| scrub (commit/push secret+path scan) | **keep** | model-independent: no carrier "knows" the operator's local paths/keys; failure cost is irreversible |
| 1500-line cap + patch-first | **keep** | forced decomposition still pays: near-cap files measurably strand editors and corrupt under emission drift, regardless of model strength |
| mutation-size (≤40-line writes) | **keep, watch** | emission corruption is a live property of TODAY's strongest carrier too (W1144's own test-file Write was gate-caught mid-flight); revisit per model generation |
| content-gate transpile check | **keep** | caught 2 corrupted payloads in this lane alone — the cheapest safety net on the plane |
| edit-enforce (no shell file writes) | **keep** | shell heredoc writes bypass the content gate; the constraint IS the gate |
| governor lease / location-vs-claim | **keep** | coordination correctness, not model care |
| fat-read deny / re-read nudge | **watch** | nudges train carriers to ignore them (sha-keyed cooldown exists); if invocation logs show high deny rates with low compliance, downgrade to advisory |
| skill trigger descriptions | **new lever** | weak models need long trigger prose; strong carriers need the negative space ("NOT for X") — W1144 descriptions carry both |
| runaway breaker | **keep** | dollar/fail-streak guard, model-independent |

Verdict: no gate retires today. The one flagged for per-generation review is
the nudge plane (fat-read) — its cooldown already implements the article's
"cooldown on repeated nudges" instinct; usage data (invocation log +
denied-calls audit) now exists to judge it on evidence at the next audit.
