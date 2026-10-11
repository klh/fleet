# Remote repo split record — W232 (2026-10-02, closed 2026-10-11)

Owner direction 2026-10-02: split the hub product layer out of the public
repos — suspenders-remote / belt-remote / buckle-remote, an overlay that
INHERITS the bases (never forks): hub profile defaults, auth ON, multi-user
tokens, admin GUI, no local-MLX assumptions.

## Where it landed

The split shipped inside the W422.1 monorepo migration (owner GO
2026-10-05) as the private tier **klh-remote** — one private monorepo
mirroring `packages/`, local dir `~/github/klh/fleet-enterprise`, not on
GitHub yet (push is an owner-held decision):

| overlay                      | builds on             | adds                                            |
| ---------------------------- | --------------------- | ----------------------------------------------- |
| `packages/suspenders-remote` | fleet `suspenders`    | auth ON, OIDC enforced (W191), admin GUI (W231) |
| `packages/belt-remote`       | fleet `belt`          | fleet auth, federation peers (W322 edge)        |
| `packages/buckle-remote`     | fleet `buckle`        | gateway auth, per-repo pin policies             |

Each overlay: git dep pinned at the stack version (`deploy/pin.ts` renders
from `~/.config/klh/stack.yaml`) + `config/hub-profile.yaml` (placeholders
only). Enterprise extras only, never copies.

## First cut superseded

The original three standalone repos (2026-10-02 skeletons) were pushed
private and then archived when the monorepo superseded them — verified
2026-10-11 via gh: `isArchived: true` for klh/suspenders-remote,
klh/belt-remote, klh/buckle-remote (last push 2026-10-05). Local checkouts
are inert mirrors; content fully absorbed by the overlays.

## Boundary verification (2026-10-11)

- fleet references `*-remote` only in prose (`packages/suspenders/deploy/`
  README + stack.example comment, this record) — no code dep, no URL to
  the archived repos.
- fleet LICENSE is BUSL 1.1; no hub-profile/auth/admin code in any
  public/local package.
- klh-remote tree clean at `f09333f`, root `package.json` private, deps =
  fleet at the stack sha.

## Held decision

`gh repo create klh/klh-remote --private` + tag-per-stack-ref push remains
owner-only (advice.10457). Until then the enterprise tier is local-only.
