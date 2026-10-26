// review-round-cap.ts — W1303.7: the standard's review round cap ("after
// three review-and-fix rounds, the reviewer stops and asks the author to
// rethink the approach"). A round = one distinct reviewed commit whose latest
// bound receipt FAILED; transport ERROR legs are never a round. A review-repair
// child (tagged `repair` AND `review`, the graph's fix-loop shape) continues
// its parent's loop (lineage walk), so the fix child inherits the rounds
// already spent; other `repair` work starts its own count. At the cap the
// scheduler launches no reviewer and one NEED_DECISION per (item, cap) asks
// the completion author to rethink. SUSPENDERS_REVIEW_ROUND_CAP=<n> moves the
// cap; 0 disables it.
// Fail-open: the cap guards effort, never correctness — an unreadable history
// never starves the merge ladder (W1243).
import { emitStoredEvent } from "../../coord/event-publish.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { splitTags } from "../work/work-tags.ts";
import type { ReviewReceipt } from "./review-receipt.ts";

export const DEFAULT_REVIEW_ROUND_CAP = 3;
const LINEAGE_DEPTH = 8;
const HISTORY_BOUND = 200;

/** The configured cap: unset/blank/junk → 3; a non-negative integer
 * overrides; 0 disables the cap. */
export function reviewRoundCap(env: NodeJS.ProcessEnv): number {
	const raw = env.SUSPENDERS_REVIEW_ROUND_CAP?.trim();
	return raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_REVIEW_ROUND_CAP;
}

/** The item plus every ancestor it repairs, nearest first. */
export function repairLineage(
	db: GovernorStore,
	project: string,
	item: string,
): string[] {
	const lineage = [item];
	while (lineage.length < LINEAGE_DEPTH) {
		const row = db
			.query(
				"SELECT parent_id, tags FROM work_items WHERE project = ? AND id = ?",
			)
			.get(project, lineage[lineage.length - 1]) as {
			parent_id: string | null;
			tags: string | null;
		} | null;
		if (!row?.parent_id) break;
		const tags = splitTags(row.tags);
		if (!tags.includes("repair") || !tags.includes("review")) break;
		if (lineage.includes(row.parent_id)) break;
		lineage.push(row.parent_id);
	}
	return lineage;
}

/** Rounds spent across the lineage: distinct commits whose latest bound
 * receipt is FAIL (a later RESOLVED PASS on the same commit un-counts it). */
export function failedReviewRounds(
	db: GovernorStore,
	project: string,
	lineage: string[],
): number {
	const items = lineage.map(() => "?").join(", ");
	const rows = db
		.query(
			`SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') IN (${items}) ORDER BY id DESC LIMIT ${HISTORY_BOUND}`,
		)
		.all(project, ...lineage) as { payload: string }[];
	const latest = new Map<string, string>();
	for (const row of rows) {
		let receipt: Partial<ReviewReceipt>;
		try {
			receipt = JSON.parse(JSON.parse(row.payload).receipt);
		} catch {
			continue;
		}
		if (typeof receipt.commit !== "string" || receipt.verdict === "ERROR")
			continue;
		if (!latest.has(receipt.commit))
			latest.set(receipt.commit, String(receipt.verdict));
	}
	return [...latest.values()].filter((v) => v === "FAIL").length;
}

/** null = review may proceed; a string = the scheduler's refusal reason. */
export function reviewRoundCapRefusal(o: {
	db: GovernorStore;
	project: string;
	item: string;
	author: string;
	env: NodeJS.ProcessEnv;
}): string | null {
	const cap = reviewRoundCap(o.env);
	if (cap === 0) return null;
	let rounds = 0;
	try {
		rounds = failedReviewRounds(
			o.db,
			o.project,
			repairLineage(o.db, o.project, o.item),
		);
	} catch {
		return null;
	}
	if (rounds < cap) return null;
	try {
		emitRoundCapDecision(o.db, o.project, o.item, o.author, cap, rounds);
	} catch {
		// the refusal stands even when the decision event cannot be written
	}
	return `review round cap reached (${rounds} failed review rounds, cap ${cap}): reviewer stopped — rethink the approach`;
}

/** One NEED_DECISION per (item, cap) to the completion author. */
function emitRoundCapDecision(
	db: GovernorStore,
	project: string,
	item: string,
	author: string,
	cap: number,
	rounds: number,
): void {
	const prior = db
		.query(
			"SELECT id FROM events WHERE kind = 'NEED_DECISION' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') = ? AND json_extract(payload, '$.review_round_cap') = ? LIMIT 1",
		)
		.get(project, item, String(cap));
	if (prior) return;
	emitStoredEvent(db, project, {
		kind: "NEED_DECISION",
		source: "review-scheduler",
		scope: item,
		to: author,
		note: `${item}: ${rounds} review-and-fix rounds failed (cap ${cap}) — the reviewer stops here. Rethink the approach: supersede ${item} with a new plan, or raise SUSPENDERS_REVIEW_ROUND_CAP (0 disables) to buy another round.`,
		extra: {
			work: item,
			review_round_cap: String(cap),
			rounds: String(rounds),
		},
	});
}
