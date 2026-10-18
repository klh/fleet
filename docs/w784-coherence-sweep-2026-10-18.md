# W784 — full-stack coherence sweep (2026-10-18)

Read-only review lane (retry of W781). Scope: GUIs, API surfaces, P2P,
LLM signalling, finetuning. Evidence-first; no code edits — findings are
work-add'd follow-ups + `finding.w784*` facts. Live surfaces probed from
this lane: board :7799, belt dashboard :7791, klh-local bar :7792, Mac
store :7794 (all answered; probes noted inline).

## Verdict: PASS with 5 follow-ups

No cross-layer law violation found. GUI law, the WS push contract, the
retry cap, and every named port ladder check out against code and against
the live services. The gaps below are ownership/doc drift, not breaks.

## Coherent (verified)

- **GUI law**: zero `innerHTML`/`document.write` in app code — only hits
  are vendored Lit internals, the enforcing gate
  (`hooks/gates/files.ts:61-75`) and its test (`test/theme.test.ts:306`).
  Lit is vendored in all three UI homes (board-html, belt, local); no CDN
  imports anywhere. 14 Lit components in `hooks/board-html/`; `unsafe*`
  directives only ever receive static first-party content (icon table,
  const CSS).
- **Board API**: `POST /api/prompt/settings` + `POST
  /api/orchestrate/preview` exist as documented (`board/routes-orch.ts:31`,
  `:57`); write endpoints go through the write token
  (`bin/fleet-board.ts:20,154`); default bind loopback
  (`board/context.ts:50`). `/api/tasks` takes `?project=` and keys
  decisions/attribution on `project:id` (`board/data.ts:150-187`) — the
  cross-project id collision has an API-level answer.
- **P2P / coord WS**: the store's WS open hook only registers the socket
  and fan-out broadcasts NEW rows per-socket filter — no replay at open
  (`bin/store-server.ts:164-189,494-496`). The push gate tails by byte
  offset, complete lines only (`hooks/gates/push.ts:37-76`); subscribe
  prints real event ids (`coord/bus.ts:271-278`) and carries the W494
  staleness exit (`coord/bus.ts:371-383`). The replay-loop bug is
  structurally fixed; reconnect catch-up is the `coord inbox` contract.
- **Federation**: minimal five-field work wire, per-edge last-known,
  degradation without throw, optional edge token
  (`hooks/lib/federation-work.ts:1-66`).
- **LLM signalling**: retry-after provider floor is capped
  (`buckle/src/cooldown.ts:16-33` — W695.6.1 landed; quota walls relay).
  Router :4000 (`belt/bin/router-shim.ts:285`), litellm :4100
  (`belt/bin/litellm-target.ts:22`), buckle spoke :4101 / hubs :4101
  (NAS, live-probed up) / :4111 (desktop, starting) — all consistent
  across AGENTS.md, code defaults, and the live belt llms.txt. Oracle
  pinned :8903 with config-over-code overrides; escalation leg is
  machine-config (`BELT_ESCALATE_*`, glm-5.3 pins documented,
  `belt/bin/escalate.ts:122`). Copilot ladder template correct
  (`buckle/upstreams.copilot.yaml` — dots-to-dashes as data, key by env
  name, never active by default).
- **llms.txt faces**: all three served faces answer live and are current
  (board :7799, belt :7791, bar :7792 — the bar's footer is already
  post-cutover).
- **Finetuning: none exists.** No finetuning infrastructure in the fleet;
  models are stock MLX-community weights. `belt/bin/distill.ts` drives an
  external LoRA dataset/fine-tune job (test-asserted), and the buckled
  LiteLLM provider docs mention upstream fine-tune endpoints — neither is
  fleet finetuning.

## Findings (work-add'd follow-ups)

1. **HIGH — bar :7792 ownership gap.** `com.klh-local.dashboard` is on
   the `legacyLabels` boot-out list (`deploy/services.yaml:260`;
   `scripts/install-launchd.ts:297-310` bootouts + rms on every install)
   and NO unit in the W779 manifest serves :7792 — yet the bar is live
   now and documented live in `packages/local` AGENTS.md/README/install.sh
   and by its own served llms.txt; the board's `/console/local` reads its
   registry. One install run darks `bar.local`. Re-own the bar in
   services.yaml or retire the surface; owner call.
2. **MED — board llms.txt companion links predate the cutover.**
   `board/routes-meta.ts:73-75` serves `github.com/klh/{suspenders,belt,
   local}` — all archived/push-dead since the 2026-10-05 monorepo cutover
   — while the console strip in the same board already points at
   `klh/fleet/packages/*` (`hooks/lib/theme.ts:183-195`).
3. **LOW — litellm template header drift.** `belt/bin/litellm-config.yaml:1-5`
   says `--port 4000` and maps every model group to a Qwen3-4B placeholder;
   the real engine is `LITELLM_PORT = 4100` (`belt/bin/litellm-target.ts:22`).
4. **LOW — AGENTS.md store map omits the Mac-local store.** Root
   AGENTS.md:204 lists store :7795 (NAS) / :7796 (desktop) but not
   :7794, the Mac governor store (documented in the store-server plist
   and `hooks/lib/auth-server.ts:2`; live-probed healthy).
5. **LOW — com.belt.gateway unload is prose-only.** Retired W277 ("a
   plist may linger… must stay UNLOADED", root AGENTS.md) but neither
   installer boots it out (`belt/install.sh:105-118` globs, services.yaml
   legacyLabels) — a lingering loaded plist would keep running retired
   code with nothing enforcing the unload.

Fleet board deep-link: `#task=W784`.
