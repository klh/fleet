// ab-effort-audit.ts — W1140.1: A/B the W1140 lane-effort policy on the
// W776 attribution ledger. Rows = terminal items (DONE + FAILED) with
// attribution; cohort = pre/post policy-live (commit 1b88d58a ts, or --since).
// Quality axis: DONE counts as a done-gate pass, FAILED a fail; review
// verdicts ride the work.review events. Spend columns mirror `work report`
// (TOKENS = fresh+cached, CACHE%, OUT/MIN over agent time); the budget
// baseline per row is the policy budget for the row's effort pin (fallback:
// the two-stage implement budget — unpinned pre-policy lanes ran implement).
import type { Database } from "bun:sqlite";
import { openStore, projectIdentity } from "../hooks/lib/govdb.ts";
import { itemAttribution } from "../hooks/lib/lane-spend.ts";
import { workTiming } from "../hooks/lib/work-timing.ts";

const POLICY_LIVE_MS = Date.parse("2026-10-22T16:51:37Z"); // commit 1b88d58a
// like-for-like: pre baseline = lanes first-claimed within this window
// before policy live (same cache era, same model mix)
const PRE_WINDOW_MS = 48 * 3_600_000;
const BUDGETS: Record<string, number> = {
	low: 100_000,
	medium: 200_000,
	high: 300_000,
};

const json = process.argv.includes("--json");
const db = openStore() as unknown as Database;
const PROJECT = projectIdentity();
const attribution = itemAttribution(db, PROJECT);
const timing = new Map(workTiming(db, PROJECT).map((t) => [t.work, t]));

const items = db
	.query(
		"SELECT id, title, state FROM work_items WHERE project = ? AND state IN ('DONE','FAILED')",
	)
	.all(PROJECT) as Array<{ id: string; title: string; state: string }>;

const reviews = new Map<string, { verdict: string; reviewer: string }[]>();
for (const r of db
	.query(
		"SELECT payload, ts FROM events WHERE project = ? AND kind = 'work.review' ORDER BY ts, id",
	)
	.all(PROJECT) as Array<{ payload: string | null; ts: number }>) {
	let work = "";
	let verdict = "";
	let reviewer = "";
	try {
		const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
		work = String(p.work ?? "");
		verdict = String(p.verdict ?? "").toUpperCase();
		const rec = p.receipt as Record<string, unknown> | undefined;
		reviewer = String(rec?.reviewer ?? p.reviewer ?? "");
	} catch {
		continue;
	}
	if (!work) continue;
	const list = reviews.get(work) ?? [];
	list.push({ verdict, reviewer });
	reviews.set(work, list);
}

interface Row {
	id: string;
	title: string;
	state: string;
	cohort: "pre" | "post";
	pinned: boolean;
	effort: string | null;
	fresh: number;
	cached: number;
	out: number;
	agentMin: number;
	reviews: { verdict: string; reviewer: string }[];
}

const rows: Row[] = [];
for (const it of items) {
	const a = attribution.get(it.id);
	const t = timing.get(it.id);
	if (!a || !t) continue;
	if (a.fresh + a.cached + a.out === 0 && a.agentMs === 0) continue; // no ride
	// like-for-like: drop pre-policy lanes older than the pre window
	if (t.firstClaim > 0 && t.firstClaim < POLICY_LIVE_MS - PRE_WINDOW_MS)
		continue;
	// Policy cohort = pin-proven dispatches: a non-medium W909 pin proves
	// the policy classified the ride (the dead W923 pin only ever read
	// medium); medium pins count as policy pins only for first claims
	// after policy live. Everything else in the pre window is baseline.
	const policyPinned =
		t.effort === "low" ||
		t.effort === "high" ||
		(t.effort === "medium" && t.firstClaim >= POLICY_LIVE_MS);
	rows.push({
		id: it.id,
		title: it.title,
		state: it.state,
		cohort: policyPinned ? "post" : "pre",
		pinned: policyPinned,
		effort: t.effort ?? null,
		fresh: a.fresh,
		cached: a.cached,
		out: a.out,
		agentMin: a.agentMs / 60_000,
		reviews: reviews.get(it.id) ?? [],
	});
}
// terminal event ts orders the A/B read; nothing here mutates the graph
rows.sort(
	(x, y) =>
		(timing.get(y.id)?.lastEvent ?? 0) - (timing.get(x.id)?.lastEvent ?? 0),
);

const fmtM = (n: number): string =>
	n >= 1e6
		? `${(n / 1e6).toFixed(1)}M`
		: n >= 1e3
			? `${Math.round(n / 1e3)}k`
			: String(n);
const pad = (s: string, n: number): string =>
	s.length >= n ? s : s + " ".repeat(n - s.length);
const padL = (s: string, n: number): string =>
	s.length >= n ? s : " ".repeat(n - s.length) + s;

if (json) {
	console.log(JSON.stringify(rows, null, 2));
} else {
	console.log(
		`${pad("ITEM", 14)}${pad("CO", 4)}${pad("EFF", 7)}${padL("FRESH", 8)}${padL("CACHED", 9)}${padL("TOTAL", 8)}${padL("BUDGET", 7)}${padL("OUT/MIN", 8)}${padL("ST", 4)}REV`,
	);
	for (const r of rows) {
		const total = r.fresh + r.cached;
		const eff = r.effort ?? "impl";
		const budget = BUDGETS[r.effort ?? "low"] ?? BUDGETS.low;
		const rev = r.reviews.length
			? r.reviews.map((v) => v.verdict || "?").join(",")
			: "-";
		console.log(
			`${pad(r.id, 14)}${pad(r.cohort, 4)}${pad(eff, 7)}${padL(fmtM(r.fresh), 8)}${padL(fmtM(r.cached), 9)}${padL(fmtM(total), 8)}${padL(fmtM(budget), 7)}${padL(r.agentMin ? String(Math.round(r.out / r.agentMin)) : "0", 8)}${padL(r.state === "DONE" ? "D" : "F", 4)}${rev}`,
		);
	}
	// Pre baseline ignores pins (pre-1140 medium pins = dead-pin artifact);
	// post groups split by effort pin; unpinned post lanes surface separately
	// (a pin-miss finding, not a baseline row).
	const agg = (cohort: "pre" | "post", eff: string | null): Row[] =>
		rows.filter(
			(r) =>
				r.cohort === cohort &&
				(cohort === "pre" || (r.effort ?? null) === (eff ?? null)) &&
				r.fresh + r.cached > 0, // zero-ride closes carry no spend signal
		);
	console.log("\nCOHORT AGGREGATES (total = fresh+cached, spend>0 rows only)");
	for (const [cohort, eff] of [
		["pre", null],
		["post", "low"],
		["post", "medium"],
		["post", "high"],
		["post", null],
	] as const) {
		const g = agg(cohort, eff);
		if (g.length === 0) continue;
		const totals = g.map((r) => r.fresh + r.cached).sort((a, b) => a - b);
		const median = totals[Math.floor(totals.length / 2)] ?? 0;
		const fresh = g.reduce((s, r) => s + r.fresh, 0);
		const cached = g.reduce((s, r) => s + r.cached, 0);
		const done = g.filter((r) => r.state === "DONE").length;
		const within = g.filter(
			(r) => r.fresh + r.cached <= (BUDGETS[r.effort ?? "low"] ?? BUDGETS.low),
		).length;
		const revPass = g.filter(
			(r) =>
				r.reviews.some((v) => v.verdict === "PASS") &&
				!r.reviews.some((v) => v.verdict !== "PASS"),
		).length;
		const label = eff ? `${cohort}/${eff}` : `${cohort}/all`;
		console.log(
			`${pad(label, 16)}n=${pad(String(g.length), 4)}median=${pad(fmtM(median), 8)}meanTotal=${pad(fmtM((fresh + cached) / g.length), 10)}fresh/item=${pad(fmtM(fresh / g.length), 10)}withinBudget=${pad(`${within}/${g.length}`, 10)}doneGate=${pad(`${done}/${g.length}`, 10)}reviewPass=${revPass}/${g.length}`,
		);
	}
}
