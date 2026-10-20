// hooks/bin/usage-coverage-data.ts — W858.11: the /usage evidence slice —
// what the report window actually covers and how fresh its newest bucket is.
// Pure shaper (UsageReport in, display slice out) per the W652.3.1
// emitters-shape-panels pattern; <klh-usage-coverage> renders it client-side.
import { GROUPS, type UsageReport } from "../lib/usage.ts";
import type { UsageCoverageDay, UsageCoveragePanel } from "./usage-chrome.ts";

export const hourLabel = (b: number): string =>
	`${new Date(b).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// drilldown href into HOUR DETAIL: filter state preserved, hour = a bucket
const drillHref = (
	opts: { days: number; team?: string; dept?: string; includeDemo?: boolean },
	hour: number,
): string => {
	const p = new URLSearchParams();
	p.set("days", String(opts.days));
	if (opts.team) p.set("team", opts.team);
	if (opts.dept) p.set("dept", opts.dept);
	if (opts.includeDemo) p.set("includeDemo", "true");
	p.set("hour", String(hour));
	return `/usage?${p.toString()}#usage-hour`;
};

/** Coverage/freshness evidence over the report's own timeline. */
export function coverageData(
	r: UsageReport,
	opts: { days: number; team?: string; dept?: string; includeDemo?: boolean },
): UsageCoveragePanel {
	const tokAt = (p: (typeof r.timeline)[number]): number =>
		GROUPS.reduce((a, g) => a + p.groups[g], 0);
	const live = r.timeline.filter((p) => tokAt(p) > 0);
	let newest = 0;
	let longestGapH = 0;
	let gapEnd = 0;
	let run = 0;
	for (const p of r.timeline) {
		if (tokAt(p) > 0) {
			newest = p.bucket;
			if (run > longestGapH) {
				longestGapH = run;
				gapEnd = p.bucket - 3_600_000;
			}
			run = 0;
		} else run++;
	}
	if (run > longestGapH) {
		longestGapH = run;
		gapEnd = r.timeline.at(-1)?.bucket ?? 0;
	}
	const v2 = r.provenance?.source === "transcript-v2";
	// per-day rollup; drilldown href = the day's first live bucket
	const byDay = new Map<string, UsageCoverageDay>();
	for (const p of r.timeline) {
		const d = new Date(p.bucket).toISOString().slice(0, 10);
		const day = byDay.get(d) ?? { d, hoursData: 0, tok: 0 };
		const tok = tokAt(p);
		day.tok += tok;
		if (tok > 0) {
			day.hoursData++;
			if (day.href === undefined) day.href = drillHref(opts, p.bucket);
		}
		byDay.set(d, day);
	}
	const demo = r.demo;
	const demoNote =
		demo.included === true
			? "synthetic demo usage included"
			: demo.excludedActors > 0
				? `${String(demo.excludedActors)} synthetic/seed actor(s) excluded`
				: undefined;
	return {
		from: hourLabel(r.timeline[0]?.bucket ?? 0),
		to: hourLabel(r.toBucket),
		hoursTotal: r.timeline.length,
		hoursData: live.length,
		newest: newest === 0 ? "" : hourLabel(newest),
		newestAgeH:
			newest === 0 ? -1 : Math.round((r.toBucket - newest) / 3_600_000),
		longestGapH,
		gapEnd: longestGapH > 0 ? hourLabel(gapEnd) : "",
		source: v2 ? "verified transcript usage" : "legacy aggregate usage",
		demoNote,
		byDay: [...byDay.values()],
	};
}
