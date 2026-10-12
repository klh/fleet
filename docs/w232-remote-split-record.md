# Remote repo split record — W232 (2026-10-02, closed 2026-10-11)

Owner direction 2026-10-02: split the hub product layer out of the public
repos — suspenders-remote / belt-remote / buckle-remote, an overlay that
INHERITS the bases (never forks): hub profile defaults, auth ON, multi-user
tokens, admin GUI, no local-MLX assumptions.

## Where it landed

The split shipped inside the W422.1 monorepo migration (owner GO
2026-10-05) as the private tier **klh-remote** — one private monorepo
mirroring `packages/`, local dir `~/github/klh/fleet-enterprise` (pushed
since — see Correction 2026-10-12 below):

| overlay                      | builds on          | adds                                                                                       |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `packages/suspenders-remote` | fleet `suspenders` | auth ON, OIDC enforced (W191); W231 admin GUI is base code, not overlay (correction below) |
| `packages/belt-remote`       | fleet `belt`       | fleet auth, federation peers (W322 edge)                                                   |
| `packages/buckle-remote`     | fleet `buckle`     | gateway auth, per-repo pin policies                                                        |

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

## Held decision (superseded — see correction)

`gh repo create klh/klh-remote --private` + tag-per-stack-ref push remains
owner-only (advice.10457). Until then the enterprise tier is local-only.

## Correction 2026-10-12 (W702)

- The overlay **is on GitHub**: private `klh/fleet-enterprise`
  (verified 2026-10-12 via `gh repo view`: PRIVATE, not archived, pushed
  2026-10-12). Published under W422.9 / W688.1.1 (main pushed, tag
  `stack-<sha>` per stack ref). The "local-only / held decision" text
  above is historical.
- The W231 admin GUI is fleet base code (`/console/hub`, `5c9c54c4`),
  not an overlay add — W690 `decision-w690-w231-audit-row-correction.md`.
