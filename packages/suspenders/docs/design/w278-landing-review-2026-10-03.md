# W278 — best-approach review of the 2026-10-03 landings

Reviewed at **suspenders main `f0df5f9`** (W269 theme, W270 prompt-transform,
W273 recovery UX) and **belt main `7c61d81`** (W270 router fixes + ping
exemption + push SSE relay, W271 registry source, W272 supervision). Belt was
read from GitHub at `7c61d81` (no local checkout access from this lane).
I'm judging the approaches here, not style. Each finding has a confidence
level. Nothing in the code changed; this file is the only deliverable.

> Correction 2026-10-05 (W422.4): the suspenders local-llm kit moved from
> `packages/suspenders/hooks/local-llm/` to `packages/local-llm/`; path
> mentions below are updated to the current location. The review's
> recommendation to replace the kit with belt's is unchanged and still
> pending an owner call.

---

## 0. Headline: what to fix first

1. **The two repos run two different swarm supervisors for the same ports, and
   they install to the same path.** suspenders ships its own fork of belt's
   local-llm kit. `packages/local-llm/swarm.ts` (`serve`, W158) is installed to
   `~/.claude/local-llm/swarm.ts` and run by `com.suspenders.local-llm`.
   belt W272 installs its own `swarm.ts` (`supervise`) to **the same path**, run
   by `com.belt.swarm`. Neither file has the other's verb (suspenders
   `swarm.ts:280-308`: start|serve|…; belt `swarm.ts`: …|supervise). Whichever
   installer ran last owns the file. The other launchd agent then prints usage,
   exits 0, and KeepAlive respawns it in a throttled loop. On top of that, W273's
   recovery map tells the user to `kickstart com.suspenders.local-llm` and to tail
   `swarm-serve-launchd.log` (`recovery-map.ts:61-63`). That's wrong whenever
   belt's supervisor is the live one. The suspenders router-shim copy
   (`packages/local-llm/router-shim.ts`, 718 lines, no `router-core.ts`) also lacks
   **all** of belt's W270 fixes. *(Confidence: high on the code. The live install
   order on the host is unverified.)*
2. **belt's push SSE relay can probably crash the router when a client
   disconnects.** In `router-core.ts:608-645`, `cancel()` calls
   `reader.cancel()`. The pending `read()` then resolves `done`, and the pump
   calls `c.enqueue()` on a cancelled stream (`:614`). That throws, the `catch`
   calls `c.enqueue()` again, and the second throw escapes the `void (async…)`
   as an unhandled rejection. Under Bun's default unhandled-rejection mode, that
   probably takes the :4000 shim down on every client abort (an Esc in claude
   CLI). The new supervisor then respawns it and drops every other in-flight
   stream. The pump also ignores `desiredSize`, so there's no backpressure,
   which breaks `law.streams-over-buffers`. *(High on the code path. Verify with
   a disconnect test.)*
3. **The `AbortSignal.timeout(120_000)` on the upstream fetch also covers the
   streamed body** (`router-core.ts:412`). Any generation longer than 120 s is
   cut mid-stream as "upstream stream broke". `idleTimeout: 0` on the serve side
   shows long streams were meant to work. *(High.)*
4. **Prompt condense is ON by default and changes meaning.** I ran
   `condensePrompt` against main:
   - "Maybe add a retry, but just for the 429 case." → "add a retry, but for the
     429 case." The optional step becomes mandatory and the "only" scoping is
     lost.
   - "Could you please make sure that the kind of error is logged?" → "ensure
     the error is logged?"

   The hedge list (`prompt-transform.ts:66`: `just|maybe|perhaps|really|quite…`)
   treats words that carry meaning as filler. The default is at `:18`.
   *(High: reproduced.)*
5. **The registry is not yet the one source.** On the same day:
   - W270 hand-wrote `direct:` as `alias: url` strings (`routing-policy.yaml:44-47`).
   - W271's emitter produces `direct:` as objects (`registry-emit.ts:62-82`).
   - `parseDirect` throws on non-strings (`router-policy.ts:97`).

   So the emitted artifact can't be dropped into the policy file. Separately,
   suspenders hard-codes ports in `recovery-map.ts:143-145` (8901-8903, 8912).
   That list has already drifted: the resident **:8913 reranker** in belt's
   registry has no probe or recovery entry. *(High.)*

---

## 1. Findings per area

### suspenders W269: theme (`hooks/lib/theme.ts`, `docs/theme-tokens.md`)

**Verdict: the approach is right.** Semantic `--klh-*` role tokens swap on
`data-theme`. The pre-paint script runs in `<head>`, so there's no flash. The
system preference is tracked live (`theme.ts:79-81`), tabs sync via the
`storage` event, and the settings panel is a native `<details>`. Custom
properties pierce shadow DOM, so the Lit components inherit the tokens for free.
This is the right primitive.

- **Distribution is wrong: "copy verbatim" is lock-in by fork** (`theme.ts:3`,
  `:91`). Today's other finding (the forked local-llm kit) shows what happens to
  copies: they drift. belt's dashboard already has a parallel dark-only palette
  (`dashboard.ts:259-261`: `--ground/--panel/--text/--rust`) and hard-coded
  topbar colours (`:331-333`).
  - **Do instead:** make `theme.ts` a dependency, not a copy. It's pure and has
    no imports. Ship it as a tiny `klh-tokens` module that belt and klh-local
    import (belt already set this pattern up in
    `6158576 package.json: expose belt as a git-dependency package`). Or serve
    it at a stable LAN URL that Caddy fronts (`/klh/theme.css` + `/klh/theme.js`).
    The package form wins: it works offline, is versioned, and adds no runtime
    coupling.
- **Token scope is narrower than the doctrine.** CLAUDE.md says "tokens own the
  styling (surface/ink/**spacing/type** + plane hues)". `TOKENS` is colour only.
  Font stacks, sizes and radii are still literals in every CSS string
  (`THEME_SETTINGS_CSS`, `console-html.ts` `PILL_CSS:197`). Not urgent, but it's
  the next step before belt adopts the tokens, so belt gets the whole system
  once.
- **Lit components duplicate the dark palette as `var()` fallbacks**
  (`klh-service-row.ts:30-31`: `var(--klh-surface, #1c1b19)`). Every page that
  mounts them already sets `THEME_HEAD`, so the fallbacks only matter when
  tokens are missing. In that case they silently render dark on a light page.
  Drop them, or source them from `TOKENS`.
- **Settings split is correct, but should be stated:** theme lives in
  localStorage (per device) and `prompt.*` lives in `suspenders-board.json`
  (fleet behaviour). Keep both. Document the rule: viewer preferences go
  client-side, behaviour goes server-side. `prompt.debug` and `prompt.log`
  break the rule (next section).

### suspenders W270: orchestrate preview (`hooks/board/prompt-transform.ts`)

**Verdict: the preview, disclosure and held-plan handoff are right. The
condenser and enhance target need rethinking.**

Good: the pipeline is pure with injected deps, so tests can drive every branch.
The disclosure lists the system prompt, header and repo context with byte
counts. Secrets are redacted only in the view. The **one-shot held plan**
(`:340-380`) means "dispatch" sends exactly what was previewed, and the browser
never gets the unredacted text back. The store is bounded (32 entries), has a
TTL, and when the id is lost it recomputes instead of trapping the user. That's
a good design.

- **The condenser is a regex rewriter of human intent, on by default** (finding
  0.4). The byte win is tiny: the goal is capped at `ORCH.GOAL_MAX`, while
  `ORCH_SYS` plus the repo context dominate the wire (the preview's own
  `wireBytes` shows this). The risk is silent changes in meaning on the one
  input a human wrote.
  - **Do instead:** make it default OFF. Restrict it to pure pleasantries
    (greetings, thanks, "please", "could you", "go ahead and") plus whitespace
    and dedupe. Never touch hedges, quantifiers or scope words ("just", "maybe",
    "only", "very", "quite", "kind of"). If token savings matter, cut the 95 %
    side: repo context.
- **The enhance target is the complexity router, so the "model" is fictional.**
  `ENHANCE_URL` defaults to `:4000/v1/messages` (`prompt-transform.ts:133`). The
  shim ignores `body.model` and routes by its own complexity score
  (`router-shim.ts:426-433`). With `allow_cloud` set it can **escalate to
  z.ai** (`:660-686`), so an "enhance (local LLM)" toggle can send the
  unredacted goal off-box. `enhanceModel()` (`orch.ts:139-148`) reads
  suspenders' own parse of belt's policy and falls back to `"glm-5.3-flash"`,
  a cloud model id. Telemetry then records the wrong model.
  - **Do instead:** call a belt **direct tier** by registry alias (for example
    `local-extract` or `local-reason` via `resolveTarget()` /
    `direct-tiers.json`). That makes it deterministic, local-only and
    1.35-3.9× faster per belt's own bench. Record the alias that actually
    served the call.
- **Two key lists for one schema:** `PROMPT_DEFAULTS` / `PROMPT_KEYS`
  (`prompt-transform.ts:17-26`) and `PROMPT_SETTING_KEYS`
  (`board-config.ts:325`). This is a drift hazard. Derive one from the other.
- **`prompt.debug` and `prompt.log` are viewer preferences stored as fleet
  config.** One browser turning on "log all stages" changes the
  `/api/orchestrate` response shape for every caller (`routes-orch.ts`
  `wantsPreview`). Move them to localStorage next to the theme. Keep only
  `condense` and `enhance` server-side.
- The held plan is per-process memory. That's fine: the board is a single
  process, and a restart degrades to recompute. Keep it.

### suspenders W273: recovery UX (`recovery-map.ts`, `service-probe.ts`, `klh-service-row.ts`)

**Verdict: keep the "recovery as DATA" approach and the progressive-enhancement
UI. Replace the hard-coded inventory.**

Good: one keyed entry per service with plain-language what/causes/commands.
There's a placeholder law with a test (`leaksIn`). Rows are server-rendered and
then upgraded by Lit (`console-html.ts:185-195`), so the page works without JS.
The up/degraded/down classification is honest.

- **The inventory and supervisor facts are a third copy of belt's truth.**
  Ports, launchd labels, health paths and log paths are all literals. belt now
  publishes:
  - `/registry.json` (W271, which says "spokes pull it")
  - `/api/supervisor` (W272): the authoritative restart counts, breaker state
    (`unhealthy: circuit open …`) and `nextRetryAt`.

  W273 can't show "belt's breaker gave up after 6 restarts". It only shows
  DOWN, and then recommends a kickstart of what may be the wrong agent
  (finding 0.1). Drift has already happened (no :8913).
  - **Do instead:** derive the probe list from `/registry.json`, merging
    `/api/supervisor` state when it's reachable. Keep the recovery *prose*
    keyed by **kind** (`specialist | router | gateway | external | launchd`),
    not by port. Keep the current static map only as the fallback when belt
    itself is dark. That's exactly when it's needed, so it must stay.
- **`up` means "any status below 500"** (`service-probe.ts:110`). So a foreign
  process answering 404 on :4000 counts as healthy. belt's supervisor makes the
  same "any HTTP reply" call. It's acceptable for liveness, but the row should
  say "answering" rather than "up" unless the health path returns 2xx.
- **Each open tab with a dark row polls every 15 s** (`klh-service-row.ts:16`),
  and launchd rows spawn `launchctl` per probe. That's fine at today's scale.
  Once belt's status is merged in, poll `/api/services` once per page, not once
  per row.
- **Build hygiene (W269/W270/W273 UI):**
  - Both vendored bundles ship Lit in **dev mode** (each contains "Lit is in dev
    mode"), so they were built without the `production` export condition.
  - `klh-service-row.js` is a second bundle that inlines a second copy of Lit.
  - Nothing in `package.json` builds them, so the source and the artifact can
    drift unnoticed.
  - **Do instead:** add one `build:vendor` script (`--conditions=production
    --minify`), produce a single shared bundle, and add a test that checks the
    artifact matches the source hash.
  - Separately: `console-html.ts:117` still has an `innerHTML` (W147,
    pre-existing, outside today's scope). It breaks the UI law in a file that
    was touched today.

### belt W270: router fixes (`router-core.ts`, `router-shim.ts`, `router-policy.ts`)

**Verdict: extracting `router-core` and making budget policy data-driven is
right. The streaming relay needs a fix (0.2, 0.3). The direct bypass undercuts
the fixes it ships with.**

Good:
- Strong vs weak code signals with a long-prompt cutoff (`:23-75`).
- A short system prompt is classified, while a long harness prompt is not
  (`:154-160`).
- The budget rules table (`:206-245`) is data, not branches.
- The ping exemption (`<64`, `7afcb16`) is the right rule: explicit tiny
  budgets are probes.
- `callHonoringRetryAfter` is bounded and retries the same specialist (warm
  cache), then falls back. Propagating a 429 with the longest Retry-After
  (`router-shim.ts:689-703`) is correct backpressure to the gateway ladder.

Risks:
- **The direct-tier bypass skips the router's own policy.** A client that calls
  `resolveTarget("local-reason")` hits :8903 (Qwen3.5-35B) directly and misses:
  - the `enable_thinking:false` kwarg (`BUDGET_RULES`), so it runs with
    thinking ON and slow
  - admission control
  - `/no_think`
  - routing logs

  The bypass is justified (LiteLLM hop measured at 1.35-3.9×), but it should
  bypass **LiteLLM**, not **belt policy**.
  - **Do instead:** make `applyBudget` plus a `toOpenAi` shaping helper a
    client-side library that `resolveTarget()` callers use. Or point direct
    tiers at the shim with a `model: "local-reason"` pin, so it skips scoring
    but keeps policy.
- **`/no_think` is appended to every system prompt for every model**
  (`router-core.ts:177`), including the Claude-Code harness prompt. It's a
  Qwen3 template hack. Apply it through `BUDGET_RULES` the way `offExtra`
  already works.
- **Exposure.** `Bun.serve({ port })` sets no `hostname` (`router-shim.ts:369`),
  so it binds on all interfaces. On the LAN, :4000 offers free model access,
  cloud escalation with the owner's z.ai credentials when `allow_cloud` is set,
  `/registry.json`, and the `_force_dead_port` self-test hook (`:557-566`).
  That hook makes the shim POST to any local port the caller names. suspenders
  did this hardening in W264. belt should match it: loopback by default, with
  hub mode opt-in plus a token, and the self-test hook gated behind an env var.
  *(Medium. Mostly pre-existing, but W271 widened the surface.)*
- **Tool use is invisible to the shim.** `blockText` keeps only `.text`
  (`router-core.ts:139-150`), so `tool_use` / `tool_result` blocks vanish. The
  recovery map describes :4000 as the endpoint "claude CLI lanes" use
  (`recovery-map.ts:88`). Any agentic lane routed there runs blind. That's a
  scope fact, not today's regression. Either document that :4000 is chat-only
  or reject requests that carry tools with a clear 400.

### belt W271: registry source (`registry.ts`, `registry-emit.ts`, `/registry.json`)

**Verdict: right direction.** One registry, emitters that are hash-stable (no
timestamps, sorted rows, so a diff is a real change), a strong ETag with 304s,
and no secrets in the output. This is the best idea landed today, and other
areas should rebase onto it.

- **It isn't the one source yet** (finding 0.5): `routing-policy.yaml direct:`
  is hand-written, and its shape is incompatible with the emitted one. Make
  `direct:` emitted-only (or delete it and have `loadDirectTiers()` read the
  registry), and have `parseDirect` accept the emitted object shape.
- **The registry is served by the process most likely to be dead** (the :4000
  shim). It's compiled-in TS, so `/registry.json` shows what the shim loaded at
  start, not what is on disk. Serve it from the belt dashboard (or a static
  file the emitter writes) as well, so consumers like W273 can still read the
  inventory when the router is down. That's precisely when they need it.
- **Missing operational fields** before suspenders can consume it as described
  above: `healthPath`, launchd label / owner (`belt-supervisor` vs `external`),
  and log path. Add them to `RegistryEntry` and suspenders' recovery map can
  drop its literals.

### belt W272: supervision (`supervisor.ts`, `liveness.ts`, `swarm.ts supervise`)

**Verdict: the engine is good.** It runs one async loop per port (a 90 s model
load never blocks healing :4000), uses exponential backoff with a sliding-window
breaker, re-probes before restarting ("healed by someone else"), counts
TCP-bind as success rather than a live pid, and writes atomic status JSON plus
a transition log. Making `liveness` report-only ("two restarters = fork-bomb")
is the right call. It has to hold **across repos** too (finding 0.1).

- **Adopting live children across a supervisor restart doesn't hold under
  launchd.** `com.belt.swarm.plist` has no `AbandonProcessGroup`. Children are
  `Bun.spawn`ed in the supervisor's process group, so when launchd stops or
  restarts the job (KeepAlive after a crash, `kickstart -k`), it kills the whole
  group: about 41 GB of weights reload. The SIGTERM handler that "leaves
  children running" (`swarm.ts:143`) doesn't stop that. suspenders' W158 plist
  makes the same claim and has the same gap.
  - **Do instead:** set `<key>AbandonProcessGroup</key><true/>`, or spawn with
    `detached`/`setsid`. *(High.)*
- **The single-instance lock is a PID inside the status file**
  (`supervisor.ts:247-252`). That allows a check-then-act race between two
  starts and false positives from PID reuse. Use an `O_EXCL` lockfile or
  `flock`. Better, rely on launchd as the only launcher and have `supervise`
  refuse to run when it isn't under launchd.
- **`killPortPids` SIGKILLs whatever holds the port** (`:216-225`), with no
  check that the holder is ours. For the hung-router case that's intended. For
  a user process that happens to sit on :4000, it's hostile. Check the command
  line of the pid (via `lsof -Fc`) against the expected argv before killing,
  and otherwise go `unhealthy` with "port held by foreign <cmd>".

---

## 2. Best-approach resume (one direction per area)

| Area | Direction | Why |
|---|---|---|
| **suspenders local-llm kit** (`packages/local-llm/*`, `com.suspenders.local-llm`) | **Replace with belt.** Delete the fork. `install.sh` installs belt's kit and its single `com.belt.swarm supervise` agent, and boots out `com.suspenders.local-llm`. | Two supervisors sharing one install path is the worst risk landed today. belt owns models (`klh/belt` = LLM fleet). |
| **W269 theme** | **Keep, then evolve into a shared `klh-tokens` module** (theme.ts as-is plus spacing/type tokens), imported by belt and klh-local. No copy-verbatim. | The primitive is right. Copies drift (see the kit fork). |
| **W270 prompt transforms** | **Keep preview, disclosure and held plan. Evolve the condenser** to default OFF and politeness-only. **Repoint enhance** at a belt direct tier by registry alias. Move debug/log to client prefs. | Removes silent semantic edits and possible off-box leaks, and makes the model id honest. |
| **W273 recovery UX** | **Keep the data-driven rows and the Lit UI. Evolve the inventory** to come from belt `/registry.json` plus `/api/supervisor`, with prose keyed by kind and the static map only as a belt-dark fallback. | A third copy of the inventory has already drifted (:8913), and it can't see breaker state. |
| **belt router (W270)** | **Keep router-core and the policy tables. Fix the relay:** guard `enqueue` after cancel, honour `desiredSize` (or Bun `type:"direct"` + `await flush()`), and use a connect/TTFB timeout instead of a whole-stream timeout. **Fix the bypass** so it skips LiteLLM, not belt policy. **Bind loopback.** | Probable crash on client abort, a 120 s cap on streams, and policy lost on the fast path. |
| **belt registry (W271)** | **Keep it as THE source.** Make `direct:` emitted-only. Add health/label/log/owner fields. Also serve it from a process that isn't the router. | Every other area today hard-codes what the registry should own. |
| **belt supervision (W272)** | **Keep the engine.** Add `AbandonProcessGroup`, an `O_EXCL`/flock lock, and an owner check before kill. Make it the **only** restarter on the host. | Without these, the adopt-on-restart and single-restarter guarantees don't hold. |

---

## 3. Same problem, two solutions: pick a winner

| Problem | suspenders | belt | Winner |
|---|---|---|---|
| **Theme tokens** | `--klh-*` semantic roles, dark+light, pre-paint, tested (`test/theme.test.ts`) | `--ground/--panel/--text/--rust`, dark only, plus hard-coded topbar hexes (`dashboard.ts:259-333`) | **suspenders `--klh-*`.** belt adopts it through the shared module and maps its 6 vars onto the roles (`--ground→--klh-bg`, `--panel→--klh-panel`, `--text→--klh-ink`, `--mut→--klh-dim`, `--rust→--klh-accent`/`--klh-danger`, `--ok→--klh-ok`). |
| **Service health / recovery surface** | `/api/services` with fresh probes and human recovery steps; Lit rows, copyable commands, re-probe | `/api/supervisor` (status JSON from the actual restarter: restarts, breaker, nextRetryAt) and `watchdog liveness` CLI | **Split by ownership:** belt **owns the facts** (registry and supervisor status are authoritative because belt is the restarter). suspenders **owns the presentation and the recovery prose.** The board consumes belt and falls back to its own probe only when belt is dark. Neither repo should keep its own port list. |
| **Swarm supervisor** | `swarm.ts serve` (W158: serial loop, fixed 15 s, no breaker, no status file) | `swarm.ts supervise` (W272: per-port loops, breaker, status file, transition log) | **belt W272**, clearly. Retire the suspenders fork (§2 row 1). |
| **Router shim** | Frozen fork `packages/local-llm/router-shim.ts` (pre-W270) | `router-shim.ts` + `router-core.ts` (W270 fixes) | **belt.** Same action as above. |
| **Policy parsing** | `board-config.ts` re-parses belt's `routing-policy.yaml` (`enhanceModel` reads `fallbacks` head) | `router-policy.ts` `parsePolicy`/`loadDirectTiers` | **belt.** suspenders should read belt's emitted `direct-tiers.json` / `registry.json` instead of re-parsing YAML whose schema belt changes. |

---

## 4. Ordered fix list for the orchestrator

1. **Retire the suspenders local-llm fork:** install belt's kit and use one
   supervisor agent. Then update the recovery map labels and log paths to
   `com.belt.swarm` / `belt-supervisor.log` / `mlx-swarm.log`.
2. **belt relay:** guard against cancellation, add backpressure, and change the
   timeout to cover connect/TTFB only. Add a test that disconnects a client
   mid-stream.
3. **belt plist:** add `AbandonProcessGroup`, and do the same in any suspenders
   plist that survives step 1.
4. **Condense:** default OFF and a politeness-only rule set. Add a regression
   test with the "maybe … just for" cases above.
5. **Enhance:** point it at a direct tier by alias and record the real model.
6. **Registry:** make `direct:` emitted-only, add operational fields, and serve
   `/registry.json` from the dashboard too. Then W273 consumes it (adding :8913
   along the way).
7. **belt shim:** bind loopback by default and env-gate `_force_dead_port`.
8. **Shared `klh-tokens` module:** belt's dashboard adopts the `--klh-*` roles.
9. **Vendor build script** (production Lit, one bundle) plus a test that the
   artifact matches the source.
