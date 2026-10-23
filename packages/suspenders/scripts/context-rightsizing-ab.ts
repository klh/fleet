#!/usr/bin/env bun
// scripts/context-rightsizing-ab.ts — W1138 context-rightsizing A/B arms.
// The W1138 rightsizing pass has a landing instant; the fleet ledger
// (W776 attribution) measures lanes CLAIMED before it (old rule text) and
// after it (rightsized text) — task completion, token burn per lane, cache
// share, output rate. Report tool: exit 0 always; the AFTER arm reports
// PENDING until it holds --min-n exposure-matched lanes. Cohort = items
// whose LAST claim falls in the arm window (the brief is minted at claim
// time — close time is NOT exposure), ALL states in the denominator, churn
// counted against completion. The tool reports arms; it never declares an
// A/B verdict comparable.
// usage: bun packages/suspenders/scripts/context-rightsizing-ab.ts
//        --landing <iso> [--min-n 10] [--window-hours 72]
import { itemAttribution } from "../hooks/lib/lane-spend.ts";
import { claimWindows } from "../hooks/lib/work-timing.ts";
import { openGovernorDb, projectIdentity } from "../hooks/lib/govdb.ts";
import { defineVerb, renderVerbHelp, runCli } from "../hooks/lib/verb-kit.ts";

/** One lane's attributed spend, normalized for arm math. */
export interface LaneArmRow {
	work: string;
	tokens: number; // fresh + cached (W776 attribution)
	cacheShare: number | null; // 0..1; null when tokens = 0
	outPerMin: number | null; // output tokens per agent-minute; null when no agent wall
}

/** The arm-level aggregate the report prints. */
export interface ArmStats {
	n: number;
	medianTokens: number | null;
	medianCacheShare: number | null;
	medianOutPerMin: number | null;
	agentHours: number;
}

/** Per-arm cohort outcome: full claim-cohort accounting — churn (claimed,
 *  not yet DONE/FAILED: released, reclaimed, still running) counts against
 *  completion. A DONE/(DONE+FAILED) survivorship rate is exactly the lie
 *  the independent review rejected (100% while churn exists). */
export interface CohortOutcome {
	rows: LaneArmRow[];
	agentMsTotal: number;
	done: number;
	failed: number;
	churn: number;
}

const median = (xs: number[]): number | null => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Aggregate lane rows into arm stats (pure — tests pin this). */
export const armStats = (
	rows: LaneArmRow[],
	agentMsTotal: number,
): ArmStats => {
	const withTokens = rows.filter((r) => r.tokens > 0);
	return {
		n: rows.length,
		medianTokens: median(withTokens.map((r) => r.tokens)),
		medianCacheShare: median(
			rows.map((r) => r.cacheShare).filter((x): x is number => x !== null),
		),
		medianOutPerMin: median(
			rows.map((r) => r.outPerMin).filter((x): x is number => x !== null),
		),
		agentHours: agentMsTotal / 3_600_000,
	};
};

/** Share of exact-zero out/min readings among measured rows — the ledger's
 *  zero-out attribution mass (rows with attribution but no out tokens).
 *  High share = the median is a floor, not a rate (W943.1 cache-floor
 *  convention, `*` in the report). */
export const zeroOutShare = (rows: LaneArmRow[]): number => {
	const vals = rows
		.map((r) => r.outPerMin)
		.filter((v): v is number => v !== null);
	if (vals.length === 0) return 0;
	return vals.filter((v) => v === 0).length / vals.length;
};

interface AttributionLike {
	fresh: number;
	cached: number;
	out: number;
	agentMs: number;
}

/** Build one arm from the exposure-matched cohort. Membership = the item's
 *  LAST claim instant falls in [from, to) — the brief the closing lane read
 *  was minted at claim time, so claim-instant is the exposure proxy (an
 *  item's close time is NOT exposure: a lane briefed pre-change can close
 *  post-change). Every state is in the cohort; churn counts against
 *  completion. Pure over replayed inputs — tests pin this. */
export const cohortArm = (
	lastClaims: { work: string; lastClaim: number }[],
	states: Map<string, string>,
	attr: Map<string, AttributionLike>,
	from: number,
	to: number,
): CohortOutcome => {
	let agentMsTotal = 0;
	let done = 0;
	let failed = 0;
	let churn = 0;
	const rows: LaneArmRow[] = [];
	for (const { work, lastClaim } of lastClaims) {
		if (lastClaim < from || lastClaim >= to) continue;
		const state = states.get(work) ?? "READY";
		if (state === "DONE") done += 1;
		else if (state === "FAILED") failed += 1;
		else churn += 1;
		const a = attr.get(work);
		if (a) agentMsTotal += a.agentMs;
		const tokens = (a?.fresh ?? 0) + (a?.cached ?? 0);
		rows.push({
			work,
			tokens,
			cacheShare: tokens > 0 ? (a?.cached ?? 0) / tokens : null,
			outPerMin: a && a.agentMs > 0 ? a.out / (a.agentMs / 60_000) : null,
		});
	}
	return { rows, agentMsTotal, done, failed, churn };
};

/** The arm's last-claim instants, replayed from the bus (lib/work-timing).
 *  An item with no claim events (auto-rollup parents) never joins a cohort. */
export const lastClaims = (
	db: import("bun:sqlite").Database,
	project: string,
): { work: string; lastClaim: number }[] => {
	const { windows } = claimWindows(db, project);
	const out: { work: string; lastClaim: number }[] = [];
	for (const [work, ws] of windows) {
		let last = 0;
		for (const w of ws) if (w.start > last) last = w.start;
		if (last > 0) out.push({ work, lastClaim: last });
	}
	return out;
};

/** Verdict line. Below the floor: PENDING, quote nothing. At the floor:
 *  MEASURED — the tool reports; comparability (matched state mix, equal
 *  exposure discipline) is judged by the reader, never declared by n alone. */
export const armVerdict = (afterN: number, minN: number): string =>
	afterN < minN
		? `AFTER ARM PENDING (n=${afterN} < ${minN}) — accrues as post-landing lanes claim; quote neither arm until then`
		: `ARMS MEASURED (AFTER n=${afterN} ≥ ${minN}) — report only: comparability needs matched state mix + exposure discipline; judge it, the tool does not declare it`;

export const spec = defineVerb({
	name: "context-rightsizing-ab",
	usage:
		"usage: context-rightsizing-ab.ts --landing <iso> [--min-n 10] [--window-hours 72]",
	flags: ["--landing", "--min-n", "--window-hours"],
	reqFlags: ["--landing"],
});

const main = (p: { flag: (n: string) => string | null }): number => {
	const landing = p.flag("--landing") ?? "";
	const minN = Number(p.flag("--min-n") ?? "10");
	const windowHours = Number(p.flag("--window-hours") ?? "72");
	if (Number.isNaN(minN) || Number.isNaN(windowHours) || minN < 1) {
		console.error(
			`context-rightsizing-ab: --min-n/--window-hours must be numbers (min-n ≥ 1), got ${p.flag("--min-n")} / ${p.flag("--window-hours")}`,
		);
		console.error(renderVerbHelp(spec));
		return 1;
	}
	const landingMs = Date.parse(landing);
	if (Number.isNaN(landingMs)) {
		console.error(
			`context-rightsizing-ab: --landing must be an ISO instant, got "${landing}"`,
		);
		console.error(renderVerbHelp(spec));
		return 1;
	}
	const db = openGovernorDb();
	const project = projectIdentity();
	const claims = lastClaims(db, project);
	const states = new Map(
		(
			db
				.query("SELECT id, state FROM work_items WHERE project = ?")
				.all(project) as { id: string; state: string }[]
		).map((r) => [r.id, r.state]),
	);
	const arm = (from: number, to: number): CohortOutcome =>
		cohortArm(claims, states, itemAttribution(db, project, to), from, to);
	const before = arm(landingMs - windowHours * 3_600_000, landingMs);
	const after = arm(landingMs, landingMs + windowHours * 3_600_000);
	const render = (name: string, s: ArmStats, c: CohortOutcome): string => {
		const pct = (v: number | null): string =>
			v === null ? "-" : `${Math.round(v * 100)}`;
		const completion = s.n > 0 ? Math.round((c.done / s.n) * 100) : -1;
		const outMin =
			s.medianOutPerMin === null
				? "-"
				: `${Math.round(s.medianOutPerMin)}${zeroOutShare(c.rows) > 0.5 ? "*" : ""}`;
		return [
			name.padEnd(8),
			`n=${String(s.n).padStart(3)}`,
			`completion=${completion < 0 ? "-" : `${completion}%`}`,
			`med_tokens=${s.medianTokens === null ? "-" : compact(s.medianTokens)}`,
			`med_cache=${pct(s.medianCacheShare)}%`,
			`med_out_per_min=${outMin}`,
			`agent_h=${s.agentHours.toFixed(1)}`,
			`done=${c.done}`,
			`failed=${c.failed}`,
			`churn=${c.churn}`,
		].join(" ");
	};
	console.log(
		"cohort = items whose LAST claim falls in the arm window (exposure proxy: the brief was minted at claim time); churn counts against completion",
	);
	console.log(
		render("BEFORE", armStats(before.rows, before.agentMsTotal), before),
	);
	console.log(render("AFTER", armStats(after.rows, after.agentMsTotal), after));
	console.log(armVerdict(after.rows.length, minN));
	if (zeroOutShare(before.rows) > 0.5 || zeroOutShare(after.rows) > 0.5)
		console.log(
			"(* = the median sits in the zero-out attribution mass — read as a floor, not a rate; W943.1)",
		);
	return 0;
};

const compact = (n: number): string =>
	n >= 1_000_000
		? `${(n / 1_000_000).toFixed(1)}M`
		: `${Math.round(n / 1000)}k`;

// report tool: never a gate — process door via the verb kit (W651: strict
// parse, unknown options die, per-verb --help)
if (import.meta.main)
	await runCli({
		prog: "context-rightsizing-ab",
		about: "W1138 rightsizing A/B arms — report, never a verdict",
		verbs: [spec],
		defaultVerb: "context-rightsizing-ab",
		dispatch: (_name, parsed) => main(parsed),
	});
