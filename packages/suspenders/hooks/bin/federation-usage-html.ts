// hooks/bin/federation-usage-html.ts — W171: the hub-side GLOBAL usage/aid
// dashboard — W152 renderers over the hub-stored federation rollups. Reads
// GET /federation/usage (hub-admin credential; the board fetches it
// server-side — the browser never sees the key). Aggregate-only by
// construction: the hub stores model-CLASS buckets, never names or
// content; the page degrades honestly until spokes report (default OFF
// until an operator opts teams in on the hub policy).
import { GROUPS } from "../lib/usage.ts";
import type { UsageHead } from "../board-html/klh-usage-head.ts";
// W652.3: chrome (palette/esc/fmtTok/tiles/legend/shell) rides the shared
// usage-chrome module — W171's per-page copies retired.
import {
	fmtTok,
	SLOT,
	type UsageAidsPanel,
	type UsageSeg,
	type UsageSpokesPanel,
	type UsageTile,
	usagePageShell,
} from "./usage-chrome.ts";

export interface FedPageWindow {
	bucket: number;
	team: string;
	spoke: string;
	classes: Record<string, ClassRow2>;
}

export interface ClassRow2 {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

export interface FedPageAid {
	bucket: number;
	team: string;
	spoke: string;
	aid: string;
	domain: string;
	injected: number;
	skipped: number;
	tok_injected: number;
}

export interface FedPageReport {
	days: number;
	spokes: number;
	windows: FedPageWindow[];
	aids: FedPageAid[];
}

// ─── aggregation over the rollup windows ──────────────────────────────────
const zeroGroups = (): Record<string, number> => ({
	flash: 0,
	full: 0,
	luna: 0,
	local: 0,
	other: 0,
});

/** Per-bucket totals across every spoke+team → uPlot columnar timeline
 *  [x, flash, full, luna, local, other]. */
function timelineData(r: FedPageReport): number[][] {
	const byBucket = new Map<number, Record<string, number>>();
	const keys = new Set<number>();
	for (const w of r.windows) keys.add(w.bucket);
	const sorted = [...keys].sort((a, b) => a - b);
	const xs = sorted.map((b) => Math.round(b / 1000));
	for (const w of r.windows) {
		let g = byBucket.get(w.bucket);
		if (g === undefined) {
			g = {};
			byBucket.set(w.bucket, g);
		}
		for (const [cls, m] of Object.entries(w.classes)) {
			g[cls] = (g[cls] ?? 0) + m.in_tok + m.out_tok + m.cache_r + m.cache_c;
		}
	}
	return [
		xs,
		...GROUPS.map((g) =>
			sorted.map((b) => {
				const cell = byBucket.get(b);
				return cell === undefined ? 0 : (cell[g] ?? 0);
			}),
		),
	];
}

/** Hour-of-day (LOCAL) histogram over the same totals → [0..23, tokens]. */
function byHourData(r: FedPageReport): number[][] {
	const hours = Array.from({ length: 24 }, () => 0);
	for (const w of r.windows) {
		const when = new Date(w.bucket);
		const total = Object.values(w.classes).reduce(
			(a, m) => a + m.in_tok + m.out_tok + m.cache_r + m.cache_c,
			0,
		);
		hours[when.getHours()] += total;
	}
	return [hours.map((_, i) => i), hours];
}

// ─── page sections ────────────────────────────────────────────────────────
// W652.3.1: panels ride the Lit components (board-html/usage-panels.ts) —
// the emitters shape display slices into the payload instead of building
// panel HTML strings per request.
const fedTilesData = (r: FedPageReport): UsageTile[] => {
	const byClass = zeroGroups();
	let rq = 0;
	let windows = 0;
	for (const w of r.windows) {
		windows++;
		for (const [cls, m] of Object.entries(w.classes)) {
			byClass[cls] =
				(byClass[cls] ?? 0) + m.in_tok + m.out_tok + m.cache_r + m.cache_c;
		}
		rq += Object.values(w.classes).reduce((a, m) => a + m.requests, 0);
	}
	const top = Object.entries(byClass)
		.sort((a, b) => b[1] - a[1])
		.find(([, v]) => v > 0);
	return [
		{ k: "REPORTING SPOKES", v: String(r.spokes) },
		{
			k: "TOTAL TOKENS",
			v: fmtTok(Object.values(byClass).reduce((a, b) => a + b, 0)),
		},
		{ k: "REQUESTS", v: fmtTok(rq) },
		{ k: "TOP MODEL CLASS", v: top === undefined ? "—" : top[0] },
		{ k: "WINDOWS", v: String(windows) },
	];
};

/** Page-head slice (W695.3.5): <klh-usage-head> renders title, back link,
 *  honest note and the window chips from this — no per-request head HTML. */
const headData = (r: FedPageReport, degraded: string | null): UsageHead => ({
	title: "FEDERATED USAGE",
	backHref: "/",
	backLabel: "fleet board",
	note:
		degraded === null
			? {
					kind: "win",
					text: "aggregate self-report, opt-in per team — the hub stores model-CLASS buckets only; private-domain aggregates never arrive",
				}
			: { kind: "on", text: `hub rollups unavailable: ${degraded}` },
	filters: [
		{
			label: "window",
			options: [7, 28, 90].map((dd) => ({
				label: `${String(dd)}d`,
				href: `/federation-usage?days=${String(dd)}`,
				on: dd === r.days,
			})),
		},
	],
});

/** Per-spoke slice: one row per (spoke, team), class-segmented bar. */
const spokesData = (r: FedPageReport): UsageSpokesPanel => {
	const per = new Map<
		string,
		{ team: string; classes: Record<string, number>; rq: number }
	>();
	for (const w of r.windows) {
		let row = per.get(w.spoke);
		if (row === undefined) {
			row = { team: w.team, classes: zeroGroups(), rq: 0 };
			per.set(w.spoke, row);
		}
		for (const [cls, m] of Object.entries(w.classes)) {
			row.classes[cls] =
				(row.classes[cls] ?? 0) + m.in_tok + m.out_tok + m.cache_r + m.cache_c;
			row.rq += m.requests;
		}
	}
	const maxTok = Math.max(
		1,
		...[...per.values()].map((x) =>
			Object.values(x.classes).reduce((a, b) => a + b, 0),
		),
	);
	const rows = [...per.entries()].map(([spoke, agg]) => {
		const total = Object.values(agg.classes).reduce((a, b) => a + b, 0);
		const segs: UsageSeg[] = [];
		for (const g of GROUPS) {
			const tok = agg.classes[g] ?? 0;
			if (tok === 0) continue;
			segs.push({ g, tok });
		}
		return {
			spoke,
			team: agg.team,
			barW: Math.max(2, (total / maxTok) * 100),
			segs,
			total,
			rq: agg.rq,
		};
	});
	return { rows };
};

/** Aid-ROI-over-federation slice: per aid+domain sums across spokes. */
const fedAidsData = (r: FedPageReport): UsageAidsPanel => {
	if (r.aids.length === 0)
		return {
			title: "AID ROI · FEDERATED",
			empty:
				"no aid aggregates reported yet — spokes with opted-in teams include aid_rollup sums (private-domain rows never leave the spoke)",
		};
	const per = new Map<
		string,
		{
			aid: string;
			domain: string;
			inj: number;
			skip: number;
			tok: number;
		}
	>();
	for (const a of r.aids) {
		const key = `${a.aid}|${a.domain}`;
		let row = per.get(key);
		if (row === undefined) {
			row = { aid: a.aid, domain: a.domain, inj: 0, skip: 0, tok: 0 };
			per.set(key, row);
		}
		row.inj += a.injected;
		row.skip += a.skipped;
		row.tok += a.tok_injected;
	}
	return {
		title: "AID ROI · FEDERATED",
		foot: "spoke-reported sums · private-domain rows are filtered spoke-side (domain separation)",
		rows: [...per.values()].sort((a, b) => b.tok - a.tok),
	};
};

/** The federation usage dashboard page. */
export function federationUsagePage(
	r: FedPageReport,
	opts: { degraded?: string | null } = {},
): string {
	const degraded = opts.degraded ?? null;
	// W658.4: the chart panels ride <klh-usage-charts> (the fed timeline
	// title differs — passed through); W695.3.5: the head rides <klh-usage-head>
	const timeline = `<klh-usage-charts tl="GLOBAL TOKENS · STACKED BY MODEL CLASS"></klh-usage-charts>`;
	const head = `<klh-usage-head></klh-usage-head><klh-usage-tiles></klh-usage-tiles>`;
	const payload = JSON.stringify({
		groups: GROUPS,
		slot: SLOT,
		head: headData(r, degraded),
		timeline: timelineData(r),
		byHour: byHourData(r),
		panels: {
			tiles: fedTilesData(r),
			spokes: spokesData(r),
			aids: fedAidsData(r),
		},
	});
	return usagePageShell({
		title: "FEDERATED USAGE",
		body: `${head}${timeline}<klh-usage-spokes></klh-usage-spokes><klh-usage-aids></klh-usage-aids>`,
		payload,
	});
}
