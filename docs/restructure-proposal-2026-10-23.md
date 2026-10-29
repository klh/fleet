# Fleet restructuring proposal — 2026-10-23

Owner-directed examination (compartmentalization / DRY / setup). Inputs: four
read-only analysis sweeps (suspenders internals, cross-package DRY, setup
pipeline, package boundaries), a fifth agentic-ergonomics sweep (Amendment D),
the PaaS engineering standard alignment (Amendment C), coordinator
measurements, and consults C76-C83 with the ChatGPT co-supervisor. Every claim carries file:line evidence from the
sweeps. Status: PROPOSAL — items mint only on owner GO.

## Diagnosis (ranked by blast radius × recurrence)

1. **The dependency graph is invisible and contains a cycle.** suspenders
   declares only `@klh/blam` (packages/suspenders/package.json:18) but makes
   40+ runtime imports into belt/buckle/telemetry via relative paths
   (scripts/route-preflight.ts:8 → belt/bin; deploy/hub-policy.ts:5 →
   buckle/src). belt reaches BACK: belt/bin/model-store.ts:35-36 imports
   suspenders/hooks/lib — a package cycle. telemetry: 29 runtime imports, no
   package.json, no AGENTS.md, no qlty. decant (vendored) reaches into
   suspenders internals (decant/fleet/registry.ts:22). Tooling cannot see any
   of this; deploy/hub-deps.ts:4 documents that relative paths are deliberate
   to survive the hub stage — which is exactly why the graph needs to be
   encoded as a lint rule, not convention.
2. **The triple/triple duplication layer.** 215 raw `Bun.spawnSync` sites +
   7 private exec wrappers vs the self-declared "ONE way" (hooks/lib/run.ts:19;
   wrappers at scripts/lib/work-inspection.ts:13, launch-fencing.ts:129,
   merge-guard.ts:24, dialects/cline/wire.ts:117, sim/ikea-pilot.ts:44,
   belt/setup/llm-stack.ts:28, speedy/statusline.ts:75). ~35 hand-rolled
   atomic-0600 write pairs vs one helper (board-config.ts:219) and an IGNORED
   predicate (scripts/lib/export-go-gate.ts:64 `modeIs0600`). Two retry-after
   stacks in different units (belt ms router-core.ts:439 vs buckle s
   gov/budgets.ts:170). 4-6 hub-resolution stacks over one registry
   (hub-locate.ts vs belt/bin/hubs.ts:29-30 vs coord/hubs.ts:73-113 vs
   routes-fleet-tree.ts:368 vs supervisor.ts:58,1031). Twin `loadGatewayPolicy`
   in belt/bin/router-policy.ts:138 and buckle/src/policy.ts:211; two
   stack.yaml parsers; three YAML APIs. Whole-file twins: belt/bin/klh-theme.ts
   ≡ hooks/lib/theme.ts (byte-identical, 286 lines), belt/bin/klh-theme-sync.ts
   ≡ local/bin/klh-theme-sync.ts (same line numbers).
3. **The dual-home contract has already diverged.** local-llm/spawner.ts vs
   belt/bin/spawner.ts DIFFER; litellm-target.ts twins differ too — the
   repo-face/installed-face healing model (belt-bin-overlay + runtime-heal.ts)
   is broken in practice for at least two files. sync-harness still hand-lists
   SOURCE_PATHS (scripts/sync-harness.ts:26-54) — the exact W661
   hardcoded-list incident class that belt-bin-overlay already fixed with
   beltBinClosure.
4. **hooks/lib-flat is the grab-bag.** 222 flat files / 49,486 lines — larger
   than the whole belt package. Giants at the 1500 law with clean existing
   seams: knowledge-ports.ts 1332 (schema + 755-line store + 2 clients +
   prompt policy), board/data.ts 1482 (27 exports), work.ts 1495,
   dispatch-next.ts exactly 1500 (the only giant off verb-kit). Three
   colocated tests inside lib (work-report.test.ts 633, cache-drill.test,
   identity-registry.test).
5. **Setup single-source gaps.** speedy hand-writes com.klh.buckle
   (bin/install-fleet.ts:392-423) — owned by no manifest, bootable by no
   legacyLabels (services.yaml:63-312). MAINTENANCE_TASKS ↔ legacyLabels
   coupling is comment-only (maintenance.ts:9-11). ~20 scattered loopback
   defaults (127.0.0.1:4101 / :7799). hubs.json is a second, weaker registry
   belt reads independently.
6. **Runtime debris in the repo.** Root: buckle.db/-shm/-wal +
   `:memory:.lane-cache.jsonl` — buckle server.ts:124 dbPath defaults to cwd;
   root .gitignore has no db/lane-cache patterns. `.fleet`: 6,805 launch*
   files (2,268 × launch.sh/launch.json/launch.json.registered) — per-dispatch
   file-state never cleaned; launch.json.registered is itself a symptom of
   state that belongs in governor.db. `.second-draft`: stray draft, delete.
7. **decant policy conflict.** FLEET.md mandates src/ingest.ts BYTE-PURE
   (upstream re-sync recipe); it sits at 1,981 lines (over the 1500 law) and
   branch suspenders/W1107.1.1.1.2 decomposes it — contradicting FLEET.md,
   unmerged. Decide: land with a FLEET.md amendment or delete the branch.
8. **Verified healthy** (no action): install.sh is pure-TS (8-line wrapper,
   10-module installer, 15 frozen steps); hubctl is genuinely config-over-code;
   board-html vendor has real hash-parity tests (W292); skills-agents vendor is
   license-carried (but has NO hash-parity test); hub/install service
   registries are disjoint by design.

## Proposal — four phases, sequenced lane-safe

**Phase 0 — hygiene (day one, trivial; destructive deletions are NOT
lane-safe — each requires open-handle/ownership proof and a recoverable
snapshot before removal, per C85/Root adjudication 2026-10-23):**

- Root .gitignore: `*.db`, `*.db-shm`, `*.db-wal`, `*.lane-cache.jsonl`;
  buckle server.ts dbPath → runtime home (pattern: network-read-model.ts:163).
- Delete root junk (buckle.db trio, :memory:.lane-cache.jsonl,
  .second-draft, w635/w777 ledger-probe dbs).
- `.fleet` launch debris: retention janitor as a fleet-loop maintenance task
  (prune launch.* older than N days, keep registered-current), plus one-time
  prune of the 6,805 backlog.
- Decide the W1107.1.1.1.2 branch (land + FLEET.md amendment, or delete).

**Phase 1 — `packages/kernel`: the shared DRY core (the big kill):**

- Contents are all PROVEN duplicates, not speculation: `sh()/run()` exec
  wrapper (promote run.ts), `atomicWrite0600` + `modeIs0600`,
  `env.num/env.str` (trim-and-empty semantics — kills the ~411-site
  `process.env.X ?? fb` bug class at the root), theme/host-guard/servicemon/
  registry/observation (the byte-twin set — breaks the belt↔suspenders
  cycle). Optionally fold telemetry in (6 modules, 29 importers, no manifest).
- Law: kernel imports nothing in fleet; belt/suspenders/buckle/local/decant
  fleet-seams may import kernel. Encode the direction rule + the
  relative-import ban as a lint rule (ast-grep/biome) so the graph becomes
  checkable.
- Migration: package-by-package with twin-parity tests; buckle handlers/router
  ride last (the 1489-line review-heavy files).

**Phase 2 — compartmentalize inside suspenders (rolling, per-file):**

- knowledge-ports.ts → store-schema / sqlite-store / distill-clients /
  prompt-policy (export map 43-1318).
- board/data.ts → per-domain modules matching routes-actions/lanes.
- work.ts → graph-DB core (113-439) to hooks/lib; fold the pre-kit dispatch
  ladder (1470-1480) into verb specs.
- dispatch-next.ts (at cap) → move the per-lane loop body to
  hooks/lib/fleet-loop/*; finish verb-kit adoption.
- Move scripts/lib/{lane,lane-auth,launch-parent,lane-retry-budget}.ts into
  hooks/lib → hooks/lib installs without scripts/ → retire the
  dispatch-parity byte-check machinery (it exists only to police this leak).
- One spawn doctrine (collapse onto run.ts), one gateway-policy loader, one
  hub-registry owner, one YAML API; colocated tests → test/.

**Phase 3 — setup single-sources:**

- speedy's rogue plist → services.yaml entry (or boot-out).
- sync-harness SOURCE_PATHS → computed closure (share the beltBinClosure
  walker) — closes the open W661 class.
- Drift test: MAINTENANCE_TASKS names must cover/be covered by
  services.yaml legacyLabels.
- One loopback-endpoints constants module; hubs.json generated from
  stack.yaml at install (retire the second registry).

**Phase 4 — deferred decision: subpackage split of suspenders.**
Position: NOT now. 40% of suspenders is tests; the real problem is
hooks/lib-flat (49k) + scripts/ coupling, which Phases 1-2 fix without a
package split. A split breaks install prefix sync, dispatch-parity, govdb
project identity and the .prefer chain — high blast radius for organizational
gain. Re-decide after Phases 1-2: if hooks/lib is still >30k lines, split
knowledge/board into their own packages then.

## Sequencing under the live ramp

Phases 0/2/3 are rolling per-file items (review-gated ladder handles them
like any lane work). Phase 1 kernel needs a bounded window: create kernel +
twin-parity tests first (one item), then migrate importers one package per
item. No full freeze required; the only sensitive window is the buckle
handlers/router migration. ChatGPT C83 adjudication (split-vs-barriers,
artifact-install vs healing, sequencing) folds in when it lands; positions
here are mine and will be amended by it.

## Amendment A — owner directive: NO YAML, JSON as far as possible

The config-format law becomes: fleet config is JSON (`.json`); YAML is
retired from the fleet's own config surface. This collapses the format
jungle the sweeps found (three YAML APIs, two stack.yaml parsers, twin
routing-policy.yaml in belt + buckle):

- `~/.config/klh/stack.yaml` → `stack.json` (machine conf, 0600 preserved;
  install step migrates yaml→json once, keeps a `.bak`; AGENTS.md law text
  updated with the rename).
- `routing-policy.yaml` (belt/bin + buckle twins) → one
  `routing-policy.json`.
- `upstreams.yaml` (+ hub-generated upstreams.hub.yaml) → `upstreams.json`.
- hubctl renders from stack.json; the `yaml` dependency leaves
  package.json; JSON.parse is the ONE parser (no yaml pkg, no Bun.YAML, no
  global YAML). Hub-side compose.yml files stay — docker-compose's own
  contract, not fleet config.
- Migration items carry 0600/atomic-write discipline (the kernel helper) and
  a read-both/write-json transition so rolling deploys never brick a hub.

## Amendment B — C83 adjudication (ChatGPT co-supervisor), adopted

- Freeze discipline: structural migrations wait for the productive-40
  acceptance window to close. SAFE NOW = read-only architecture maps +
  narrowly tested import-direction guards (no runtime changes). Package
  moves / installer layout / identity changes need their own reviewed
  release + pause window.
- Split criteria: only a demonstrably ACYCLIC domain with independent
  lifecycle and explicit installer-closure tests; size alone does not
  justify new packages. This strengthens the Phase-4 deferral — the
  belt-suspenders cycle must be broken by kernel extraction before any
  split conversation.
- Deployment model: immutable versioned artifact activation is the target;
  healing demoted to verified reconciliation against the pinned artifact —
  never a second mutable source of truth (extend the gateway's proven
  immutable-generation seam after rollout).
- Kernel scope narrowed: small dependency-free contracts + proven duplicated
  primitives only; domains import inward; kernel imports no domain. NO
  generic retry-policy consolidation (belt ms vs buckle s ladders have
  different ownership semantics — left separate).
- Decant: upstream tree pristine, adapter boundary explicit, pinned upstream
  SHA + patch inventory + conformance tests BEFORE any rebase — so
  W1107.1.1.1.2 resolves to DELETE the branch unless the owner explicitly
  amends FLEET.md.
- Evidence that would change these positions: the measured cyclic import
  graph (belt/bin/model-store.ts:35-36 ↔ suspenders), duplicated bug fixes,
  independent release needs, measured installer-closure failures.

## Amendment C — alignment with the PaaS engineering standard

Source: `docs/paas-engineering-standard-2026-10-23.md` (owner's claude.ai
artifact, copied verbatim, 920 lines). The standard is written for a
greenfield PaaS monorepo (`paas/`) that presumes fleet as its harness
(`.prefer`, `oracle review`, `coord emit NEED_DECISION`). Scope ruling: its
mechanics govern the paas repo; fleet adopts its principles and enforcement
doctrine. Divergences below are deliberate, not gaps.

Already law, no change: 1500-line cap with a 1200 near-cap stop; DRY on the
second duplicate; no shell scripts (TS on Bun); config off-repo; qlty
defaults untouched; committed `.githooks`; `CLAUDE.md → @AGENTS.md`;
native-first Lit with no `innerHTML`; bundled-never-CDN; "a rule without a
check is a wish" (every phase item carries a guard); decisions-not-queues;
agent-first review riding `oracle review`.

Adopted into this plan:

- Phantom-dependency + unused-declared-dep check folded into the Phase-1
  import-direction lint item — the checkable form of diagnosis 1.
- Near-cap 1200 stated as law text beside the 1500 gate (files.ts).
- `<namespace>.<thing>.<role>.<ext>` naming for NEW files only (kernel,
  extracted modules); no mass rename.
- Retry-After clamp as the acceptance criterion for the retry-stack items —
  the standard independently confirms the fleet lesson that an unclamped
  Retry-After lets a quota wall stall a client for days.
- Kernel stays zod-free: schema-first (Zod 4 codecs, parse-in/parse-out) is a
  paas-repo law; new fleet surfaces may adopt codecs without pulling zod into
  the dependency-free kernel (C83).

Deliberate divergences (fleet keeps; the standard governs paas): npm
workspaces + `install-strategy=linked` + `npm ci` vs fleet bun/bun.lock — the
checkable equivalent is the Phase-1 manifest + import-direction guards, not an
installer switch; worktrees beside the repo vs fleet `.worktrees/<id>` — the
shared hoisted node_modules is deliberate lane startup and W870 binds claims
to in-repo trees; playwright-only tests vs fleet bun:test (~458 suites in
suspenders alone — no migration item); linear rebase-only history vs the
review-gated merge ladder (guardedMerge ff-only publish — revisit only on
owner word); the standard's `*.example.yaml` examples are superseded by
Amendment A (examples become `.example.json`; compose.yml stays — docker's
contract); one-repo-version via npm fixed-mode vs the stack pin (stays
config-level, becomes `stack.json` under Amendment A).

Verification item (ramp-safe, read-only): the standard cites fleet's own
`.prefer` faces — `packages/suspenders/examples/prefer.example`,
`scripts/lib/exec-chain.ts`, `hooks/lib/prefer.ts`,
`scripts/lib/prefer-routing.ts`. Diff the documented semantics (two planes,
`can=` override, `hub-url`, quoted-must reserved) against those parsers and
file the drift.

## Amendment D — agentic-work ergonomics (fifth sweep), adopted

Read-only audit of AGENTS.md quality, gate deny-messages, lane lifecycle,
test harnesses and knowledge discoverability. Verdict: agent-native; the
weaknesses are drift and discoverability. Items (all lane-safe):

- De-drift root AGENTS.md: delete the duplicated W892 supervisor-reporting
  paragraph (:68-96, diverging column sets), add decant + telemetry to the
  package list (:3-7), normalize the mixed cwd conventions, refresh
  belt/AGENTS.md "poll your inbox" to the W303 WS-first contract.
- Gate table in suspenders/AGENTS.md: one block per deny (read-gate, anchor,
  mutation-size, coordinator-edit-gate, claim-location) with its env knob and
  sanctioned path — today these exist only inside deny strings. Reconcile the
  brief's "≤25-line anchored edits" with the gate cap of 40; fix files.ts:193
  pointing at the retired CLAUDE.md stub.
- Done-gate contract into the lane brief: W833 claim-check ("test-pass
  claims require a passing own run") and the W643 token discipline are
  enforced at `work done` but documented nowhere a lane reads first — three
  lines in brief.ts's landing chain.
- Merge or kill the orphaned fixture kits: W1135.1.2's gate kit and W1216's
  work-completion-fixtures live only on branches while 294 suites hand-roll
  mkdtemp and 205 hand-roll spawnSync — land them, then one AGENTS.md line:
  new tests import `test/helpers/*`, never hand-roll bootstrap.
- Pre-flight knowledge hook: one brief line invoking read_knowledge /
  `coord fact get lesson.*` for the mission's package before planning — the
  MCP and the lesson discipline exist; only the trigger is missing.

## Resulting sequencing (C83-compliant)

1. NOW (ramp-safe): Phase 0 hygiene; import-direction lint guard + entry-point
   map item; reconcile the two diverged runtime-home twins (spawner,
   litellm-target) to the pinned artifact face; Amendment D de-drift/doc
   items and a read-only .prefer spec-vs-parser verification ride this tier.
   (Re-reconciled after the sd bulk-delete — this extends the surviving NOW
   tier with the Amendment D work so the ladder matches the amendments.)
2. NEXT (bounded window after sustained-40): JSON config migration
   (stack/policy/upstreams) on the atomic-0600 kernel + read-both/write-json
   transition; kernel primitives (exec, atomic0600, env guards, byte-twins);
   sync-harness computed closure; legacyLabels drift test.
3. THEN: hooks/lib giant splits + scripts/-independence; setup
   single-sources.
4. DEFERRED: package split (re-decide post-measurement); artifact-activation
   rollout per the gateway seam precedent.

## Appendix — Amendment C verification: .prefer spec-vs-parser (W1252, 2026-10-24)

Read-only diff of the standard's `.prefer` semantics (Harness lock-down,
`docs/paas-engineering-standard-2026-10-23.md:312-351`) against the four
fleet faces. The four named semantics — two planes, `can=` override,
`hub-url`, quoted-must reserved — all MATCH the parsers; the drift sits in
resolution scope and key vocabulary. No parser was touched (ramp-safe).

Verified matches (standard → code):

- Two planes by value shape: quoted/space values skip the chain
  (exec-chain.ts:110); unquoted single tokens skip routing
  (prefer-routing.ts:79) and tree prefer/must (prefer.ts:99-104).
- Chain position law: later lines win, head = the last directive, comma
  lists try left first (exec-chain.ts:113-119, 200-216 — stable sort by
  descending line; attempt 0 rides the last line).
- `must=` owner intent: allow-list and quota collisions surface a NOTE
  and the directive wins — never silently rerouted (exec-chain.ts:296-306).
- `can=` override: a doable can= joins the chain at its line and drops
  the must= lines; unavailable, it vanishes and must stands unchanged
  (exec-chain.ts:120-121, 200-216, 223-235 — sync doability probes).
- `hub-url=` tried first: hub-locate order is hub-url → stack.yaml →
  hubs.json → mDNS → null, and null degrades to local belt
  (hub-locate.ts:10-13, 122).
- Quoted `must=` reserved: W96-validated, surfaced, never enforced
  (prefer-routing.ts:26, 151-153).
- tag/color + the upward walk crossing repo boundaries, nearest
  definition wins per key, first definition per file wins
  (prefer.ts:140-166).

Drift filed:

1. **The upward walk is tree-plane only.** The standard states resolution
   walks upward generally and its example puts the executor chain at the
   tree root; fleet's chain parser reads ONLY `<repo>/.prefer` — the
   dispatching checkout (`--repo` ?? gitToplevel), no walk
   (exec-chain.ts:97, dispatch-next.ts:247). A tree-root `.prefer` pins
   tag/color/routing for everything below but ZERO executor directives:
   the standard's canonical example is inert on fleet as written.
   prefer.example's "dotfiles-win: the nearest .prefer wins" (:2-3)
   overstates — with no walk there is no nearest; exactly one file is
   read.
2. **The tree parser rejects the chain-only keys.** prefer.ts
   PREFER_KEYS is tag/color/prefer/must, so documented
   `can=`/`hub=`/`hub-url=` lines produce loud "unknown key" errors
   (prefer.ts:88-93) instead of being skipped as the executor plane's
   lines — routing skips them by shape (prefer-routing.ts:79), the tree
   parser only carves out unquoted prefer=/must= (prefer.ts:99-104).
   Muted today: current consumers drop `.errors` (board data.ts:76-103,
   work.ts:391), so the noise is latent for the first error-surfacing
   consumer.

Noted, not drift: `can=` takes a single token — a comma value probes into
silent unavailability — so the standard's chain-row "comma lists try left
first" reads chain-wide but only must=/prefer= split commas.
