# Fleet-wide hook installer (W298)

How suspenders detects which CLI/agent tools are installed on a machine and
offers to wire each one's dialect adapter (session registration + gate
enforcement) in one pass — instead of running each dialect's `wire.ts` by
hand.

## Origin: lifted from `vercel-labs/skills`

[`vercel-labs/skills`](https://github.com/vercel-labs/skills) (npm package
`skills`, MIT) solves the same class of problem for installing *skills*
across agent tools: detect what's on the machine, then prompt the user with
exactly the right set of choices depending on how many tools were found.

We lifted two things from it verbatim, by explicit instruction ("use the
exact same patterns"):

1. **The registry** — `src/agents.ts`, a `Record<AgentType, AgentConfig>` of
   70+ CLI/agent targets, each with a `detectInstalled(): Promise<boolean>`
   closure (almost all `existsSync(join(home, '.xxx'))`, a few with env-var
   overrides like `CODEX_HOME`/`GROK_HOME`/`HERMES_HOME`). Vendored byte-for-byte
   into `hooks/lib/vendor/skills-agents.ts` (`AgentType`/`AgentConfig` inlined
   from the separate `types.ts` we didn't copy). License copied to
   `hooks/lib/vendor/SKILLS-LICENSE`.
2. **The decision flow** — `src/add.ts`'s 0/1/2+ branching:
   - **0 detected** → full interactive multiselect across every known target.
   - **1 detected** (or `--yes`) → auto-select it, no prompt.
   - **2+ detected** → interactive multiselect, pre-populated with the
     detected set so the user can add/remove before confirming.

   We use `@clack/prompts`'s built-in `multiselect` rather than vendoring
   vercel's custom 701-line fuzzy-search readline component
   (`search-multiselect.ts`) — judged not essential to the core ask. If UX
   fidelity with the original ever matters, that component is the one to
   port next.

## Why vendor instead of `npm install skills` and import it

`skills`' public API is built around installing *skill* files into
`.agents/skills`/tool-specific skill directories — not wiring hook gates.
We only needed its **registry + detection + prompting shape**, not its
install mechanism, so vendoring the registry and writing our own thin
installer on top was more direct than depending on the package and fighting
its API surface.

## What's "supported" vs "gated"

The vendored registry is never trimmed — all 70+ entries stay, per explicit
instruction ("don't remove the 70+ others we might want to support later,
just gate it"). `hooks/lib/targets.ts` layers wiring metadata on top:

- **`supported: true`** — has a real dialect adapter under
  `hooks/dialects/<name>/wire.ts` (currently: `codex`, `github-copilot`,
  `grok`, `cline`), or is `claude-code` (native, no wiring needed — Claude
  Code *is* the gate's native format).
- **`supported: false`** — every other vendored target (zed, cursor,
  windsurf, hermes-agent, opencode, zcode, …). Still detected and listed;
  `fleet-install.ts` refuses to wire these with a clear
  `"<Name> has no hook adapter yet (gated) — cannot wire"` message pointing
  back to [`cli-dialect-pattern.md`](./cli-dialect-pattern.md) for how to add
  one.

### Capability states (W918)

`hooks/lib/targets.ts` exposes evidence-backed capability states for every
catalog target; `fleet-install.ts --capabilities` prints the live machine
read (exit 0, no prompt, CI-safe).

- `detected` — the vendored registry's skills-dir/env probe fired here.
  **Never runnable evidence on its own.**
- `skillInstallable` — true for every catalog row: the row IS the
  vercel-labs/skills CLI's own target list.
- `hookWired` — a suspenders hook adapter exists (native, or its wire.ts on
  disk). The CLI labels this `hook-adapter` to avoid implying that the agent
  settings are already registered.
- `hookRegistration` — a read-only `wire.ts --check` of the detected agent's
  settings: `present`, `missing`, `native`, or `unsupported`. `present` proves
  the registration exists, not that an idle client has consumed an inbox item.
- `headlessSpawnable` — a spawnable executor adapter is registered AND the
  binary probes live here. IDE-only targets stay `false` regardless of
  detection (honesty law).
- `sessionResumable` — verified fork/resume semantics (adapter forkArgs
  non-null).
- `buckleCompatible` — rides the governed Buckle front; `unknown` =
  unaudited (W914 coordination pending). Flips only per landed proof:
  `claude-code` (every dispatch lane) and `codex` (W918.2,
  `docs/w918.2-codex-executor-lane-proof.md` — token round-trip on
  `/w/<slug>/v1/responses` with a scoped `bksk_` key). `grok`/`cline` ship
  wire dialects but are not installed here and never lane-proven — their
  rows stay `buckle=unknown`, `spawn=false`.

## Usage

```bash
# Detect what's installed, prompt interactively for which to wire
bun hooks/bin/fleet-install.ts

# Wire specific targets non-interactively
bun hooks/bin/fleet-install.ts --agent codex,github-copilot

# Wire every supported+detected target, no prompt
bun hooks/bin/fleet-install.ts --yes
# or explicitly:
bun hooks/bin/fleet-install.ts --agent '*'

# Preview without touching any settings file
bun hooks/bin/fleet-install.ts --dry-run

# Print the evidence-backed capability catalog for this machine
bun hooks/bin/fleet-install.ts --capabilities
```

Exit codes mirror `skills`' own discipline: a genuine interactive cancel
exits `0`; requesting an unknown or gated target, or cancelling when stdin
isn't a TTY (can't prompt), exits `1` with an explanatory message — so CI/
non-interactive runs never silently report false success.

## Keeping the vendored registry in sync

`hooks/lib/vendor/skills-agents.ts` should stay byte-identical to upstream's
`src/agents.ts` (plus the inlined types and our attribution header) so future
re-syncs are a simple diff-and-replace. To refresh it:

1. `git clone https://github.com/vercel-labs/skills /tmp/skills-upstream`
2. Diff `/tmp/skills-upstream/src/agents.ts` (+ `src/types.ts`) against our
   vendored copy.
3. Re-apply our two intentional deltas: the attribution header comment, and
   inlining `AgentType`/`AgentConfig` (upstream splits them into
   `types.ts`, which we don't vendor separately).
4. Re-run `bun test test/fleet-targets.test.ts test/fleet-install.test.ts`
   to confirm `listTargets()`/`detectFleetTargets()` still see every new
   entry correctly (new entries default to `supported: false` automatically
   — nothing else needs updating unless a new entry should also get a real
   dialect adapter).

## Known environment-dependent detection quirk

A few vendored `detectInstalled()` closures (e.g. `isZCodeInstalled`) check
an absolute, non-`$HOME`-relative path like `/Applications/ZCode.app` as a
fallback. This is correct upstream behavior (it really does detect a
system-wide install), but it means a "detect with an empty/fake `$HOME`"
test can still see `installed: true` for those entries on a machine that
happens to have that app installed. Our own tests scope "nothing installed"
assertions to `supported` targets only, since those are the only ones whose
detection we rely on for wiring decisions.

## Buckle route configuration (--buckle-route)

W1265 adds a route-config axis ATOP the same detection: each detected tool
gets its inference base pointed at a Buckle named base, so requests ride the
gateway (and the /w/<lane> attribution prefix when --buckle-lane is given).
Detection is unchanged — this mode only maps catalog AgentTypes to the native
config face each tool reads its base URL from.

    bun hooks/bin/fleet-install.ts --buckle-route \
      --buckle-front http://<buckle-host>:4101 \
      [--buckle-lane <lane-slug>] [--buckle-provider zai] [--yes]

Without --yes (or with --dry-run) the mode prints the plan table and writes
nothing:

    TOOL          CONFIG FILE              BASE URL                               WIRE       PROVIDER  MODEL    DISABLE ACTION
    claude-code   ~/.claude/settings.json  http://host:4101/w/lane/zai/anthropic  anthropic  zai       glm-5.3  remove env.ANTHROPIC_BASE_URL
    codex         ~/.codex/config.toml     http://host:4101/w/lane/zai/openai/v1  openai     zai       glm-5.3  remove [model_providers.buckle] + model_provider
    grok          ~/.grok/config.toml      http://host:4101/w/lane/zai/openai     openai     zai       glm-5.3  hand-revert .grok/config.toml [model.*] base_url + api_backend

The mapping (hooks/lib/hub/buckle-route.ts):

- **claude-code — settings-json**: merges env.ANTHROPIC_BASE_URL into
  ~/.claude/settings.json. The client appends /v1/messages, so the base ends
  at the wire name. Auth stays manual: set ANTHROPIC_AUTH_TOKEN to a buckle
  key minted via the admin API — the installer never writes tokens.
- **codex — codex-toml**: splices a [model_providers.buckle] section
  (base_url ending /v1, wire_api = "responses") into the USER-LEVEL
  ~/.codex/config.toml and sets top-level model_provider = "buckle".
  Project-level .codex/config.toml CANNOT set the provider (Codex ignores
  model_provider/model_providers there — owner-verified 2026-10-24), so only
  the user file is written. A conflicting existing model_provider refuses
  instead of being stomped.
- **grok — manual**: documented face only ([model.*] base_url + api_backend
  in ~/.grok/config.toml); no automated write today.
- **everything else — none**: gated rows, same honesty as hook wiring.

VS Code has NO key in the vendored registry, so there is no row for it here;
its face is the chatLanguageModels.json Custom Endpoint (per-model full URL,
apiKey/requestHeaders, set statefulResponses=false for a stateless gateway) —
configure it by hand against the same named base. Tools absent from
BUCKLE_ROUTES never get a write; the Buckle-compatibility capability stays a
DISTINCT axis from detected/skill-installable/hook-wired (W298 honesty law).

Named-base ingress contract (buckle side): /{w/<lane>/}[<provider>/]anthropic
and .../openai accept only their own wire paths (wrong wire = 404
buckle.wire_mismatch, wrong method = 405, both local with zero outbound);
--buckle-provider zai pins candidates to the zai adapter (Z.ai Coding Plan)
and refuses cross-dialect bridging with a typed 503. Legacy bare /v1 paths
are preserved. NOTE: the /w/<lane> prefix is lane ATTRIBUTION telemetry —
authenticated repo-identity/tier enforcement is W1265.1.
