#!/usr/bin/env bun
// scripts/context-rightsizing-ab.ts — W1138 context-rightsizing A/B arms.
// The W1138 rightsizing pass has a landing instant; the fleet ledger
// (W776 attribution) measures lanes closed BEFORE it (old rule text) and
// AFTER it (rightsized text) — task completion, token burn per lane, cache
// share, output rate. Report tool: exit 0 always; the AFTER arm reports
// PENDING until it holds --min-n lanes, so nobody quotes a 3-lane arm as a
// verdict. No dispatch, no mutation.
// usage: bun packages/suspenders/scripts/context-rightsizing-ab.ts
//        --landing <iso> [--min-n 10] [--window-hours 72]
import { itemAttribution } from "../hooks/lib/lane-spend.ts";
import { openGovernorDb, projectIdentity } from "../hooks/lib/govdb.ts";

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

interface DoneItem {
	id: string;
	title: string;
	state: string;
	updated_at: number;
}

/** Pull one arm: DONE/FAILED items closing inside [from, to), joined to the
 *  W776 attribution as of the arm boundary. */
export const armRows = (
	db: import("bun:sqlite").Database,
	project: string,
	from: number,
	to: number,
): {
	rows: LaneArmRow[];
	agentMsTotal: number;
	done: number;
	failed: number;
} => {
	const attr = itemAttribution(db, project, to);
	const items = db
		.query(
			`SELECT id, title, state, updated_at FROM work_items
			 WHERE project = ? AND state IN ('DONE','FAILED')
			 AND updated_at >= ? AND updated_at < ?`,
		)
		.all(project, from, to) as DoneItem[];
	let agentMsTotal = 0;
	let done = 0;
	let failed = 0;
	const rows: LaneArmRow[] = [];
	for (const it of items) {
		if (it.state === "DONE") done += 1;
		else failed += 1;
		const a = attr.get(it.id);
		if (a) agentMsTotal += a.agentMs;
		const tokens = (a?.fresh ?? 0) + (a?.cached ?? 0);
		rows.push({
			work: it.id,
			tokens,
			cacheShare: tokens > 0 ? (a?.cached ?? 0) / tokens : null,
			outPerMin: a && a.agentMs > 0 ? a.out / (a.agentMs / 60_000) : null,
		});
	}
	return { rows, agentMsTotal, done, failed };
};

const usage = (): void => {
	console.log(
		"usage: context-rightsizing-ab.ts --landing <iso> [--min-n 10] [--window-hours 72]",
	);
};

const main = (): number => {
	const args = process.argv.slice(2);
	let landing = "";
	let minN = 10;
	let windowHours = 72;
	for (let i = 0; i < args.length; i += 2) {
		const flag = args[i];
		const v = args[i + 1];
		if (flag === "--landing" && typeof v === "string") landing = v;
		else if (flag === "--min-n" && typeof v === "string") minN = Number(v);
		else if (flag === "--window-hours" && typeof v === "string")
			windowHours = Number(v);
	}
	if (!landing || Number.isNaN(minN) || Number.isNaN(windowHours)) {
		usage();
		return 1;
	}
	const landingMs = Date.parse(landing);
	if (Number.isNaN(landingMs)) {
		usage();
		return 1;
	}
	const db = openGovernorDb();
	const project = projectIdentity();
	const before = armRows(
		db,
		project,
		landingMs - windowHours * 3_600_000,
		landingMs,
	);
	const after = armRows(
		db,
		project,
		landingMs,
		landingMs + windowHours * 3_600_000,
	);
	const render = (
		name: string,
		s: ArmStats,
		done: number,
		failed: number,
		rows: LaneArmRow[],
	): string => {
		const pct = (v: number | null, mul = 1): string =>
			v === null ? "-" : `${Math.round(v * 100 * mul)}`;
		const completion =
			done + failed > 0 ? Math.round((done / (done + failed)) * 100) : -1;
		const outMin =
			s.medianOutPerMin === null
				? "-"
				: `${Math.round(s.medianOutPerMin)}${zeroOutShare(rows) > 0.5 ? "*" : ""}`;
		return [
			name.padEnd(8),
			`n=${String(s.n).padStart(3)}`,
			`completion=${completion < 0 ? "-" : `${completion}%`}`,
			`med_tokens=${s.medianTokens === null ? "-" : compact(s.medianTokens)}`,
			`med_cache=${pct(s.medianCacheShare)}%`,
			`med_out_per_min=${outMin}`,
			`agent_h=${s.agentHours.toFixed(1)}`,
			`done=${done}`,
			`failed=${failed}`,
		].join(" ");
	};
	console.log(
		render(
			"BEFORE",
			armStats(before.rows, before.agentMsTotal),
			before.done,
			before.failed,
			before.rows,
		),
	);
	console.log(
		render(
			"AFTER",
			armStats(after.rows, after.agentMsTotal),
			after.done,
			after.failed,
			after.rows,
		),
	);
	const verdict =
		after.rows.length >= minN
			? "A/B COMPARABLE"
			: `AFTER ARM PENDING (n=${after.rows.length} < ${minN}) — accrues as post-landing lanes close; quote neither arm until then`;
	console.log(verdict);
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

// report tool: never a gate — process door only when run directly
if (import.meta.main) process.exit(main());
