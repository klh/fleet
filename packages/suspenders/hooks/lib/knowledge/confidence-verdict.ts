// hooks/lib/knowledge/confidence-verdict.ts — W955: the verdict/lineage half of the
// fleet confidence doctrine. W953's confidence.ts owns the value/bands/
// provenance half; this companion module owns the stamp LIFECYCLE: the
// verdict enum, ref rules, the self-downgrade/upgrade law, the append-only
// history ledger, and the contradiction chain walk. At integration the two
// modules converge (confidence.ts re-exports or inlines this file's enum —
// one STAMP_VERDICTS, zero drift).
import type { Database } from "bun:sqlite";

// lifecycle verdict (W953 addendum 2 / W955): absent = fresh
export const STAMP_VERDICTS = [
	"fresh",
	"stale",
	"confirmed",
	"retracted",
	"superseded",
	"contradicted",
] as const;

export type StampVerdict = (typeof STAMP_VERDICTS)[number];

// verdicts that carry a row out of default surfaces (filtered by default,
// never deleted — the rows stay queryable forever)
export const DEFAULT_EXCLUDED: readonly StampVerdict[] = [
	"stale",
	"superseded",
	"contradicted",
	"retracted",
];

// lineage verdicts REQUIRE ref — the superseding row / the contradicting
// evidence — so "what replaced me / what disproved me" stays one query
export const REF_REQUIRED: readonly StampVerdict[] = [
	"superseded",
	"contradicted",
];

export class VerdictError extends Error {}

export function isVerdict(v: unknown): v is StampVerdict {
	return (
		typeof v === "string" && (STAMP_VERDICTS as readonly string[]).includes(v)
	);
}

export function validateVerdict(v: unknown): StampVerdict {
	if (isVerdict(v)) return v;
	throw new VerdictError(
		`verdict must be one of [${STAMP_VERDICTS.join(" | ")}], got ${JSON.stringify(v)}`,
	);
}

// ref is optional for fresh|stale|confirmed|retracted (stale keeps its
// evidence link, retracted may link the reason); REQUIRED for superseded /
// contradicted. Returns the trimmed ref or null.
export function validateVerdictRef(
	verdict: StampVerdict,
	ref: string | null | undefined,
): string | null {
	const r = ref?.trim() ? ref.trim() : null;
	if (REF_REQUIRED.includes(verdict) && !r)
		throw new VerdictError(
			`verdict "${verdict}" requires ref — the superseding row / contradicting evidence id`,
		);
	return r;
}

// ─── transition law (verdict #47598): self-downgrade free, self-upgrade capped ─

export interface StampPoint {
	value: number;
	setter: string;
}

// any setter MAY self-downgrade (value decrease or any verdict move);
// a self-UPGRADE — the SAME setter raising past 0.7 — is refused. A raise
// at/below 0.7 stands; raises by a DIFFERENT setter are W953's family rules.
export function checkVerdictTransition(
	prev: StampPoint | null,
	next: StampPoint & { verdict: StampVerdict },
): void {
	validateVerdict(next.verdict);
	if (!prev) return;
	if (next.value <= prev.value) return; // self-downgrade — always allowed
	if (next.setter === prev.setter && next.value > 0.7)
		throw new VerdictError(
			`self-upgrade denied: ${next.setter} raised its own stamp ${prev.value} → ${next.value} — self-upgrade caps at 0.7`,
		);
}

// ─── append-only history ledger ──────────────────────────────────────────────
// Column shape mirrors confidence.ts CONFIDENCE_HISTORY_DDL (W953) so either
// module's DDL creates a table both can write. INSERT-only: nothing here
// UPDATEs or DELETEs — the full lifecycle (fresh→confirmed→stale→superseded)
// with setter+ts at every hop is the queryable truth.

export interface ConfidenceEvent {
	id: number;
	ts: number;
	tbl: string;
	rowKey: string;
	value: number;
	setter: string;
	evidence: string | null;
	verdict: StampVerdict;
	ref: string | null;
	bySid: string | null;
}

export interface ConfidenceEventInput {
	tbl: string;
	rowKey: string | number;
	value: number;
	setter: string;
	evidence?: string | null;
	verdict: StampVerdict;
	ref?: string | null;
	bySid?: string | null;
	now?: number; // test seam — real callers omit
}

export function appendConfidenceEvent(
	db: Database,
	ev: ConfidenceEventInput,
): void {
	const verdict = validateVerdict(ev.verdict);
	const ref = validateVerdictRef(verdict, ev.ref);
	db.run(
		`INSERT INTO confidence_history
			(ts, tbl, row_key, value, setter, evidence, verdict, ref, by_sid)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			ev.now ?? Date.now(),
			ev.tbl,
			String(ev.rowKey),
			ev.value,
			ev.setter,
			ev.evidence ?? null,
			verdict,
			ref,
			ev.bySid ?? null,
		],
	);
}

const EVENT_SQL = `SELECT id, ts, tbl, row_key, value, setter, evidence, verdict, ref, by_sid
	FROM confidence_history WHERE tbl = ? AND row_key = ? ORDER BY id ASC`;

function mapEvent(r: Record<string, unknown>): ConfidenceEvent {
	return {
		id: r.id as number,
		ts: r.ts as number,
		tbl: r.tbl as string,
		rowKey: r.row_key as string,
		value: r.value as number,
		setter: r.setter as string,
		evidence: (r.evidence as string | null) ?? null,
		verdict: validateVerdict(r.verdict),
		ref: (r.ref as string | null) ?? null,
		bySid: (r.by_sid as string | null) ?? null,
	};
}

// every stamp event for a row, oldest-first — the lifecycle
export function rowEvents(
	db: Database,
	tbl: string,
	rowKey: string | number,
): ConfidenceEvent[] {
	return db
		.query(EVENT_SQL)
		.all(tbl, String(rowKey))
		.map((r) => mapEvent(r as Record<string, unknown>));
}

// the row's current lifecycle state — null when never verdict-stamped
export function latestVerdict(
	db: Database,
	tbl: string,
	rowKey: string | number,
): StampVerdict | null {
	const evs = rowEvents(db, tbl, rowKey);
	return evs.length ? evs[evs.length - 1].verdict : null;
}

// chain walk — ONE query: the full lifecycle plus, derived from the same
// rows, what replaced this row (superseded refs) and what disproved it
// (contradicted refs).
export function walkChain(
	db: Database,
	tbl: string,
	rowKey: string | number,
): {
	events: ConfidenceEvent[];
	replacedBy: string[];
	contradictedBy: string[];
} {
	const events = rowEvents(db, tbl, rowKey);
	return {
		events,
		replacedBy: events
			.filter((e) => e.verdict === "superseded")
			.map((e) => e.ref ?? "")
			.filter(Boolean),
		contradictedBy: events
			.filter((e) => e.verdict === "contradicted")
			.map((e) => e.ref ?? "")
			.filter(Boolean),
	};
}

// ─── surface filter: stale-class rows hidden by default, queryable forever ───
// Splice into a surface WHERE clause; binds = [tbl, includeStale] in the
// fragment's positional order (append to the caller's bind list accordingly).
// <ROW_KEY> is substituted with the caller's row-key SQL expression — it
// MUST be table-qualified (e.g. CAST(k.id AS TEXT)): an unqualified column
// name shadow-resolves to ch.id inside the subquery and inverts the filter.
// A row with no history is visible (defaults fresh).
export function verdictFilterClause(
	rowKeySqlExpr: string,
	tbl: string,
	includeStale = false,
): { sql: string; binds: unknown[] } {
	const excluded = DEFAULT_EXCLUDED.map((v) => `'${v}'`).join(", ");
	return {
		sql: `IFNULL((SELECT ch.verdict FROM confidence_history ch
			WHERE ch.tbl = ? AND ch.row_key = ${rowKeySqlExpr}
			ORDER BY ch.id DESC LIMIT 1), 'fresh') NOT IN (${excluded}) OR ?`,
		binds: [tbl, includeStale ? 1 : 0],
	};
}
