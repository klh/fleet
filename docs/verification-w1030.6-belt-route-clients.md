# W1030.6 — Belt `/api/route` client inventory and Buckle cutover state

Verified 2026-10-22 at fleet `93dad73e`, re-verified on release `fa75bd4d`
(merge `751fe360`), lane `autow1030-6-p98b319584008df14`.
Read-only audit of every production caller of Belt `POST /api/route`, its
disposition under the single-Buckle-inference ruling
(`decision.single-buckle-inference`, owner), and the residual work.

## Caller inventory (production, suspenders)

| Caller | Site | Disposition |
| --- | --- | --- |
| knowledge distill | `hooks/lib/knowledge-ports.ts` `BuckleDistillClient` | **Cut over.** Parallel codex subagent landed `ccbe1413` (merge `2c0d6c08`): `knowledge-buckle.ts` scoped-credential resolver + `/v1/chat/completions` with `x-belt-hint`, fail-closed on missing/unscoped creds. |
| advise / decision eval | `hooks/lib/belt-chat.ts` (`beltChat`, called by `hooks/bin/advise.ts:513` `tryBeltRoute` and `hooks/board/decide-eval.ts:286`) | **Residual.** Still POSTs belt `/api/route {execute:true}`. Root directive #50500 assigns belt-chat + soak to W1030.6 ("preserve role semantics and x-belt-hint"); W1119.1's paused plan (#57192) resumes `advise.ts → buckleChat` on its shared client (`b6ef3309`). Coordination open (NEED_DECISION #57074) — no code moved to avoid a three-lane collision. |
| soak route leg | `hooks/lib/soak.ts` `routeOnce` (+ `hooks/bin/soak.ts`) | **Residual.** Still POSTs belt `/api/route {role, execute:true}`. Soak is W1119.2-owned (`hooks/lib/soak.ts` in their list); W1030.6 holds the identical cutover requirement from root #50500. Same coordination. |
| locator auth probe | `hooks/lib/belt-locate.ts` `authOk` | **Sanctioned direct.** POSTs `/api/route` with a deliberately invalid bearer; belt's auth check answers 403 before any model call — a non-inference auth discriminator, exactly the "leave non-inference Belt status probes direct" carve-out. |

Non-inference belt surfaces that stay direct per mission: `statusOnce`
(`GET /api/status`, soak), board registry/status (`hooks/board/belt.ts` via
`resolveBelt`), `review-lane.ts` repo-targeting (`route-to` CLI).

## Landed product for this item

- Knowledge leg: `ccbe1413` → main via merge `2c0d6c08`
  (`knowledge-buckle.ts`, `BuckleDistillClient`, tests
  `knowledge-buckle.test.ts`).
- Belt cloud escalation through Buckle only: W1030.5 `fbd21cbe`
  (`escalate.ts` gate-only, scoped `bksk_` mandatory, no LiteLLM fallback).

## Verification evidence (read-only, @93dad73e)

- Buckle gate: audit provenance, admission, rate-limit flow, forced-failover
  drill, route-ladder validator, gov audit chain — **46 pass / 0 fail** on release
  `fa75bd4d` (43 of those suites also passed at `93dad73e`)
  (`bun test packages/buckle/test/{audit-provenance,admission,rate-limit-flow,forced-failover-drill,route-ladder-validator,gov-audit-chain}.test.ts`).
- Client legs: belt-chat degrade contract, knowledge-buckle fail-closed,
  soak meter — **23 pass / 0 fail** on release `fa75bd4d`
  (`bun test packages/suspenders/test/{belt-chat,knowledge-buckle,soak}.test.ts`).
- W1030.5's route-ladder validator extension landed with its suite green.

## Residual execution plan (banked in the item capsule)

Strict Buckle entry for belt-chat + soak preserving role semantics and
`x-belt-hint`: resolve scoped creds (env pair `SUSPENDERS_BUCKLE_URL` +
`SUSPENDERS_BUCKLE_TOKEN`, else 0600 `~/.claude/local-llm/buckle-chat.json`
— the `knowledge-buckle.ts` posture), POST `/v1/chat/completions`
`model: "local-swarm"` + `x-belt-hint: "prefer local <role>"`; advise and
soak keep their degrade contracts (null → local fallbacks / honest RED);
locator and status probes stay direct. The belt-chat and soak code legs are
W1119.1/W1119.2-owned (both lanes CLAIMED, shared-client requirement
recorded in #57074); this item carries none of that code — the migration
must NOT fork two clients for the same wire.
