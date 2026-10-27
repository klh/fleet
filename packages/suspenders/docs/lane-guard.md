# lane-guard — W1141: per-lane credential scoping, egress allowlist, trailers

The cloud-session bar ([claude.dev/blog/claude-code-in-the-cloud](https://claude.dev/blog/claude-code-in-the-cloud/)):
"your GitHub token never enters the VM." Three surfaces, one machine conf,
inert by default (a missing or broken conf disables the whole guard — a
broken conf must never strand 40 running lanes).

## Surfaces

### push — credential-layer branch scoping

A resident proxy (`com.suspenders.lane-guard`, ports 7817/7818) holds the
REAL origin credential; the lane worktree gets a per-item identity (Basic
`sid:token`, minted 0600 at `work take` under `<repo>/.fleet/lane-guard/`).
The worktree's `remote.origin.pushurl` rides the proxy front (worktree-local
config — `extensions.worktreeConfig` — a shared .git/config would route the
whole repo through one lane's credential). The proxy parses the receive-pack
command list at the head of every push body and refuses anything but
`refs/heads/suspenders/<item>` — main, sibling branches, tags, deletions —
403 BEFORE any byte moves toward the origin. Allowed pushes are relayed
statelessly with the machine's own credential (local-path origins via
`git receive-pack --stateless-rpc`, ssh via `ssh <host> "git-receive-pack ..."`).

**Acceptance (proven in test/lane-guard-proxy.test.ts):** the lane's own
branch lands (`ok refs/heads/...` report), a main push is refused at the
credential layer (403, origin untouched), deletion of the lane's own branch
is refused, a wrong token gets 401.

### egress — allowlist for lane processes

A CONNECT/forward proxy on :7817 answers every destination-hostname verdict
from the machine-conf allowlist; denies are answered 403 and logged NDJSON
(default `~/.claude-insights/lane-egress.log`: host, port, verdict, via).
When the conf carries `egress.allow`, dispatch pins
`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` at the front in the lane settings env
(`scripts/lib/lane-settings.ts egressProxyEnv`).

### trailers — transcript tracing

Every lane commit carries `Fleet-Session: <sid>` / `Fleet-Item: <item>`
(Claude-Session-style). The PreToolUse Bash hook
(`hooks/bin/lane-commit-trailer.ts`, third entry in the per-lane settings
hooks block) rewrites `git commit` calls with the trailer flags; the done
gate (`trailerVerdict` in `hooks/lib/lane-guard.ts`) scans the closure
window — merge commits are exempt; audit is the default (`[audit]` note on
the record), `SUSPENDERS_TRAILER_GATE=enforce` refuses closure, `off` is
silent.

## Machine conf `~/.claude/lane-guard.json`

```json
{
  "push": { "mode": "enforce" },
  "egress": { "allow": ["*.local", "github.com", "127.0.0.1"],
              "log": "/path/lane-egress.log" },
  "trailers": "enforce"
}
```

- absent / unparseable / `SUSPENDERS_LANE_GUARD=0` → guard OFF (inert posture).
- `push.mode: enforce` wires the scoped pushurl at `work take`; `audit` mints nothing.
- `egress.allow` gates BOTH the proxy front and the settings-env proxy pins.

## Env knobs

| knob | meaning |
| --- | --- |
| `SUSPENDERS_LANE_GUARD` | conf path, or `0` to disable the guard |
| `SUSPENDERS_TRAILER_GATE` | `enforce` / `audit` / `off` (outranks conf; audit default) |
| `LANE_GUARD_EGRESS_PORT` / `LANE_GUARD_PUSH_PORT` | port overrides (defaults 7817/7818) |

## Threat model — what this is and is not

This is defense-in-depth against ACCIDENT: a lane `git push origin main`
via its scoped pushurl is refused at the credential layer (not gate prose);
proxy-aware lane clients (bun/curl/git/npm — everything dispatch launches)
cannot egress outside the allowlist. It is NOT an adversarial sandbox: a
non-proxy-aware process binding raw sockets bypasses the egress front, and
a lane could re-point its own worktree config — the gate prose and the
audit log are the backstop there, not the credential.

## Setup-cache parity (W768)

The dispatch starter fork is seed-once-fork-every-lane: the first lane pays
full setup, later lanes fork a ready tree — functionally a snapshot cache
after the first success. lane-guard adds nothing to setup cost: identities
are minted at take-time in milliseconds, and the proxies are resident
(per-machine, not per-lane).
