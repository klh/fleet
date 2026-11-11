// child-budget.ts — W2977: atomic per-child budget reservation keyed by the
// stable (parentRunId, childKey) identity, BEFORE admitting a concurrent
// wave. The ledger makes the reservation replay-safe — the same (parent,
// child) reserve is idempotent, any drift refuses — and the capacity check
// counts OUTSTANDING reservations (children without a terminal result)
// together with ALREADY SETTLED usage, so two individually affordable
// simultaneous children whose combined reservation exceeds the parent
// allowance cannot both reserve. Reconciliation (release) deletes the row
// only once the child's terminal receipt is settled — fenced cancellation
// included — so a crash anywhere in the window replays to the same budget
// state. Single-writer host + synchronous SQLite give the reserve decision
// its atomicity, the same idiom the sibling ledger modules ride.
import { z } from "zod";
import { readResults } from "./child-tracking.ts";
import type { RunnerStore } from "./store.ts";

const ReservationTokensSchema = z.strictObject({
	in: z.number().int().min(0),
	out: z.number().int().min(0),
	cached: z.number().int().min(0),
});

export const ChildReservationSchema = z.strictObject({
	version: z.literal(1),
	parentRunId: z.uuid(),
	childKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
	tokens: ReservationTokensSchema,
	at: z.number().int().positive(),
});

export type ChildReservation = z.infer<typeof ChildReservationSchema>;

export type ReserveInput = {
	parentRunId: string;
	childKey: string;
	tokens: z.infer<typeof ReservationTokensSchema>;
	at: number;
	/** The parent's delegated token allowance (in + out; cached excluded —
	 *  the same measure the post-spend assertBudget guards). */
	maxTokens: number;
};

const RESERVATIONS_DDL = `CREATE TABLE IF NOT EXISTS runner_child_reservations (
	parent_run_id TEXT NOT NULL,
	child_key TEXT NOT NULL,
	reservation_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (parent_run_id, child_key)
)`;

function ensureReservations(store: RunnerStore): void {
	store.run(RESERVATIONS_DDL);
}

export function readReservations(
	store: RunnerStore,
	parentRunId: string,
): ChildReservation[] {
	ensureReservations(store);
	const rows = store.all<{ reservation_json: string }>(
		`SELECT reservation_json FROM runner_child_reservations WHERE parent_run_id = ? ORDER BY created_at, child_key`,
		parentRunId,
	);
	return rows.map((row) =>
		ChildReservationSchema.parse(JSON.parse(row.reservation_json)),
	);
}

export interface BudgetCount {
	children: number;
	tokens: { in: number; out: number; cached: number };
}

export interface ParentBudget {
	/** Outstanding reservations — children reserved but not yet settled. */
	reserved: BudgetCount;
	/** Terminal results already settled in the tracking ledger. */
	settled: BudgetCount;
	/** reserved + settled on the in + out measure (cached excluded, the
	 *  assertBudget measure). */
	total: number;
}

const sumTokens = (
	rows: { tokens: { in: number; out: number; cached: number } }[],
): { in: number; out: number; cached: number } => {
	const tokens = { in: 0, out: 0, cached: 0 };
	for (const row of rows) {
		tokens.in += row.tokens.in;
		tokens.out += row.tokens.out;
		tokens.cached += row.tokens.cached;
	}
	return tokens;
};

export function parentBudget(
	store: RunnerStore,
	parentRunId: string,
): ParentBudget {
	const settledResults = readResults(store, parentRunId);
	const settledKeys = new Set(settledResults.map((result) => result.childKey));
	const outstanding = readReservations(store, parentRunId).filter(
		(reservation) => !settledKeys.has(reservation.childKey),
	);
	const reservedTokens = sumTokens(outstanding);
	const settledTokens = sumTokens(settledResults);
	return {
		reserved: { children: outstanding.length, tokens: reservedTokens },
		settled: { children: settledResults.length, tokens: settledTokens },
		total:
			reservedTokens.in +
			reservedTokens.out +
			settledTokens.in +
			settledTokens.out,
	};
}

function capacityOrFail(store: RunnerStore, input: ReserveInput): ParentBudget {
	const requested = input.tokens.in + input.tokens.out;
	const budget = parentBudget(store, input.parentRunId);
	if (budget.total + requested > input.maxTokens)
		throw new Error(
			`runner: parent ${input.parentRunId} budget exhausted — reserved ${budget.reserved.tokens.in + budget.reserved.tokens.out} + settled ${budget.settled.tokens.in + budget.settled.tokens.out} + requested ${requested} exceeds the allowance ${input.maxTokens}`,
		);
	return budget;
}

function replayedReserve(
	store: RunnerStore,
	reservation: ChildReservation,
): { replayed: boolean; budget: ParentBudget } | null {
	const stored = store.get<{ reservation_json: string }>(
		"SELECT reservation_json FROM runner_child_reservations WHERE parent_run_id = ? AND child_key = ?",
		reservation.parentRunId,
		reservation.childKey,
	);
	if (stored === null) return null;
	const prior = ChildReservationSchema.parse(
		JSON.parse(stored.reservation_json),
	);
	if (JSON.stringify(prior.tokens) !== JSON.stringify(reservation.tokens))
		throw new Error(
			"runner: child reservation drift — the same (parent, child) must reserve an identical budget",
		);
	return {
		replayed: true,
		budget: parentBudget(store, reservation.parentRunId),
	};
}

/** Reserve the child's budget against the parent allowance BEFORE the wave
 *  admits. Idempotent on the stable (parent, child) identity — a crash
 *  between reserve and admit replays to the same reservation; drift
 *  refuses. Refuses a fresh reservation for an already-settled child and
 *  any wave whose reserved + settled + requested exceeds the allowance. */
export function reserveChildBudget(
	store: RunnerStore,
	input: ReserveInput,
): { replayed: boolean; budget: ParentBudget } {
	ensureReservations(store);
	const reservation = ChildReservationSchema.parse({
		version: 1,
		parentRunId: input.parentRunId,
		childKey: input.childKey,
		tokens: input.tokens,
		at: input.at,
	});
	const replay = replayedReserve(store, reservation);
	if (replay !== null) return replay;
	const settled = readResults(store, input.parentRunId);
	if (settled.some((result) => result.childKey === input.childKey))
		throw new Error(
			"runner: (parent, child) already settled — a reservation cannot follow its terminal receipt",
		);
	capacityOrFail(store, input);
	store.run(
		"INSERT INTO runner_child_reservations (parent_run_id, child_key, reservation_json, created_at) VALUES (?, ?, ?, ?)",
		input.parentRunId,
		input.childKey,
		JSON.stringify(reservation),
		input.at,
	);
	// Post-reserve state: callers see the budget AS COMMITTED, not the
	// pre-insert snapshot the capacity gate judged.
	return { replayed: false, budget: parentBudget(store, input.parentRunId) };
}

/** Reconcile on terminal completion or fenced cancellation: delete the
 *  reservation once the child's terminal receipt is settled. Idempotent —
 *  a replayed release reports released=false. Refuses to free budget for
 *  a child that has NOT settled: the reservation is the only thing holding
 *  the wave's spend against the allowance while the child runs. */
export function releaseChildBudget(
	store: RunnerStore,
	input: { parentRunId: string; childKey: string },
): { released: boolean } {
	ensureReservations(store);
	const settled = readResults(store, input.parentRunId).some(
		(result) => result.childKey === input.childKey,
	);
	if (!settled)
		throw new Error(
			"runner: no terminal child result for this (parent, child) — reconciliation rides the settled receipt",
		);
	const { changes } = store.run(
		"DELETE FROM runner_child_reservations WHERE parent_run_id = ? AND child_key = ?",
		input.parentRunId,
		input.childKey,
	);
	return { released: changes > 0 };
}

/** The aggregate pre-start cap face: counts outstanding reservations and
 *  already settled usage against the parent allowance, so a wave is judged
 *  before it admits. The landed post-spend assertBudget stays the
 *  settled-side guard; this is the reservation-plane counterpart. */
export function assertReservations(
	store: RunnerStore,
	input: { parentRunId: string; maxTokens: number },
): { budget: ParentBudget } {
	const budget = parentBudget(store, input.parentRunId);
	if (budget.total > input.maxTokens)
		throw new Error(
			`runner: parent ${input.parentRunId} reservation total ${budget.total} exceeds the allowance ${input.maxTokens} — reconcile settled children`,
		);
	return { budget };
}
