// hooks/lib/knowledge/kev-review.ts — hub design D7: Kev curation no longer
// fails open. The done/consult/capsule paths asked Kev with a 1.5 s budget
// against a ~40 s cold start, so most verdicts came back `unavailable` — and
// every caller treated "not noise" as "store". Now:
//   - the budget is config (SUSPENDERS_KEV_CURATION_TIMEOUT_MS, default the
//     8 s warm SLA; keepwarm owns cold starts, not the caller's timeout);
//   - `unavailable` defers the entry into kev_review (knowledge.db), never
//     into the store; the `kev-review-drain` fleet-loop task re-asks Kev and
//     routes store/review → the knowledge ingest queue, noise → dropped.
import type { Database } from "bun:sqlite";
import type {
	CurationChoice,
	CurationInput,
	CurationKind,
	KevCuration,
} from "./kev-curation.ts";

export const KEV_CURATION_DEFAULT_MS = 8000;
/** drain gives up on an entry after this many unavailable re-asks. */
export const KEV_REVIEW_MAX_ATTEMPTS = 12;

export function kevCurationTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const n = Number(env.SUSPENDERS_KEV_CURATION_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : KEV_CURATION_DEFAULT_MS;
}

/** The ONE reading of a verdict: store it now, drop it, or defer to review.
 *  `review` stores as a candidate (the human promote gate still applies);
 *  only a missing verdict defers. */
export function curationGate(
	choice: CurationChoice,
): "store" | "drop" | "defer" {
	if (choice === "noise") return "drop";
	if (choice === "unavailable") return "defer";
	return "store";
}

const DDL =
	"CREATE TABLE IF NOT EXISTS kev_review (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, reference TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, sid TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, resolution TEXT, resolved_at INTEGER, UNIQUE (kind, reference))";

export function ensureKevReview(kb: Database): void {
	kb.run(DDL);
}

/** downvote = a knowledge entry demoted by asker feedback (phase 4): it
 *  waits for a human reviewer, never for a Kev re-curation pass. */
export type ReviewKind = CurationKind | "downvote";

export interface ReviewEntry {
	kind: ReviewKind;
	reference: string;
	title: string;
	text: string;
	sid: string;
	project: string;
}

/** Defer one entry. Re-deferring the same (kind, reference) is a no-op. */
export function deferToReview(kb: Database, e: ReviewEntry): boolean {
	ensureKevReview(kb);
	return (
		kb
			.query(
				"INSERT OR IGNORE INTO kev_review (ts, kind, reference, title, text, sid, project) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				Date.now(),
				e.kind,
				e.reference,
				e.title.slice(0, 500),
				e.text.slice(0, 8000),
				e.sid,
				e.project,
			).changes > 0
	);
}

export interface DrainDeps {
	suggest: (input: CurationInput) => Promise<KevCuration>;
	enqueue: (job: {
		source: string;
		payload: string;
		domain?: string | null;
		originSid?: string | null;
	}) => Promise<number>;
	limit?: number;
	timeoutMs?: number;
}

export interface DrainOutcome {
	stored: number;
	dropped: number;
	pending: number;
	expired: number;
}

/** One drain pass over the oldest pending entries. */
export async function drainKevReview(
	kb: Database,
	deps: DrainDeps,
): Promise<DrainOutcome> {
	ensureKevReview(kb);
	const out: DrainOutcome = { stored: 0, dropped: 0, pending: 0, expired: 0 };
	const rows = kb
		.query(
			"SELECT id, kind, reference, title, text, sid, attempts FROM kev_review WHERE state = 'pending' AND kind <> 'downvote' ORDER BY id LIMIT ?",
		)
		.all(deps.limit ?? 20) as (ReviewEntry & {
		id: number;
		attempts: number;
	})[];
	const resolve = kb.query(
		"UPDATE kev_review SET state = ?, resolution = ?, resolved_at = ?, attempts = attempts + 1 WHERE id = ?",
	);
	for (const r of rows) {
		const v = await deps.suggest({
			kind: r.kind as CurationKind,
			title: r.title,
			text: r.text,
			reference: r.reference,
			timeoutMs: deps.timeoutMs ?? kevCurationTimeoutMs(),
		});
		const gate = curationGate(v.choice);
		if (gate === "defer") {
			if (r.attempts + 1 >= KEV_REVIEW_MAX_ATTEMPTS) {
				resolve.run("expired", "unavailable", Date.now(), r.id);
				out.expired++;
			} else {
				kb.query(
					"UPDATE kev_review SET attempts = attempts + 1 WHERE id = ?",
				).run(r.id);
				out.pending++;
			}
			continue;
		}
		if (gate === "store")
			await deps.enqueue({
				source: `kev-review ${r.kind} ${r.reference}`,
				payload: JSON.stringify({
					kind: r.kind,
					reference: r.reference,
					title: r.title,
					text: r.text,
					kev: v.choice,
				}),
				domain: "private",
				originSid: r.sid || null,
			});
		resolve.run(
			gate === "store" ? "stored" : "dropped",
			v.choice,
			Date.now(),
			r.id,
		);
		if (gate === "store") out.stored++;
		else out.dropped++;
	}
	return out;
}
