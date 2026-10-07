// hooks/board/routes-usage.ts — usage surfaces: /usage /api/usage (W157 route
// module) + /api/activity-meter (W243 decant-shape meter). The fetch fragment
// moved verbatim (route order preserved by the entry's handler list); returns
// null when nothing matches.
import { db } from "./context.ts";
import { json } from "./helpers.ts";
import { maybeHarvest } from "../bin/usage-harvest.ts";
import {
	maybeHarvestActivity,
	activityReport,
} from "../bin/activity-harvest.ts";
import { buildUsageReport } from "../lib/usage.ts";
import { usagePage } from "../bin/usage-page-html.ts";

export async function handleUsage(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/usage") {
		// W127 phase 3: the server-rendered analytics page (same data path
		// as /api/usage: TTL-gated harvest then buildUsageReport). W243: the
		// activity meter rides the same gate and hangs its panel on the page.
		maybeHarvest(db);
		maybeHarvestActivity(db);
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		const w = Number(url.searchParams.get("weeks") ?? 8) || 8;
		const team = url.searchParams.get("team") ?? "";
		const dept = url.searchParams.get("dept") ?? "";
		const includeDemo = url.searchParams.get("includeDemo") === "true";
		return new Response(
			usagePage(
				buildUsageReport(db, {
					days: Math.min(90, Math.max(1, d)),
					team,
					dept,
					includeDemo,
				}),
				{
					days: Math.min(90, Math.max(1, d)),
					team,
					dept,
					includeDemo,
					activity: activityReport(db, {
						weeks: Math.min(26, Math.max(1, w)),
					}),
				},
			),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (url.pathname === "/api/usage") {
		// W127: Copilot-style usage analytics — TTL-gated transcript harvest
		// (usage-harvest.ts, never a daemon) then the pure report builder
		// (lib/usage.ts). ?days=N clamps to 1..90.
		maybeHarvest(db);
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		return json({
			ok: true,
			report: buildUsageReport(db, {
				days: Math.min(90, Math.max(1, d)),
				team: url.searchParams.get("team") ?? "",
				dept: url.searchParams.get("dept") ?? "",
				includeDemo: url.searchParams.get("includeDemo") === "true",
			}),
		});
	}
	if (url.pathname === "/api/activity-meter") {
		// W243: the decant-shape meter as JSON — weekly activity classify,
		// context-share per lane, orientation-vs-implementation axis,
		// search-count normalization, pricing-shape metering. TTL-gated
		// harvest first; ?weeks=N clamps to 1..26.
		maybeHarvestActivity(db);
		const w = Number(url.searchParams.get("weeks") ?? 8) || 8;
		return json({
			ok: true,
			meter: activityReport(db, { weeks: Math.min(26, Math.max(1, w)) }),
		});
	}
	return null;
}
