// hooks/board/routes-usage.ts — usage surfaces: /usage /api/usage (W157 route
// module) + /api/activity-meter (W243 decant-shape meter). The fetch fragment
// moved verbatim (route order preserved by the entry's handler list); returns
// null when nothing matches.
import { db } from "./context.ts";
import { json } from "./helpers.ts";
import { maybeHarvest } from "../lib/usage-harvest.ts";
import { activityReport } from "../lib/activity-harvest.ts";
import { buildUsageReport } from "../lib/usage.ts";
import {
	type CrossHubReport,
	crossHubRollup,
} from "../lib/cross-hub-usage.ts";
import {
	drilldownReport,
	laneRequests,
} from "../lib/cache-drilldown.ts";
import { resolveBuckleDb } from "../lib/lane-spend.ts";
import { usagePage } from "../bin/usage-page-html.ts";

export async function handleUsage(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	// W365: cross-hub rollup rides both usage routes (TTL-cached per hub,
	// per-hub degrade — a down hub never blocks the local report).
	const crossHub = await crossHubUsageSafe(url);
	if (url.pathname === "/usage") {
		// W127 phase 3: the server-rendered analytics page (same data path
		// as /api/usage: TTL-gated harvest then buildUsageReport). W243: the
		// activity meter rides the same gate and hangs its panel on the page.
		maybeHarvest(db);
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
					crossHub,
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
			crossHub,
		});
	}
	if (url.pathname === "/api/activity-meter") {
		// W243: the decant-shape meter as JSON — weekly activity classify,
		// context-share per lane, orientation-vs-implementation axis,
		// search-count normalization, pricing-shape metering. TTL-gated
		// harvest first; ?weeks=N clamps to 1..26.
		maybeHarvest(db);
		const w = Number(url.searchParams.get("weeks") ?? 8) || 8;
		return json({
			ok: true,
			meter: activityReport(db, { weeks: Math.min(26, Math.max(1, w)) }),
		});
	}
	{
		// W826: drillable cache-efficiency over the buckle ledger — summary
		// (fleet warm-rate + per-lane rows with bust heuristics) or, with
		// ?drill=<lane>, that lane's request rows. Fail-soft like every
		// ledger consumer: no readable ledger → available:false, the panel
		// renders the miss honestly.
		if (url.pathname !== "/api/usage/drilldown") return null;
		const ledger = resolveBuckleDb();
		const days = Number(url.searchParams.get("days") ?? 7) || 7;
		const model = url.searchParams.get("model") ?? "";
		const drill = url.searchParams.get("drill") ?? "";
		if (drill !== "") {
			return json({
				ok: true,
				page: laneRequests(ledger, {
					lane: drill,
					days,
					model: model || undefined,
					missOnly: url.searchParams.get("missOnly") === "1",
					limit: Number(url.searchParams.get("limit") ?? 200) || 200,
				}),
			});
		}
		const sorts = ["warm-rate", "cache-miss", "tokens", "cost", "requests"] as const;
		const sp = url.searchParams.get("sort") ?? "";
		const sort = sorts.find((s) => s === sp) ?? "warm-rate";
		return json({
			ok: true,
			report: drilldownReport(ledger, { days, model: model || undefined, sort }),
		});
	}
}

/** W365: the per-hub rollup, never fatal — any failure degrades to
 *  undefined and the views omit the panel honestly. days rides the query
 *  string (clamped in crossHubRollup). */
async function crossHubUsageSafe(url: URL): Promise<CrossHubReport | undefined> {
	try {
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		return await crossHubRollup({ days: Math.min(90, Math.max(1, d)) });
	} catch {
		return undefined;
	}
}
