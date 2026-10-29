# deploy/e2e — the W234 docker e2e harness

Stands the full chain up in containers from the checkout under test, then
walks four probes against the live stack. Runs in CI and locally:

    FLEET_DIR=$PWD bun packages/suspenders/deploy/e2e/run-e2e.ts

(Without FLEET_DIR the runner defaults to the repo root above deploy/e2e;
in a worktree the runner's own checkout is the unit under test.)

## What stands up

`e2e-compose.yaml` on one bridge network, host-loopback publishes only:

- **belt-stub :8902** — belt in cpu-mode: the swarm specialists are MLX
  (Apple-only), so the harness serves the tier port the routing ladder
  targets (:8902) from a canned OpenAI wire-contract stub (`stub-tier.ts`,
  marker reply `e2e-stub-ok`).

- **buckle-hub :4111** — the gate, auth ON (non-loopback bind refuses to
  boot without it), root key minted ON this device (0600 `buckle.env`
  env_file, fail-closed), ladder → belt-stub via the BUCKLE_UPSTREAMS
  override (`upstreams.e2e.json`).
- **caddy :8080** — the klh/local front shape: catch-all + named
  `e2e-buckle.local` site proxying the gate (Caddyfile.e2e).
- **board-hub :7809 + store-hub :7796** — the suspenders control plane.
- **buckle-overlay :4121** — the private *-remote overlay leg, auth ON,
  behind `--profile overlay`: the public compose excludes it (solo is the
  public surface); the private repo's run passes `--profile overlay` with
  `KLH_E2E_OVERLAY_SRC` pointing at its overlay packages root.

## The probes

`run-e2e.ts` probes from the HOST over the published ports — the outside
process that owns the verdict; compose healthchecks + the probe.ts
sidecars give `docker compose ps` its health view; the RUNNER gates CI:

1. **chat-through-buckle** — anthropic dialect at the gate, openai dialect
   through caddy; both legs end at the stub tier (marker in the reply).
2. **admin-token-lifecycle** — root mints admin, admin mints a
   proxy-scoped key, key used on a real completion, revoked, 401 behind it.
3. **enroll-a-hub** — admin mints a one-time enrollment code, the spoke
   redeems it for a hub-issued token, the token pulls the policy manifest.
4. **dispatch-a-lane** — real `dispatch-next.ts` in a scratch repo pins a
   lane to the compose hub (`.prefer hub=e2e-hub` + hubs.json registry,
   W357 fixture shape); the stub executor (`lane-executor.ts`) routes one
   chat through `<hub>/w/<sid>` with the hub-minted scoped key (W615) and
   writes the evidence the runner asserts on.

## Flags

    --keep            leave the stack running after the verdict
    --overlay         activate the private overlay profile (private repo:
                      pass KLH_E2E_OVERLAY_SRC = the overlay packages root)
    --skip-dispatch   skip the dispatch leg (no dispatch deps on host)

`KLH_E2E_TIMEOUT_S` overrides the per-service health budget (default 240s
local, 420s CI).

## Why a seeded volume, not a git-pulled one

hub-compose.yaml is the DEPLOY-grade template (git-pulled volume, pinned
ref, host networking, probe sidecars). The e2e harness tests the local
checkout — in CI that is the PR sha itself — so `repo-seed` copies the
read-only $FLEET_DIR bind into the `fleet-tree` volume (never writing to
the bind) and `fleet-deps` runs `bun install --frozen-lockfile` there:
the services need the @klh/* workspace links. Secrets never enter the
tree (root key = the runner's 0600 `buckle.env`, mounted via env_file,
gitignored).
