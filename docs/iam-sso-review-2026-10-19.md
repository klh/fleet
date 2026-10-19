# Fleet IAM / SSO review — 2026-10-19 (W844)

Coordinate with docs/iam-sso-review-2026-10-19.md — this IS that document,
authored at the close of W844. Status: fleet-side seam + enforcement landed
on `suspenders/W844`; the engine lives in the private overlay
(fleet-enterprise `suspenders/W844` @ 26a192a6). Evidence: fleet buckle
suite 597/597, fleet iam-seam suite 11/11, overlay acceptance drills 7/7
(71 expects).

## 1. Current state (what existed before W844)

The pre-W844 stack had exactly one IAM-adjacent surface: the buckle JWT
validator (`packages/buckle/src/gov/jwt.ts`) — per-issuer JWKS allowlist,
audience check, exp/nbf + skew, fixed-shape error codes. It VALIDATES
tokens. It is not an IAM suite: no login flow, no sessions, no roles, no
tenants, no revocation, no audit. The review's core finding stands: the
JWT validator was a good primitive, not a complete answer — W844's brief
said exactly this.

## 2. The P0 design — seam + overlay split (W775 law)

Fleet (public stack) carries the CONTRACT and the enforcement pipeline;
the private overlay (fleet-enterprise) carries the ENGINE. One-directional:
fleet never references the overlay; the overlay imports fleet primitives
(`createJwtValidator`) through the pinned git dep. Gate-less = Core SKU,
byte-for-byte unchanged behavior.

- `packages/suspenders/hooks/board/iam-seam.ts` — the contract:
  `IamGate { route, authn, authorize }`, principal/authn/authz shapes,
  `IAM_PUBLIC_PREFIX`, challenge/forbidden builders (302 for HTML,
  401 JSON + www-authenticate for APIs).
- `packages/suspenders/hooks/board/iam-enforce.ts` — `enforceIam()`:
  route() → authn() → authorize() → dispatch; no gate registered =
  direct dispatch.
- `fleet-board.ts` — loads `KLH_OVERLAY_MODULE` and registers
  `iamGate(db)` + `enterpriseProvider(db)`; wraps the serve fetch.
- Overlay engine (`fleet-enterprise packages/suspenders-remote/src/iam/`):
  schema (9 tables), config (fail-closed `iamConfigFromEnv`), sessions
  (SHA-256-at-rest opaque sids, sliding + absolute TTL), per-request RBAC
  (viewer < operator < admin; roles resolved from the db EVERY request),
  OIDC authorization-code + PKCE (S256, single-use states, 600s TTL,
  discovery issuer-must-match, nonce check), audited break-glass
  (single-use time-boxed grants, secret shown once, hashed at rest),
  the gate (route/authn/authorize over the above), and the enterprise
  read-model provider (identity + audit panels real; unwired panels answer
  the contract's honest FailedSlice).

## 3. Acceptance drill map (all green)

| Acceptance | Drill (test/iam/iam.test.ts) | What it proves |
| --- | --- | --- |
| IdP outage | "IdP outage — login 503 fail-closed; live sessions outlive" | login answers fail-closed 503 `iam.login_unavailable`; already-minted sessions keep authenticating until TTL; whoami works dark |
| Issuer/JWKS rollover | "issuer/JWKS rollover — login after rotate() succeeds" | a login signed by the NEW kid succeeds because the W844 fleet jwt.ts forces one JWKS refetch on unknown kid; state replay → 400 |
| Cross-tenant isolation | "cross-tenant isolation — 403 + t2 provider sees nothing" | `?tenant=` mismatch → 403 `iam.cross_tenant`; the t2 provider's identity panel leaks zero t1 rows |
| Role removal | "role removal — permission gone next request" | DELETE the group membership → next request 403 `iam.role_missing` while the SESSION still authenticates; re-login resyncs membership from the IdP claim set |
| Session revocation | "break-glass — mint once, redeem once, admin bypass; revoke-all" | single-use grant (secret once, hash at rest), bg admin bypasses tenant check, revoke-all kills every tenant session; logout revokes + clears |
| RBAC + abs-cap | "rbac matrix + session abs-cap units" | role ladder demands, cross-tenant + rank denials, sliding TTL capped by abs; empty-roles sessions read NOTHING (rank −1) |

Supporting: fleet `iam-seam.test.ts` 11/11 (slot mechanics, challenge
shapes, pipeline call order, 404 un-routed public path).

## 4. Deployment wiring (config-over-code; names only)

```
KLH_OVERLAY_MODULE=<prefix>/.../suspenders-remote/src/index.ts
KLH_IAM_DB=<path>            # iam store; absent = Core SKU (no gate)
KLH_IAM_TENANT=<tenant id>
KLH_IAM_ISSUER=<IdP issuer>  # discovery issuer must EQUAL this
KLH_IAM_CLIENT_ID / KLH_IAM_AUDIENCE / KLH_IAM_REDIRECT_URI
KLH_IAM_CLIENT_SECRET        # optional (public PKCE clients omit)
KLH_IAM_SESSION_TTL_M=480 · KLH_IAM_SESSION_ABS_M=720 · KLH_IAM_BG_TTL_M=60
KLH_IAM_COOKIE=klh_iam_sid
```

Groups: the IdP groups claim syncs to IAM groups by `external_id`;
role_bindings attach to users or groups; login provisions users with
`usr_` ids; break-glass mints `bgk_` secrets shown exactly once.

## 5. Documented posture — honest limits

- **Fail-open registration**: gate registration failure (bad
  `KLH_IAM_DB`, overlay module crash) leaves the board UNGATED with a
  console error. P1 hardening: a fail-closed boot knob for deployments
  that must not serve ungated.
- **Sessions outlive IdP outage** until TTL — by design (drill 7), with
  revocation paths (logout, per-principal, tenant-wide) as the levers.
- **Discovery cache is module-global** (300 s, single issuer per process)
  — multi-issuer would need a keyed cache; not a P0 need.
- **SCIM provisioning, multi-hub signed policy**: land beyond P0.
  Browser SSO + tenant boundaries + per-request RBAC + break-glass ARE P0
  and ARE done.
- **Fleet-side scratch test**: the jwt-rollover unit test scratch file was
  removed during the lane (emission-corrupted); rollover is covered
  E2E by the overlay drill against the real validator.

## 6. Cross-repo state

- Fleet `suspenders/W844` @ 5593a38b — seam + enforce + board wiring +
  jwt.ts rollover/fail-closed JWKS + iam-seam tests.
- Fleet-enterprise `suspenders/W844` @ 26a192a6 — the engine + rig +
  drills (this doc's §3 evidence).
