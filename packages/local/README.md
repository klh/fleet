# local

> Part of the klh fleet monorepo — the system overview (packages, flow
> diagrams, laws, ops) lives at the fleet root: [README.md](../../README.md).

![The quintessential local — a Greek taverna](assets/hero.png)

**One command per local service on macOS.** `klh-local register suspenders --port 7799` writes the Caddy site fragment, claims `suspenders.local` over mDNS, records everything in a registry file, and reloads Caddy — zero sudo, zero downtime. One command per service, every time. Design details in [SPEC.md](SPEC.md).

> **Platform: macOS** — launchd, Bonjour/dns-sd, and Caddy. Linux needs avahi + systemd equivalents, which are not implemented.

## Install

Requires [Bun](https://bun.sh). Caddy, the Caddyfile, and the user LaunchAgent are bootstrapped by the tool itself:

```bash
git clone https://github.com/klh/local && cd local
echo 'alias klh-local="bun /Volumes/Sensitive/github/klh/local/bin/klh-local.ts"' >> ~/.zshrc
klh-local install          # brew install caddy (if missing) + LaunchAgent + Caddyfile
```

Or one step: `./install.sh` — deploys `bin/` to `~/.local/klh-local/`, wires `~/.local/bin/klh-local`, bootstraps the bar dashboard agent, and registers the board as `bar.local` (idempotent, converges on re-run).

## The verbs

**install** — one-time bootstrap: installs Caddy via Homebrew (if missing), writes the Caddyfile skeleton with the default-deny catch-all, and starts a user LaunchAgent (`com.klh-local.caddy`, KeepAlive) running `caddy run`. Ports :80/:443 are bound unprivileged — no root anywhere.

**register** — validate name + port, write the fragment, `caddy validate` + `caddy reload` (user-level, zero downtime), claim the `.local` hostname, record it:

```bash
klh-local register suspenders --port 7799 --health /
klh-local register belt --port 7791 --health / --route /status=4100
klh-local register myapp --port 8080 --no-dns    # no .local hostname claim
klh-local register wiki --port 8090 --lan --forward-auth https://sso.example.com/api/verify
```

**Loopback by default.** Every site binds `127.0.0.1 ::1`; nothing is reachable from the LAN unless registered with `--lan`, and `--lan` is refused without `--forward-auth <url>` — Caddy's `forward_auth` asks that endpoint (Authelia, Authentik, oauth2-proxy, your SSO) before proxying. A fragment that fails `caddy validate` never lands in `sites/` (it is validated in a staging copy first), and a failed reload restores the previous fragment.

Re-running register with the same name + port **converges** — fragment rewritten, Caddy reloaded, the dns claim reused when alive and re-claimed only when dead — so install scripts can call it on every run. Changing the port requires `deregister` first.

`--route /path=port` (repeatable) adds path routes as Caddy `handle` blocks ahead of the default — path-preserving passthroughs to another local port, e.g. `https://belt.local/status*` → the gateway on :4100. A route path without a trailing `*` gets one (subtree match).

**list**

```console
$ klh-local list
belt         :7791   http://belt.local/         loop  dns: pid 41237    2026-09-28
suspenders   :7799   http://suspenders.local/   loop  dns: pid 41251    2026-09-28
```

**status** — health GET (1.5s timeout), dns-claim liveness (the pid must still be `dns-sd`), exposure, fragment presence. Read-only.

```console
$ klh-local status
suspenders  https://suspenders.local/ → 127.0.0.1:7799
  health   ok HTTP 200 3ms  (GET 127.0.0.1:7799/)
  dns      alive (pid 41251)
  exposure loopback only
  fragment ~/.local/state/klh-local/sites/suspenders.caddy
```

**deregister** — remove the fragment, kill the dns claim, forget the service:

```bash
klh-local deregister myapp
```

**reload** — after any hand edit to a managed file: `caddy validate` + `caddy reload`. No sudo, ever.

**hosts-apply** — rewrites one marked block in `/etc/hosts` from the registry:

```
# --- klh-local managed: start ---
127.0.0.1 belt.local
127.0.0.1 suspenders.local
# --- klh-local managed: end ---
```

macOS sends `*.local` to mDNS and hosts files cannot wildcard, so exact names in a marked block are the deterministic loopback path — without a resolver daemon hijacking printer/AirPlay `.local` names machine-wide. `register`/`deregister` print a drift hint when the file disagrees with the registry; the write itself is the one sudo in klh-local's world. The `.local` hostname is also claimed over mDNS (`dns-sd -P`, A record included): `127.0.0.1` for loopback services, the LAN address (en0, then the default-route interface) for `--lan` services so other devices resolve it. Under sudo the registry is found via `SUDO_USER` (or `--registry PATH`), and `/etc/hosts` is replaced atomically.

## Fleet surfaces

The convention (W148): **`suspenders.local` is the console** — the fleet board at :7799 with `/usage`; `bar.local` is the bar's own surface (:7792); `belt.local` serves the belt UI (:7791) with `/status*` passthrough to the LLM gateway (:4100). Repointing a host is a breaking change to its UI surface — additive `--route` passthroughs are the non-breaking way to add a path to another port.

**The `.local` name only answers while a dns-sd claim lives.** The fleet manifest’s `local-dns` service runs `klh-local dns-serve` at login and keeps the claim parent alive. Every 30 seconds it serially restores enabled registry claims whose exact process identity is missing, after verifying their active Caddy routes. Caddy startup races retry on the next pass; routes and service processes remain untouched. Shutdown releases only claims this runner created that still match both the registry PID and expected arguments. `--no-dns` registrations stay disabled, allowing another owner to announce those names. A manual `dns-reconcile <name>` verifies a replacement at invocation time; use the resident runner for persistent claims across CLI exit and reboot.

HTTPS is Caddy's internal CA (auto-HTTPS): this Mac verifies clean (`ssl_verify_result 0`, `caddy trust` already applied); any other LAN device sees a self-signed warning on first visit until it imports Caddy's root (`~/.local/share/Caddy/pki/authorities/local/root.crt`).

## Bar

The registry, rendered live: [http://bar.local/](http://bar.local/) — one hairline row per service (name, port, target, health via the same 1.5s GET the `status` verb makes, dns-claim liveness, fragment presence, created date), under a Caddy line (:80 answering, `caddy version`) and the registry path. Vanilla JS refreshing every 3s, no frameworks, no external assets — a single-file Bun server, `bin/dashboard.ts`.

![The bar — every local service, one honest row each](assets/bar.png)

- [http://bar.local/api/status](http://bar.local/api/status) — the same snapshot as JSON, health results included
- [http://bar.local/llms.txt](http://bar.local/llms.txt) — what klh-local is, in plain text

The board runs as a user LaunchAgent (`com.klh-local.dashboard`, `127.0.0.1:7792` — loopback only, Host-checked, no absolute paths in `/api/status`, `KLH_LOCAL_BAR_PORT`/`BELT_BAR_PORT` override; logs to `~/.local/state/klh-local/dashboard.log`). `install.sh` sets it up and registers the board itself as a service — the bar is just another row in its own table:

```bash
klh-local register bar --port 7792 --health /
```

Read-only by design: the bar probes and renders; it never registers, reloads, or claims.

## Security posture

- **Host-header safety** — names must match `^[a-z][a-z0-9-]{1,30}$`. The name lands in three sensitive places (Host-header target, site address, filename under `sites/`); the regex makes Host-header injection, path traversal, and config-syntax smuggling impossible.
- **Loopback by default** — sites bind `127.0.0.1 ::1`; LAN exposure is per-service opt-in (`--lan`) and always behind `forward_auth`.
- **Never proxy based on user input** — `reverse_proxy` targets are always `127.0.0.1:<port>`, written from validated registry data at register time. Nothing request-time is interpolated into the config.
- **Default-deny** — a hostless catch-all block `abort`s every Host no fragment claims, on both :80 and :443 (unknown SNI fails at the TLS handshake — no cert without on-demand TLS). DNS-rebind attempts and stray `curl` Host headers die at the proxy, never reaching a backend.
- **Zero root** — Caddy runs as a user LaunchAgent; validate and reload are user-level and zero-downtime. The only sudo in klh-local's world is `hosts-apply`.

## Companion repos

| Repo                                            | Role in the fleet                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| [suspenders](https://github.com/klh/suspenders) | Agent control plane: hooks, work graph, coordination bus, fleet board |
| [belt](https://github.com/klh/belt)             | Local LLM fleet and OpenAI-compatible endpoints                       |
| [speedy](https://github.com/klh/speedy)         | Speed and safety config layer: skills, hooks, personas, settings      |

## Licensing

local is source-available under the **Business Source License 1.1** (see [LICENSE](LICENSE)):

- **Free** for personal projects, education, research, and internal evaluation.
- **Production / commercial use requires a commercial license** — running it in a product or service, in paid client work, or as part of business operations. Contact the Licensor (see LICENSE) for terms.
- **No conversion** — unlike standard BSL 1.1, the Change Date / Change License parameters are **N/A**: the Licensed Work never converts to an open license; all rights remain with the Licensor indefinitely.

A Threads thing — [threads.dk](http://www.threads.dk).
