# Decision — W231 audit-row correction (W690)

Corrects `enterprise-posture-audit.md` row "W231 … ALREADY OVERLAY"
(flagged by the W688 gap review, `enterprise-gap-review-w688-2026-10-12.md`
§Classification correction).

## Fact

The W231 hub admin plane landed in **fleet base code**, not the overlay:
commit `5c9c54c4` — `/console/hub` on the fleet board (belt board,
suspenders package):

- `hooks/board/routes-hub-admin.ts` (+ `bin/hub-admin-html.ts`,
  `board-html/klh-hub-admin.ts` Lit component, vendored bundle)
- `hooks/lib/hub-tokens.ts` — masked token listing, issue/revoke per
  actor; every GUI mutation lands in `admin_audit` (governor.db)
- `hooks/lib/hub-provider-keys.ts` — masked (••••last4) provider-key
  inventory, env homes only
- `hooks/lib/hub-federation-status.ts` — peer status lens
- `test/hub-admin.test.ts` (17 route/lib tests)

The suspenders-remote profile comment "base code, W231" was already
accurate; the audit row (and `finding.auth-posture-split`'s re-target of
W231 at the overlay) was stale.

## Verdict

**KEEP public — W231 admin GUI is base code.** Row corrected to
`KEEP (LANDED IN FLEET 5c9c54c4)`.

Rule check:

- Rule 1 (zero solo reach) **fails**: the board is a solo surface;
  `/console/hub` is served on any install, and `lib/auth.ts` token issue
  /rotate/revoke is the solo dispatch flow (per-lane keys).
- The GUI is an admin *lens* over the same `api_keys` rows (listings
  never carry `key_hash` or raw material; raw material is one-shot at
  issue), behind the board's write guard (Host allowlist + Origin==Host
  + per-install write token) — defensive-adjacent hardening the public
  tier keeps (finding.auth-posture-split: never strip defensive auth).
- Machine plane only: the tokens issued here are our own machine
  credentials. Human identity for an enterprise IdP is a resource-server
  concern (OIDC/JWT validation + claims→scope mapping, `jwt.ts` /
  `adaptation.ts` seams), not this GUI.

## What stays overlay (unchanged)

Enterprise auth that is **not** in this commit and stays overlay-owned:
OIDC/RBAC enforcement wiring per customer (W191 scope), per-customer
policy pinning, billing gates, and any team-onboarding/env-isolation
product flow (calls the public admin APIs — see
`decision-w690-teams-ceilings-ddl-coexistence.md`).

## Follow-through

- Audit row corrected in `enterprise-posture-audit.md` (this commit).
- The governing fact `finding.auth-posture-split` still names W231 as
  overlay; superseded by this record — the finding's W231 clause should
  be read as "admin GUI = base (5c9c54c4); enterprise auth enforcement =
  overlay".
