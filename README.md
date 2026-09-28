# local

![The quintessential local — a Greek taverna](assets/hero.png)

**One command per local service on macOS.** `klh-local register suspenders --port 7799` writes the Caddy site fragment, claims `suspenders.local` via dns-sd, records everything in a registry file, and reloads Caddy — zero sudo, zero downtime. Instead of hand-wiring a conf, a `dns-sd -R` process, and a `sudo nginx -s reload` for every service, every time. Design details in [SPEC.md](SPEC.md).

## Install

Requires [Bun](https://bun.sh). Caddy, the Caddyfile, and the user LaunchAgent are bootstrapped by the tool itself:

```bash
git clone https://github.com/klh/local && cd local
echo 'alias klh-local="bun /Volumes/Sensitive/github/klh/local/bin/klh-local.ts"' >> ~/.zshrc
klh-local install          # brew install caddy (if missing) + LaunchAgent + Caddyfile
```

## The verbs

**install** — one-time bootstrap: installs Caddy via Homebrew (if missing), writes the Caddyfile skeleton with the default-deny catch-all, and starts a user LaunchAgent (`com.klh-local.caddy`, KeepAlive) running `caddy run`. Ports :80/:443 are bound unprivileged — no root anywhere.

**register** — validate name + port, write the fragment, `caddy validate` + `caddy reload` (user-level, zero downtime), claim the `.local` hostname, record it:

```bash
klh-local register suspenders --port 7799 --health /
klh-local register belt --port 7791 --health /health/liveliness
klh-local register myapp --port 8080 --no-dns    # no .local hostname claim
```

**list**

```console
$ klh-local list
belt         :7791   http://belt.local/         dns: pid 41237    2026-09-28
suspenders   :7799   http://suspenders.local/   dns: pid 41251    2026-09-28
```

**status** — health GET (1.5s timeout), dns-claim liveness, fragment presence. Read-only.

```console
$ klh-local status
suspenders  https://suspenders.local/ → 127.0.0.1:7799
  health   ok HTTP 200 3ms  (GET 127.0.0.1:7799/)
  dns      alive (pid 41251)
  fragment /Users/kk/.local/state/klh-local/sites/suspenders.caddy
```

**deregister** — remove the fragment, kill the dns claim, forget the service:

```bash
klh-local deregister myapp
```

**reload** — after any hand edit to a managed file: `caddy validate` + `caddy reload`. No sudo, ever.

**migrate** — ports existing hand-wired nginx vhosts to fragments and prints the nginx bootout commands (printed, not run). The actual cutover is a human step — see SPEC.md.

## Security posture

- **Host-header safety** — names must match `^[a-z][a-z0-9-]{1,30}$`. The name lands in three sensitive places (Host-header target, site address, filename under `sites/`); the regex makes Host-header injection, path traversal, and config-syntax smuggling impossible.
- **Never proxy based on user input** — `reverse_proxy` targets are always `127.0.0.1:<port>`, written from validated registry data at register time. Nothing request-time is interpolated into the config.
- **Default-deny** — a hostless catch-all block `abort`s every Host no fragment claims, on both :80 and :443 (unknown SNI fails at the TLS handshake — no cert without on-demand TLS). DNS-rebind attempts and stray `curl` Host headers die at the proxy, never reaching a backend.
- **Zero root** — Caddy runs as a user LaunchAgent; validate and reload are user-level and zero-downtime. The only sudo in klh-local's world is the nginx bootout that `migrate` prints for you — never runs.

## Licensing

local is source-available under the **Business Source License 1.1** (see [LICENSE](LICENSE)):

- **Free** for personal projects, education, research, and internal evaluation.
- **Production / commercial use requires a commercial license** — running it in a product or service, in paid client work, or as part of business operations. Contact the Licensor (see LICENSE) for terms.
- **No conversion** — unlike standard BSL 1.1, the Change Date / Change License parameters are **N/A**: the Licensed Work never converts to an open license; all rights remain with the Licensor indefinitely.

A Threads thing — [threads.dk](https://www.threads.dk).
