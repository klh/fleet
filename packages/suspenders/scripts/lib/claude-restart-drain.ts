// scripts/lib/claude-restart-drain.ts — W1124.31: the restart drain guard's
// bounded COMPLETE coverage walk + audited abandoned-receipt reconciliation.
// The pre-W1124.31 guard refused on ANY status-NULL receipt (an owner
// process that died mid-flight can never settle it again) and refused every
// lane carrying >=500 receipts (a saturated 500-window can never prove
// coverage). Now: keyset pagination proves COMPLETE lane coverage within a
// bounded page budget — exhaustion is an honest coverage-unknown refusal,
// never a widened lane filter. Unsettled rows (status NULL, no reconciled
// verdict) get audited reconcile attempts through the gate; the gate's own
// proofs decide. A row the gate cannot prove dead still refuses the
// restart. Never invents a status.

export const DRAIN_PAGE_LIMIT = 500;
/** Bounded walk: 8 pages = a 4000-receipt proof ceiling; beyond that the
 *  guard honestly refuses coverage-unknown instead of paging forever. */
export const DRAIN_MAX_PAGES = 8;

/** The drain's row view of the W824 admin read (fields the guard consumes;
 *  the surface returns more). `reconciled` object = the row carries an
 *  audited abandoned verdict; null/absent = not reconciled. */
export interface DrainRow {
	rid?: string;
	lane?: string;
	ts?: string;
	trace_id?: string | null;
	status?: number | null;
	reconciled?: object | null;
}

const COVERAGE = "Restart scoped inference coverage is unknown";
const NOT_DRAINED = "Restart lane inference has not drained";

/** One page of the lane-exact inference read (newest first). */
export async function drainPage(
	front: string,
	sid: string,
	headers: Record<string, string>,
	until: string | null,
): Promise<DrainRow[]> {
	const query = new URLSearchParams({
		limit: String(DRAIN_PAGE_LIMIT),
		inference: "true",
		lane: sid,
	});
	if (until !== null) query.set("until", until);
	const response = await fetch(`${front}/v1/admin/requests?${query}`, {
		headers,
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error(COVERAGE);
	const body = (await response.json()) as { requests?: unknown };
	if (!Array.isArray(body.requests)) throw new Error(COVERAGE);
	const rows = body.requests as DrainRow[];
	// The exact-lane guard, unchanged: a row that is not this lane means the
	// server-side filter cannot be trusted — coverage is unprovable.
	if (rows.some((row) => row.lane !== sid)) throw new Error(COVERAGE);
	return rows;
}

/** ONE audited reconcile attempt for an unsettled receipt. True = freshly
 *  verdicted or already reconciled (buckle.receipt_reconciled); a gate
 *  refusal (possibly-live) or network failure leaves it unsettled. */
export async function reconcileReceipt(
	front: string,
	headers: Record<string, string>,
	row: DrainRow,
	sid: string,
): Promise<boolean> {
	if (typeof row.rid !== "string" || row.rid.length === 0) return false;
	try {
		const response = await fetch(`${front}/v1/admin/requests/reconcile`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				rid: row.rid,
				lane: sid,
				...(typeof row.trace_id === "string" ? { trace_id: row.trace_id } : {}),
				...(typeof row.ts === "string" ? { ts: row.ts } : {}),
				reason: "restart-scoped-drain",
			}),
			signal: AbortSignal.timeout(5000),
		});
		if (response.ok) return true;
		const body = (await response.json().catch(() => null)) as {
			code?: string;
		} | null;
		return (
			response.status === 409 && body?.code === "buckle.receipt_reconciled"
		);
	} catch {
		return false;
	}
}

/** The bounded keyset walk: proves COMPLETE lane coverage or throws
 *  coverage-unknown. Same-ts boundary rows are re-read at +1ms and
 *  rid-deduped, never lost. */
export async function walkCoverage(
	front: string,
	sid: string,
	headers: Record<string, string>,
): Promise<DrainRow[]> {
	const seen = new Set<string>();
	const rows: DrainRow[] = [];
	let until: string | null = null;
	let complete = false;
	for (let page = 0; page < DRAIN_MAX_PAGES; page++) {
		const pageRows = await drainPage(front, sid, headers, until);
		for (const row of pageRows) {
			if (typeof row.rid === "string") {
				if (seen.has(row.rid)) continue;
				seen.add(row.rid);
			}
			rows.push(row);
		}
		if (pageRows.length < DRAIN_PAGE_LIMIT) {
			complete = true;
			break;
		}
		const oldest = pageRows.at(-1)?.ts;
		if (typeof oldest !== "string" || Number.isNaN(Date.parse(oldest)))
			throw new Error(COVERAGE);
		until = new Date(Date.parse(oldest) + 1).toISOString();
	}
	if (!complete) throw new Error(COVERAGE);
	return rows;
}

/** The drain guard: complete coverage walk, then one audited reconcile
 *  attempt per unsettled row. Throws the two honest refusals:
 *  coverage-unknown (coverage unprovable) and not-drained (a row remains
 *  unprovably-dead). */
export async function verifyRestartDrain(
	front: string,
	sid: string,
	headers: Record<string, string>,
): Promise<void> {
	const rows = await walkCoverage(front, sid, headers);
	for (const row of rows) {
		if (row.status != null) continue;
		if (row.reconciled != null) continue;
		if (await reconcileReceipt(front, headers, row, sid)) continue;
		throw new Error(NOT_DRAINED);
	}
}
