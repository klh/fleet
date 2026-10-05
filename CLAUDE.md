# fleet — the klh agent stack

One monorepo, one version, every service. packages/: suspenders (control
plane), buckle (LLM gateway), belt (dashboard/gateway), speedy (config
layer), local (Caddy front), local-llm (MLX swarm kit), blam (agent-mishap
benchmark). The private enterprise tier = fleet-remote (mirrors packages/,
depends on fleet) — pending W422.9.

## Laws (project-wide, every package)

- **One version**: `version:` in `~/.config/klh/stack.yaml` pins buckle +
  suspenders + belt; hubctl renders it as the git ref every hub pulls.
- **Config-over-code**: real hosts, keys, OIDC values live ONLY in
  machine-level runtime config (`~/.config/klh/stack.yaml`,
  `~/.claude/local-llm/*.env`, mode 600) — repos carry placeholders only.
- **Health is outside-process** (owner law 2026-10-05): a server cannot
  paint itself healthy. Services regenerate `status.json` heartbeats
  (deploy/healthcheck/heartbeat.ts) from their own event loops; health
  sidecars judge by file age, degrade on misses, actively probe before
  calling it unhealthy. Never put a healthcheck inside the served process.
- **Secrets are minted, never typed**: root keys generated ON the target
  device (0600, idempotent, never printed); admin + per-lane `bksk_` keys
  minted via the gate's admin API; revocable, audited.
- **No host-path deploys**: hub containers mount git-pulled volumes.
- **qlty is THE quality tool**; `.qlty/` must exist or the on-write gate
  silently no-ops. SPEC FIRST: read `.qlty/qlty.toml` + the biome rule set
  before the first write; never emit flagged patterns. biome owns code
  formatting; prettier owns markdown only.
- **1500-line hard limit** on any .ts — decompose, DRY the second
  duplicate, ast-grep for shareable patterns before adding near the limit.
  The on-write gate blocks past 1500.
- **UI engineering law**: Lit web components + CSS design tokens. NEVER
  `innerHTML`, never `document.write`. Native elements before custom.
  Lit is vendored (offline LAN — never CDN).
- **Streams over buffers**: streaming interfaces by default; NDJSON for
  logs/feeds; bounded rings with backpressure for async writes.
- **Old repos are push-dead**: all 9 originals (suspenders, belt, buckle,
  local, speedy, blam + the 3 -remotes) are ARCHIVED with redirect stubs.
  Every commit lands in THIS repo at `packages/<name>/*`. The old local
  checkouts still WORK for the installed harness (shims point there) until
  W422.6 re-anchors the install to fleet.

## Working agreements

- Work graph: `work` CLI (project identity = the repo's git-common-dir —
  fleet sessions get their own identity; the historical graph lives under
  the suspenders identity until the rekey lands, W428).
- Coordination plane: coord CLI + WS subscribe; broadcast landed changes
  that affect lanes (what/who/exact command).
- Per-package AGENTS.md/CLAUDE.md files came with each subtree — they are
  the package-level truth; this root file is the stack-wide law.
