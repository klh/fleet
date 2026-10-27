// scripts/lib/fleet-report.ts — W899: the fleet report render for dispatch
// surfaces (lane briefs + the dispatch summary tail). ONE implementation: it
// CALLS hooks/lib/work/work-report.ts (the W892 verb's library); callers never
// re-derive the table. Fail-soft (metering doctrine: a report failure never
// kills a dispatch) with a once-per-process NOTE.
import type { Database } from "bun:sqlite";
import { openStore, projectIdentity } from "../../hooks/lib/govdb/govdb.ts";
import {
	reportRows,
	reportTableLinkOpts,
} from "../../hooks/lib/work/work-report.ts";
import { buildReportTable } from "../../hooks/lib/work/work-report-render.ts";

let noteShown = false;

/** The pure render: rows via the W892 library, table text out. The db is the
 *  loosely-typed store handle (work.ts passes the same shape). */
export const renderFleetReport = (db: Database, project: string): string =>
	buildReportTable(
		reportRows(db, project, { now: Date.now() }).rows,
		reportTableLinkOpts(),
	);

/** The env-reading wrapper for dispatch surfaces: opens the store per call
 *  (dispatch cycles are sparse), NOTE once on failure, "" never blocks. */
export const fleetReport = (repo: string): string => {
	try {
		const store = openStore();
		try {
			return renderFleetReport(
				store as unknown as Database,
				projectIdentity(repo),
			);
		} finally {
			store.close();
		}
	} catch (e) {
		if (!noteShown) {
			console.log(
				`NOTE — fleet report failed (soft): ${e instanceof Error ? e.message : String(e)}`,
			);
			noteShown = true;
		}
		return "";
	}
};
