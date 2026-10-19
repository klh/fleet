# Usage reconciliation + bounded spend policy (W843)

Date: 2026-10-19 · Author: lane autow843 (item [W843](http://suspenders.local/?task=W843)) · Scope: buckle governance + ledger, suspenders usage export

## The currency rule (owner law, restated as design)

A **no-capex or fixed-cost claim requires provider billing and host-capacity
evidence**. The gate observes tokens and requests — it cannot observe money.
Therefore:

- **No currency field exists anywhere in the budget authority.** Per-Mtok
  pricing, when it ever lands, is machine-level runtime config
  (`~/.config/klh/`), filled ONLY from provider billing evidence (an invoice
  or a billing export). Hardcoded prices in code are refused — config-over-code.
- Until that evidence exists, the enforceable bound is **token-denominated**:
  the `spend_ceiling` (lifetime tokens per team) introduced here. A token cap
  is an honest bound on the quantity the gate actually sees; a currency claim
  without billing evidence would be an invented number.

## Per-request provider usage attribution (already landed; the map)

| Surface | Where | Notes |
| --- | --- | --- |
| per-request row | `route_audit` keyed by `rid` (packages/buckle/src/ledger.ts) | decision + outcome + usage columns (`in_tok`, `out_tok`, `cache_r`, `cache_c`, `cache_reported`) |
| attribution dims | `actor` (key id), `lane` (/w/ slug, W1), `target_host/model`, `dialect`, `tier` | the per-team report joins `api_keys.team` |
| billing dedup | `hop` (W706) | `origin` = designated billing source; `forwarded` = peer-relayed evidence, never billed again |
| cache boundary | `(provider, tenant, region, model)` (W458.4) | tenant = credential name, never request text |
| hour aggregates | `router_usage` | the rollup the W179.1 export reads |

## Reconciliation

Three leak classes, each with its disposition:

1. **Retries.** A ladder walk counts its attempts (`attempts`, W824) but a
   failed attempt's token consumption is unobservable at runtime — error
   bodies carry no usage. The ledger can never under-report DELIVERED usage
   (only the delivered attempt's usage joins the row by rid); it can
   under-report BILLED usage by whatever the provider bills for failed
   attempts. Disposition: reconciliation is a **process, not a runtime
   estimate** — join the provider billing export (W179.1 per-actor CSV) to
   `route_audit` by window/actor; the delta rows are the failed-attempt cost.
   Never paper it with an in-gate estimate.
2. **Streaming.** Usage lands at drain: the SSE sniffer feeds `record()` in
   a `once()` finalizer (handlers.ts), and the rid-keyed usage UPDATE is
   order-independent at flush — a stream that settles after its outcome row
   still joins correctly ("drain reconciliation"). A stream that dies before
   `message_start`/final delta leaves NULL columns.
3. **Missing final usage.** Honest unknown, never zero-faked: NULL usage
   columns + `buckle_usage_unknown_total` (servicemon). The W179.1 export
   and the reconciliation join above are the only correction path; the gate
   does not estimate tokens from bytes beyond the W141 admission
   reservation, which is explicitly a reservation, not a measurement.

## Bounded spend policy (implemented in this item)

- `teams.spend_ceiling` (guarded ALTER) — lifetime token-denominated cap.
- `spend_state` table — the book; subject `team:<id>`.
- `Budgets.check` reserves `ceil(content-length/4)` input tokens against the
  book inside the SAME `BEGIN IMMEDIATE` admission transaction that enforces
  rpm/tpm (replica-safe, W468 semantics); denial rolls the reservation back.
- `addUsage` adds the provider-reported real usage at settle. The book errs
  HIGH (a delivered request counts its input estimate and its real input) —
  the safe direction for a cap, never under.
- The middleware null-window skip (`rpm`/`tpm` both null) does NOT apply
  when a team carries a spend ceiling — the ceiling is never skipped.
- Tests: packages/buckle/test/gov-spend.test.ts (unit, reservation/rollback/
  settle semantics), packages/buckle/test/gov-spend-gate.test.ts (e2e 429 +
  report readback).

## Readable per-team report (implemented in this item)

`GET /v1/admin/teams/report` (admin scope READ) — one object per team:
ceilings (`rpm`/`tpm`/`spend`), live member count, the durable minute-window
rows, and `spend_used_tok` from the book (null when the team never carried
usage). This is the human-readable surface; W179.1's CSV export remains the
machine-reconciliation channel.

## No fail-open direct fallback in a governed pilot (verified)

- `probeFrontDecision(false, "strict")` → `refuse` (fail-closed W422.17;
  tested in packages/suspenders/test/dispatch-next.test.ts). The
  belt-direct fallback exists ONLY as `governance:solo`'s loud, disclosed
  degradation or the explicit `--allow-ungoverned` operator override —
  never silently, never in strict.
- Mint failures refuse (W463 matrix) — solo relents only at the front probe.
- The budget authority itself is fail-closed: `budgets.check` throws on a
  DB error, the admission `try/finally` releases the slot, and the request
  dies — there is no pass-through when the books are unavailable.
- W843 adds the inverse verification: an unbounded-window key with a spend
  ceiling must still be denied (gov-spend-gate.test.ts) — the books cannot
  be stranded by the null-window shortcut.

## Coordination

- W179.1 (usage export, landed): the ledger's hour aggregates + the
  per-request rows are its inputs; this item changes no export contract.
- W179.3 (nightly real-upstream soak, landed): soak traffic now also
  exercises the spend book when its keys ride a capped team.
