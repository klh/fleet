# Fleet lifecycle launch contract

Implementation contract for W576.1, following [the control-chain review](control-chain-review-2026-10-07.md). This specification does not complete W576.1. W572 owns executor fencing; W573 owns observed, bounded dead-claim recovery. This contract routes existing callers through those authorities instead of adding another controller or ledger.

## Authority and first migration

The canonical lifecycle command owns admission, claim transitions, brief construction, credentials, executor selection, registration and cleanup. `supervise.ts` selects descendants and integrates verified results. It must not claim launch work, spawn executors, release dead owners, rewrite lane identity or keep an independent retry budget.

The first implementation replaces `supervise.ts`'s `dispatchChild` with a targeted canonical request. Keep shattering, dependency selection, conflict decisions and integration verification in the supervisor. Follow with removal of independent launch/recovery paths from fleet-loop, monitor and quota-sweep, preserving W572/W573 rather than reimplementing them.

CLI, board/GUI and other harnesses invoke the same lifecycle command. The supported canonical installer publishes the command and dependencies; callers resolve it through `SUSPENDERS_PREFIX` and the installed shim. No caller imports the CLI module's global argv state or copies private launch logic.

## Request

A targeted request has this versioned shape:

```typescript
interface LaunchRequestV1 {
  schema: "fleet.lifecycle-launch.v1";
  requestId: string;
  project: string;
  item: string;
  parent?: string;
  supervisorSid?: string;
  expectedOwner?: string;
  expectedRevision?: number;
  subtreeLimit?: number;
  requestedCapacity?: number;
  dryRun: boolean;
}
```

- `project` resolves to canonical Git-common-dir identity through configured GovernorStore. Normalize checkout/worktree/package paths to the same project and registry root.
- `requestId` is stable across transport retries. Repeating the same ID and identical request returns its durable result; conflicting content is refused. It does not authorize replay after a new work attempt.
- `item` selects exactly one item. Targeted launch cannot resume, reclaim, retire or refresh identity for unrelated lanes. Reading all reservations for admission is allowed.
- When `parent` is supplied, `item` must be a strict descendant in that same project. A supervisor cannot launch its own parent item or move sideways. `supervisorSid` identifies the decision recipient; it is not a credential or ownership grant.
- An explicit expected owner/revision is a precondition. A stale request cannot resume a transferred or renewed claim. Omitted preconditions allow authoritative selection of a fresh READY item, never takeover of another owner's claim.
- `subtreeLimit` and `requestedCapacity` can lower configured limits, not raise them. They are concurrency bounds, not execution-attempt budgets.
- Executor, hub and model choices remain existing policy/config inputs. The planner does not inject its inherited admin credentials or silently enable ungoverned mode.

The CLI adapter should expose `dispatch --item <id> --parent <root> --supervisor <sid> --json`, with project and capacity options mapping to this schema. Ordinary refill remains a planner over targeted requests. Human output goes to stderr in JSON mode; stdout contains one bounded structured result, never a prose parser contract.

## Authoritative admission transaction

The configured store owns a single atomic reservation transition. The local JSON lane registry is a read model, not the authority. A local-only count followed by a per-item lease is insufficient: two controllers can admit different items concurrently.

Within the same GovernorStore transaction:

1. Authenticate the caller and validate its operation/scope policy; resolve project identity and desired placement.
2. Read the current item, state, owner and revision. Check READY eligibility/dependencies or exact resumable ownership. FAILED, completed, owner-decision-held and unknown states are not fresh launch candidates.
3. Validate strict ancestry, bounded to 64 levels with cycle detection. Missing ancestry data is refusal/unknown, not permission.
4. Read active or uncertain admission reservations in the applicable capacity domain and subtree. UNKNOWN occupancy holds its slot. Lease expiration alone cannot prove executor death.
5. Apply configured global/placement and subtree limits. Count each logical attempt once, including preparing/registered attempts. Failed preparation releases concurrency occupancy, but does not erase a consumed durable execution reservation.
6. Validate/acquire the launch nonce and owner/revision fence; reserve one durable item attempt and capacity slot together. Return a typed refusal/defer outcome without spawning if any predicate changes.
7. Persist the scoped request, policy provenance, attempt generation, placement and supervisory recipient needed by the executor fence.

Do not run OS inspection, provider requests or executor spawn inside the store transaction. Use bounded typed observations with identity, host, birth and expiry; revalidate their applicability during reservation. Unknown/remote inspection does not authorize replacement or claim release.

After preflight, revalidate item owner/revision, ancestry, policy and reservation generation before releasing the executor to run the brief. W572's fenced wrapper must verify the same scope and nonce. A reparented item cannot retain old subtree authority solely because its work-item timestamp stayed unchanged.

## Existing seams to reuse

| Existing authority                                                                                                      | Required use/change                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/lib/launch-preflight.ts`: `acquireLaunchLease`, `ownsLaunchLease`, `renewLaunchLease`, `releaseLaunchLease`    | Preserve nonce fencing. Per-SID lease prevents duplicates; it does not implement cross-item capacity.                                                        |
| `scripts/lib/launch-fencing.ts`: `reserveLaunchIntent`, `nextReservedAttempt`, `heldLaunchItems`, `inspectLaunchIntent` | Extend this reservation boundary with request identity, scope and capacity. Keep durable item reservations and UNKNOWN holds.                                |
| W572 executor registration/fence                                                                                        | Return registration evidence only after claim/nonce ownership is durable and the wrapper identity is observed. Reuse the frozen W572 APIs; do not fork them. |
| `hooks/lib/dead-claim-recovery.ts`: observations and reservation/reset helpers                                          | Recovery callers submit owner/revision-bound observations to the shared transition. No observer unconditionally reclaims an item.                            |
| Shared lane-registry/project identity helpers                                                                           | Read registered identities across supervisor restart and package/worktree invocation. Only canonical lifecycle commands publish launch identity.             |
| Configured GovernorStore                                                                                                | Supervisor graph reads and lifecycle writes use the same authority. Remove hardcoded local-DB planning against remote claims.                                |

As reviewed, dispatch's explicit-item resume selection is already item-filtered. W572 is adding a local targeted-capacity guard. That guard is useful, but the shared transactional cross-item reservation above remains W576.1 work and must not be claimed from per-item fencing.

## Response and durable receipt

```typescript
type LaunchOutcomeV1 =
  | "registered"
  | "already-active"
  | "held-unknown"
  | "deferred-capacity"
  | "refused-scope"
  | "refused-owner"
  | "refused-policy"
  | "budget-exhausted"
  | "preparation-failed"
  | "dry-run";

interface LaunchReceiptV1 {
  schema: "fleet.lifecycle-launch-receipt.v1";
  requestId: string;
  project: string;
  item: string;
  parent?: string;
  supervisorSid?: string;
  outcome: LaunchOutcomeV1;
  reasonCode: string;
  observedAt: number;
  retryAfter?: number;
  ownerSid?: string;
  claimRevision?: number;
  attempt?: number;
  nonce?: string;
  host?: string;
  pid?: number;
  processBirth?: string;
  registryRevision?: string;
  policyVersion?: string;
}
```

Persist the result with the request/attempt in GovernorStore before responding. Do not put credentials, raw process arguments, provider secrets or arbitrary transcript text in a receipt. Identity fields may be absent for refusals; `registered` requires durable matching owner/revision, nonce, attempt and executor identity. The JSON file/view is a projection of that record.

`registered` means the governed executor was accepted and registered. It does not prove a structured tool call, productive work, tests, a commit, integration or completion. Those remain separate evidence: matching governed tool use/result/follow-up and verified work/test/commit records. A supervisor closes a parent only after its existing subtree terminal/integration checks and completion evidence, never because launch receipts succeeded.

`held-unknown` and `deferred-capacity` are durable waiting outcomes. They do not consume another work attempt by repeatedly polling/restarting the planner. `preparation-failed` distinguishes infrastructure/preflight failure from an executor that started and failed; existing reservations remain auditable.

## Budgets, recovery and operator decisions

Keep separate counters for logical execution reservations, recovery transitions and infrastructure retries, with finite policy/config bounds. Changing entrypoint, supervisor journal, SID, executor, hub or JSON registry cannot reset the item budget. Preserve the existing canonical launch default of three total reservations unless an explicit configured policy changes it.

Budget exhaustion creates the existing decision/failed-work outcome and remains blocked across every entrypoint. A FAILED reset is an explicit authorized store command with project/item, expected owner/revision, reason and decision ID where applicable. Record who reset which budget and the previous/new generation. Never delete budget facts or rewrite JSON as an implicit reset. A code-only installation or daemon restart does not clear these records.

Recovery remains one shared CAS transition with owner, state, revision, host/process identity and observation freshness. Supervisor, monitor, quota-sweep and watchdog submit observations or request it; they cannot each decide that display text, stale heartbeat or cwd absence authorizes reclaim. Preserve dirty worktrees, capsules and checkpoints when a recovery refuses or waits.

## Source migration order

1. Freeze/reuse W572/W573 APIs. Add structured targeted request/result adapters and transactional scope/capacity admission to that shared boundary.
2. Normalize supervisor project/store/registry resolution. Replace its direct claim/worktree/brief/env/spawn function with the targeted command. Await and validate receipts before recording dispatch facts.
3. Remove supervisor registry writes, cwd-based death decisions and journal retry counters. Its journal may cache escalation receipt IDs only. Let canonical launch/recovery evaluate in-scope unfinished attempts.
4. Migrate fleet-loop and monitor/quota recovery calls to the same commands; remove independent release/reclaim mutation paths rather than leaving optional alternate authorities.
5. Publish through the existing installer. Validate the installed command from a private prefix after deleting its source checkout; update CLI/GUI consumers to read the same receipts.

## Required acceptance

Use isolated processes and a shared configured store; do not restart production services.

1. Target one child with dead/live/unknown unrelated lanes present: only that child can be mutated/launched; unrelated registry identity and claims remain unchanged.
2. Reject wrong project, parent itself, sibling, missing/cyclic ancestry and reparenting between plan/admission/executor release; no unauthorized execution escapes the fence.
3. Two supervisors request the same child simultaneously: one registered attempt and durable receipt; transport retry returns the same result without a second budget reservation.
4. Two controllers target different children at global/subtree capacity one: one reservation wins, the other is deferred. Already-active/unknown preparing intents occupy capacity; double-counting does not block an otherwise available slot.
5. UNKNOWN process inspection and remote host identity hold; proven reused PID does not masquerade as that executor. Legitimate observed PID replacement preserves its attempt generation.
6. Owner transfer, same-owner renewal or nonce replacement during preparation prevents stale spawn/cleanup. Losing controller cannot release the newer claim.
7. Exercise exhausted/poisoned work through supervisor, refill, direct targeted command, fleet-loop and recovery observers: no entrypoint resets the total item budget or silently retries FAILED work.
8. Crash before registration, after registration and before receipt delivery: reconcile through W572 durable intent; no duplicate executor and no false completed-work receipt.
9. Package cwd, root cwd and worktree cwd resolve one project and registry. Remote configured store planning/writes agree; local stale DB cannot authorize work.
10. Malformed, mismatched, missing and nonzero-exit JSON responses cannot count as dispatch. Governed key/preflight failures remain typed refusals, never inherited-credential fallback.
11. Supervisor restart resumes the graph/read model and decision IDs without replaying successful launch mutation. Dirty worktrees and capsule evidence survive waiting/refusal.
12. Operator budget reset requires authorized explicit input and writes an audit receipt. Installer/OS restarts preserve budgets and pending decisions.
13. A registered canary is not closed until governed tool use/result/follow-up plus actual edits/tests/commits and integration evidence pass.

## Policy inputs still needing explicit configuration

The mechanism above is fixed; deployments must supply the capacity domain (per project/fleet plus execution placement), configured global/subtree maxima, observation TTL and bounded infrastructure retry policy. Retain existing defaults during migration and refuse unsupported/missing authority, rather than silently inventing a cross-hub capacity promise. Decision-wait policy and authorized FAILED-reset principals come from the same configured hub policy. These are runtime policy choices, not alternative source launch paths.
