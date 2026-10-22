---
name: fleet-install
description: Install and wire the klh fleet agent stack on a machine — install.sh (harness + launchd + skills registration), fleet-install.ts (per-CLI hook-dialect wiring across 70+ detected agent targets), and hubctl hub deploys. Use when onboarding a machine or agent CLI to the fleet, adding a hook-dialect adapter, refreshing the vendored agent registry, or deploying to a hub. Not for runtime ops on an already-installed machine — that is fleet/fleet-pulse territory.
---

# fleet-install

Install and wire the klh fleet stack ($ARGUMENTS — optional target or `--dry-run`).

## When to use

- Onboarding a machine (harness) or a specific agent CLI (hook-dialect wiring)
- Adding a hook-dialect adapter for a new agent target
- Refreshing the vendored vercel-labs/skills agent registry
- Deploying the stack to a hub (NAS/desktop profiles)

## Workflow

1. **Harness install** — `bash install.sh` from the repo's `packages/suspenders`
   (the ONLY repo→prefix sync; never cp). `--wire` also wires Claude Code
   settings; `--with-launchd` registers the launchd services. Restart Claude
   Code after install so the hooks register.
2. **Wire agent CLIs** — `bun hooks/bin/fleet-install.ts` (detect + prompt) from
   `packages/suspenders`. Non-interactive: `--agent codex,github-copilot`,
   `--agent '*' -y` (every supported target), or `--dry-run` (plan only). Only
   supported targets wire (claude-code is native; codex, github-copilot, grok,
   cline carry dialect adapters); gated targets refuse with a pointer to
   `docs/cli-dialect-pattern.md`.
3. **Skills registration** — the installer registers every subpackage of the
   repo-root `skills/` catalog via `bunx skills add <catalog> -g -y -a
claude-code`; one parent-dir add discovers every skill (never cp'd into one
   CLI's dir). Root placement makes the same catalog discoverable via
   `npx skills add <owner/repo>` — the W772 distribution path.
4. **Hub deploys** — `bun deploy/hubctl.ts deploy <hub>` (mint → push → up →
   status); config lives only in machine-level `~/.config/klh/stack.yaml`.
5. **Verify** — `bun scripts/install.ts --json --dry-run` (the install plan),
   `bun $PREFIX/bin/monitor.ts` (control-plane health), `work lanes --json`
   (lane liveness).

## Verification

- [ ] `fleet-install.ts --dry-run` prints the wiring plan, nothing written
- [ ] `install.ts --json --dry-run` exits ok
- [ ] `work lanes --json` shows live lanes after a real install

## Gotchas

- Testing the installer with a swapped HOME still registers REAL launchd agents if `--with-launchd` runs — use `--dry-run` or a harness that stubs `launchctl`.
- The install tail runs `work report` through the PATH shim — a missing `~/.local/bin` on PATH makes that section fail; that is the shim, not the install.
- Old checkouts are push-dead: every sync lands in THIS repo at `packages/<name>/*` — never re-anchor an archived repo.
