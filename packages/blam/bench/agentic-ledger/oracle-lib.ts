// bench/agentic-ledger/oracle-lib.ts — the deterministic mechanical judge
// as an importable core (24 checks; controls in README.md: broken 9/24,
// reference 24/24). oracle.ts is the CLI wrapper. Keep OUTSIDE the
// evaluated worktree; a model only sees fixture/README.md and src/.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export interface OracleResult {
	score: number;
	passed: number;
	total: number;
	failures: string[];
}

let judgeNonce = 0;
/** Import URL with a per-call nonce — Bun caches modules by path, so a
 *  re-judged worktree (fixture → reference in one process) must bust it. */
const loadModule = async (
	root: string,
	name: string,
): Promise<Record<string, unknown>> => {
	judgeNonce += 1;
	const url = pathToFileURL(join(root, "src", `${name}.ts`)).href;
	return import(`${url}?judge=${judgeNonce}`) as Promise<
		Record<string, unknown>
	>;
};

export async function judgeFixture(root: string): Promise<OracleResult> {
	type Check = { name: string; ok: boolean };
	const checks: Check[] = [];
	const check = (name: string, actual: unknown, expected: unknown): void => {
		checks.push({
			name,
			ok: JSON.stringify(actual) === JSON.stringify(expected),
		});
	};

	try {
		// ---- balance.ts (8 checks) -----------------------------------------
		const { reconcileBalance } = (await loadModule(root, "balance")) as {
			reconcileBalance: (
				entries: unknown[],
				opening: number,
				cutoff: number,
			) => { settled: number; pending: number };
		};
		type Entry = {
			id: string;
			kind: "debit" | "credit" | "refund";
			amount: number;
			ts: number;
		};
		const e = (kind: Entry["kind"], amount: number, ts: number): Entry => ({
			id: `${kind}-${ts}-${amount}`,
			kind,
			amount,
			ts,
		});
		check(
			"balance-credit",
			reconcileBalance([e("credit", 100, 10)], 50, 100).settled,
			150,
		);
		check(
			"balance-debit",
			reconcileBalance([e("debit", 40, 10)], 50, 100).settled,
			10,
		);
		check(
			"balance-refund-increases",
			reconcileBalance([e("refund", 40, 10)], 50, 100).settled,
			90,
		);
		check(
			"balance-refund-plus-debit",
			reconcileBalance([e("debit", 40, 5), e("refund", 40, 6)], 50, 100)
				.settled,
			50,
		);
		check(
			"balance-cutoff-inclusive",
			reconcileBalance([e("credit", 10, 100)], 0, 100).settled,
			10,
		);
		check(
			"balance-pending-after-cutoff",
			reconcileBalance([e("credit", 10, 101)], 0, 100),
			{ settled: 0, pending: 10 },
		);
		check(
			"balance-mixed",
			reconcileBalance(
				[
					e("debit", 30, 1),
					e("credit", 80, 2),
					e("refund", 30, 3),
					e("credit", 5, 200),
				],
				100,
				100,
			),
			{ settled: 180, pending: 5 },
		);
		check("balance-empty", reconcileBalance([], 25, 100), {
			settled: 25,
			pending: 0,
		});

		// ---- sequence.ts (8 checks) ----------------------------------------
		const { findGaps, auditSequence } = (await loadModule(
			root,
			"sequence",
		)) as {
			findGaps: (observed: number[], expectedMax: number) => number[];
			auditSequence: (
				observed: number[],
				expectedMax: number,
			) => { gaps: number[]; duplicates: number[] };
		};
		check("seq-dense", findGaps([1, 2, 3], 3), []);
		check("seq-middle-gap", findGaps([1, 3], 3), [2]);
		check("seq-tail-short", findGaps([1, 2], 4), [3, 4]);
		check("seq-duplicates-not-gaps", findGaps([1, 1, 2, 3], 3), []);
		check("seq-observed-beyond-expected", findGaps([1, 2, 4], 3), [3]);
		check("seq-empty", findGaps([], 2), [1, 2]);
		check(
			"seq-audit-duplicates-sorted-asc",
			auditSequence([3, 1, 3, 2, 1], 3).duplicates,
			[1, 3],
		);
		check("seq-audit-combined", auditSequence([1, 3, 3], 4), {
			gaps: [2, 4],
			duplicates: [3],
		});

		// ---- idempotency.ts (8 checks) -------------------------------------
		const { applyPost } = (await loadModule(root, "idempotency")) as {
			applyPost: (
				posts: { key: string; ts: number; result: "applied" }[],
				post: { key: string; nowMs: number },
				windowMs: number,
				max: number,
			) => {
				outcome: "applied" | "replayed" | "expired-replay";
				posts: { key: string; ts: number; result: "applied" }[];
			};
		};
		type Stored = { key: string; ts: number; result: "applied" };
		const stored = (key: string, ts: number): Stored => ({
			key,
			ts,
			result: "applied",
		});
		{
			const r = applyPost([], { key: "k1", nowMs: 1000 }, 500, 10);
			check("idem-first-applies", r.outcome, "applied");
			check(
				"idem-first-stored",
				r.posts.map((p) => p.key),
				["k1"],
			);
		}
		check(
			"idem-replay-inside-window",
			applyPost([stored("k1", 1000)], { key: "k1", nowMs: 1400 }, 500, 10)
				.outcome,
			"replayed",
		);
		check(
			"idem-window-boundary-expired",
			applyPost([stored("k1", 1000)], { key: "k1", nowMs: 1500 }, 500, 10)
				.outcome,
			"applied",
		);
		check(
			"idem-different-key-applies",
			applyPost([stored("k1", 1000)], { key: "k2", nowMs: 1100 }, 500, 10)
				.outcome,
			"applied",
		);
		{
			const r = applyPost(
				[stored("old", 100), stored("new", 200)],
				{ key: "k3", nowMs: 300 },
				50,
				2,
			);
			check(
				"idem-evict-oldest",
				r.posts.map((p) => p.key),
				["new", "k3"],
			);
		}
		{
			const r = applyPost([stored("a", 100)], { key: "b", nowMs: 200 }, 50, 1);
			check(
				"idem-evict-single",
				r.posts.map((p) => p.key),
				["b"],
			);
		}
		check(
			"idem-expired-reapplies-not-replays",
			applyPost(
				[stored("k1", 100)],
				{ key: "k1", nowMs: 999 },
				500,
				10,
			).posts.filter((p) => p.key === "k1").length,
			2,
		);
	} catch (error) {
		checks.push({ name: "oracle-load", ok: false });
		console.error((error as Error).message);
	}

	const passed = checks.filter((c) => c.ok).length;
	const failures = checks.filter((c) => !c.ok).map((c) => c.name);
	return {
		score: passed / checks.length,
		passed,
		total: checks.length,
		failures,
	};
}

/** CLI-facing helper: run the judge and print its JSON verdict. */
export async function runOracle(
	_benchDir: string,
	worktree: string,
): Promise<OracleResult> {
	const result = await judgeFixture(worktree);
	console.log(JSON.stringify(result, null, 2));
	return result;
}
