# Decision — teams/ceilings DDL co-existence (W690)

Closes the "PHASE-2 REVIEW" row for the W141 teams table + ceilings in
`enterprise-posture-audit.md`. Decision record only; no schema change.

## Verdict

**KEEP the `teams` table, its ceiling columns, and the ceiling read-side
in the public governance schema.** No strip, no overlay move.

Evidence (packages/buckle):

- `src/gov/middleware.ts` (~:515) — the public gate calls
  `keys.teamCeilings(p.team)` on every admitted request and enforces the
  raw ceiling against `team_budget_state` (W468). A solo install with
  team-tagged keys reaches it. Rule 1 (zero solo reach) fails.
- Ceilings are budget **enforcement** — defensive (degrade honestly,
  bound spend). Rule 2 fails: it is not mint/inventory/meter/entitlement.
- `src/gov/schema.ts` creates `teams` in the base DDL and heals the
  ceiling columns with guarded `ALTER TABLE ... ADD COLUMN` (idempotent
  on every open). Stripping the table would make the gate's SELECT throw
  "no such table" on every public hub.
- `src/gov/federation.ts` and `adaptation.ts` read ceilings/team
  attribution; the SSO principal carries `team` for exactly this.

## Co-existence rules (what the overlay may and may not do)

1. **The overlay never CREATEs or ALTERs `teams`** or `team_budget_state`.
   One table, one owner (public schema). Two writers of the same DDL is
   the fork the seam pattern exists to prevent.
2. **Overlay team data lives in its own tables keyed by `team_id`**
   (e.g. a team-profile / onboarding / environment-binding table in the
   overlay hub schema fn), with no FK constraint into `teams` — the
   overlay schema can be absent without orphaning public rows, and a
   public-only open never sees overlay tables.
3. **Writes to `teams` go through the public admin API**
   (`POST /v1/admin/teams`, `KeyStore.upsertTeam`). A guided team-onboarding
   flow (create team → config profile → environment wiring → key issuance
   → handover) is an overlay/console surface that *calls* that API, never
   a parallel writer.
4. **New ceiling-shaped columns follow the existing pattern**: guarded
   `ALTER` in `openLedger`, nullable, null = "no ceiling". Never a
   non-null add that breaks older ledgers.
5. Public tests pin ceilings read-side; overlay tests pin their own
   tables; neither reaches into the other's DDL.

## Observation (not changed here)

`schema.ts`'s `deltas` mirror column list for `teams`
(`team_id, name, department, created_at`) omits `rpm_ceiling` /
`tpm_ceiling`, so ceiling edits are not mirrored into governor.db. Not a
classification issue; mint a work item if hub-side ceiling audit needs it.

## Re-open trigger

A concrete hub-only team feature that cannot be expressed as an
overlay-owned table keyed by `team_id` (e.g. needs a column on `teams`
itself). Then: new record, guarded-ALTER column in public schema (rule 4),
never an overlay ALTER.
