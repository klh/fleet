# authentik federation (W262 — W151 verdict execution)

W151 (commit `257b6d6`) picked **authentik** as the stack IdP: MIT core, free
SCIM in and out, first-party corporate-IdP federation guides. W262 lands the
execution in suspenders: an authentik-first **claims mapper** plus
**federation config** on the W149 issuer allowlist, and the first realized
shrink of the W149 delegated (user-token) surface.

## What landed (W262)

- `hooks/lib/govdb/identity-federation.ts` — `mapIdpClaims` (authentik-shaped
  claims → local principal shape: actor/team/scopes) and `hasFederation`.
- `hooks/lib/auth/auth.ts` — the OIDC issuer entry (`OidcIssuerConfig`) now carries
  the claims-map knobs (`groups_claim`, `group_scope_map`, `team_claim`).
  `verifyJwt` maps federated claims onto the local principal: with a
  `group_scope_map` configured, federated tokens carry local-shaped scopes
  and get scope-checked like local tokens; team derives from `team_claim`.
  No map = roles-only trust (the pre-W262 bypass, unchanged for legacy).
- `hooks/lib/auth/auth-server.ts` — under federation (`hasFederation`), the W149
  delegated plane refuses new human tokens: `POST /auth/token` with
  `token_class: "delegated"` → 403 `delegated_federated`; `POST /auth/refresh`
  refuses rotating legacy delegated pairs (401 `delegated_federated`).
  app-role (machine) issuance/rotation is untouched.
- `test/identity-federation.test.ts` — 12 tests: mapper units, the RS256
  resource-server integration (injected fetch, no network), lib + route
  refusals, and the legacy no-federation passthroughs.

## Enabling federation (config-over-code)

Point `BUCKLE_AUTH_CONFIG` at a JSON file (machine-level config, mode 600;
repos carry placeholders only):

```json
{
  "issuers": [
    { "type": "local", "iss": "buckle" },
    {
      "type": "oidc",
      "iss": "https://authentik.example.invalid/application/o/klh/",
      "discovery": "https://authentik.example.invalid/application/o/klh/.well-known/openid-configuration",
      "audience": "buckle",
      "groups_claim": "groups",
      "group_scope_map": {
        "klh-admins": ["buckle:admin"],
        "klh-lanes": ["read_coord", "write_coord", "write_auth"]
      },
      "team_claim": "klh_team"
    }
 ]
}
```

Placeholders. Real host/issuer values live only in machine-level config.

Authentik side (one-time): create provider for the app (KLH), scope mapper
emitting `groups` (authentik's default groups mapper) and an optional custom
property mapping for the team claim; note the issuer slug; download or point
discovery at its openid-configuration. RS256 is the default signing key.

## W149 shrink (user-token plane)

Under federation the IdP owns user identity; the W149 delegated surface
retires on the API: delegated issuance and refresh rotation refuse with
fixed codes. The machine plane stays ours (W151: lane/service keys, budgets,
spend on the W132 v8 tables + the W149 issuer). Admin break-glass stays via
the auth CLI (`hooks/bin/auth.ts issue --class delegated`), so a dead IdP can
still mint an owner pair.

## W141 teams shrink (memberships ride claims)

Team membership for federated users derives from the token (`team_claim`),
not homegrown CRUD. Buckle's `teams` surface shrinks to what machines need:
budget ceilings + revoke-by-team. User/team management is the IdP's job
(authentik groups); our tables keep only ceilings keyed by team id.

## Demand-gated (NOT in W262)

SCIM in/out provisioning and org-admin roles — built only on owner demand,
per the W151 verdict's demand-gates. The authentik eval (commit `257b6d6`)
shows authentik ships both free when that day comes.

## Rollback

Remove the oidc entry from the auth config (or unset `BUCKLE_AUTH_CONFIG`)
and restart the store server: the local issuer resumes, delegated issuance
reopens, scope checks revert to local-only. No data migration — `api_keys`
and `auth_events` rows stay.
