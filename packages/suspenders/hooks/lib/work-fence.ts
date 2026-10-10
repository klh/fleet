// W609 — claim-epoch fencing: a state transition CASes the FULL claim
// identity — the state and owner as read by the caller PLUS the epoch minted
// at take — so a zombie writer (its guard read raced a reclaim + re-take)
// writes nothing instead of clobbering the replacement lane's claim. The
// epoch is minted by `work take` (claim_epoch = claim_epoch + 1) and rides
// the lane env (CLAIM_EPOCH_ENV) + brief; the manual (human, unfenced) path
// omits it and degrades to the owner+state CAS. release/reclaim stay on
// releaseWorkClaim's own CAS (work-release.ts) — already fenced.
import type { GovernorStore } from "./govdb.ts";

export const CLAIM_EPOCH_ENV = "KLH_CLAIM_EPOCH";

export type Fence = {
	project: string;
	id: string;
	/** the state(s) the transition may fire from — the caller's observed read */
	states: string[];
	/** the owner of record at the caller's read (IS-match, NULL-safe) */
	owner: string | null;
	/** the epoch the CLAIMING lane was minted; null = unfenced manual path */
	epoch: number | null;
};

export type Mutation = {
	state: string;
	/** undefined = keep current owner (start), null = clear (done) */
	owner?: string | null;
	sha?: string | null;
};

export type TransitionResult = { ok: true } | { ok: false; message: string };

/** Parse the epoch a caller presents for its claim: --claim-epoch flag with
 * KLH_CLAIM_EPOCH env fallback. null = absent = unfenced manual path; a
 * present-but-unparseable value is loud, never silently unfenced. */
export const fenceEpoch = (
	flagVal: string | null,
	fallback: string | undefined,
	die: (m: string) => never,
): number | null => {
	const raw = flagVal ?? fallback ?? "";
	if (!raw) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0)
		die(
			`invalid claim epoch "${raw}" — --claim-epoch takes a non-negative integer (${CLAIM_EPOCH_ENV} rides the lane env)`,
		);
	return n;
};

/** The fence a work.ts verb builds from its observed item read + the external
 * epoch (flag/env). states = [as-read]: the row must look EXACTLY as it did
 * when the caller read it, or the write is refused. */
export const fenceOf = (
	project: string,
	it: { id: unknown; state: unknown; owner_sid: unknown },
	epoch: number | null,
): Fence => ({
	project,
	id: String(it.id),
	states: [String(it.state)],
	owner: (it.owner_sid as string | null) ?? null,
	epoch,
});

/** Guarded transition: one UPDATE, CAS on the full fence. changes===1 = the
 * write landed; 0 = the claim moved under us — the message names expected vs
 * actual for a loud non-zero exit at the call site. */
export function transition(
	store: GovernorStore,
	expected: Fence,
	to: Mutation,
): TransitionResult {
	const sets = ["state = ?", "updated_at = ?"];
	const vals: (string | number | null)[] = [to.state, Date.now()];
	if (to.owner !== undefined) {
		sets.push("owner_sid = ?");
		vals.push(to.owner);
	}
	if (to.sha !== undefined) {
		sets.push("result_sha = ?");
		vals.push(to.sha);
	}
	const where = [
		"project = ?",
		"id = ?",
		`state IN (${expected.states.map(() => "?").join(", ")})`,
		// IS matches the NULL owner of unclaimed rows without an OR branch
		"owner_sid IS ?",
	];
	const wvals: (string | number | null)[] = [
		expected.project,
		expected.id,
		...expected.states,
		expected.owner,
	];
	if (expected.epoch != null) {
		where.push("claim_epoch = ?");
		wvals.push(expected.epoch);
	}
	const changed = store
		.query(
			`UPDATE work_items SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`,
		)
		.run(...vals, ...wvals);
	// truthy, never ===1: the deltas AFTER-UPDATE trigger inflates
	// sqlite3_changes (1 row + its delta row = 2) — a strict check would
	// misread every successful CAS as a loss (W609, measured)
	if (Number(changed.changes) >= 1) return { ok: true };
	const cur = store
		.query(
			"SELECT state, owner_sid, claim_epoch FROM work_items WHERE project = ? AND id = ?",
		)
		.get(expected.project, expected.id) as
		| { state: string; owner_sid: string | null; claim_epoch: number }
		| undefined;
	const found = cur
		? `state=${cur.state} owner=${cur.owner_sid ?? "none"} epoch=${cur.claim_epoch}`
		: "<gone>";
	return {
		ok: false,
		message:
			`${expected.id} transition to ${to.state} fenced off: expected ` +
			`state IN {${expected.states.join(", ")}} owner=${expected.owner ?? "none"}` +
			`${expected.epoch != null ? ` epoch=${expected.epoch}` : ""}, found ${found} — ` +
			`the claim was reclaimed or re-taken mid-flight; re-read \`work show ${expected.id}\` before acting`,
	};
}

/** transition + loud non-zero exit at the CLI boundary (die is injected —
 * the lib stays process-clean for tests). */
export function transitionOrDie(
	store: GovernorStore,
	expected: Fence,
	to: Mutation,
	die: (m: string) => never,
): void {
	const r = transition(store, expected, to);
	if (!r.ok) die(r.message);
}

/** The brief line carrying the fence to a dispatched lane. */
export const fenceBriefLine = (item: string, epoch: number): string =>
	`CLAIM FENCE: ${item} claimed at claim_epoch=${epoch} — done/fail/start compare-and-set on it; pass --claim-epoch ${epoch} (or ${CLAIM_EPOCH_ENV} in the lane env) when closing, a stale epoch is refused loudly`;
