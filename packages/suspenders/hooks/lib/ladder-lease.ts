// ladder-lease.ts — W641: the govdb lease as the ladder's merge gate (the
// flush's selection predicate). The lane registry maps branch → item (suffix
// fallback); the graph holds the lease. blocked = item CLAIMED/RUNNING, or
// the store unreadable (lease unverifiable — the must is never merge leased
// work). result_sha is the closure sha from `work done --sha`; flush
// verification resolves it (`rev-parse <sha>^{commit}`) and compares to the
// branch head.
import { readLaneRegistry } from "./lane-registry.ts";
import { openStore, projectIdentity } from "./govdb.ts";

export type ClaimView = {
	item: string;
	blocked: boolean;
	reason: string;
	state: string | null;
	resultSha: string | null;
};

// one branch → its item's lease state, tri-state by store health
export function itemClaimOf(repo: string, b: string): ClaimView {
	const registry = readLaneRegistry<{ branch: string; item: string }>(repo);
	const entry = registry.known
		? registry.lanes.find((row) => row.branch === b)
		: undefined;
	const item = entry?.item ?? b.split("/").at(-1);
	try {
		const store = openStore();
		try {
			const row = store
				.query(
					"SELECT state, result_sha FROM work_items WHERE project = ? AND id = ?",
				)
				.get(projectIdentity(repo), item) as
				| { state: string; result_sha: string | null }
				| undefined;
			if (!row)
				return {
					item,
					blocked: false,
					reason: `item ${item} unknown to the graph`,
					state: null,
					resultSha: null,
				};
			const leased = ["CLAIMED", "RUNNING"].includes(row.state);
			return {
				item,
				blocked: leased,
				reason: leased
					? `item ${item} is ${row.state}; the claim owns the branch`
					: "",
				state: row.state,
				resultSha: row.result_sha,
			};
		} finally {
			store.close();
		}
	} catch {
		return {
			item,
			blocked: true,
			reason: "govdb lease unverifiable: store unreadable",
			state: null,
			resultSha: null,
		};
	}
}
