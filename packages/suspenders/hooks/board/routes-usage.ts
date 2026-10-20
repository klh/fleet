// hooks/board/routes-usage.ts — usage surfaces: /usage /api/usage (W157 route
// module) + /api/activity-meter (W243 decant-shape meter). The fetch fragment
// moved verbatim (route order preserved by the entry's handler list); returns
// null when nothing matches.

import { usagePayload } from "../bin/usage-page-html.ts";
import { activityReport } from "../lib/activity-harvest.ts";
import { cacheDrillParams, cacheDrillReport } from "../lib/cache-drill.ts";
import { type CrossHubReport, crossHubRollup } from "../lib/cross-hub-usage.ts";
import { buildUsageReport } from "../lib/usage.ts";
import { maybeHarvest } from "../lib/usage-harvest.ts";
import { db } from "./context.ts";
import { json } from "./helpers.ts";

export async function handleUsage(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/usage") {
		// Fragments never reach the server. The tiny client redirect retains
		// legacy /usage?...#cache bookmarks as board hash state.
		return new Response(
			`<!doctype html><title>Opening Usage</title><script>
			const target = new URL('/', location.href);
			const params = new URLSearchParams(location.search);
			if (location.hash) params.set('section', location.hash.slice(1));
			target.hash = 'usage' + (params.size ? '?' + params : '');
			location.replace(target);
			</script><a href="/#usage">Open Usage</a>`,
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	// W365: cross-hub rollup rides usage APIs (TTL-cached per hub,
	// per-hub degrade — a down hub never blocks the local report).
	const crossHub = await crossHubUsageSafe(url);
	if (url.pathname === "/api/usage/view") {
		maybeHarvest(db);
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		const w = Number(url.searchParams.get("weeks") ?? 8) || 8;
		const team = url.searchParams.get("team") ?? "";
		const dept = url.searchParams.get("dept") ?? "";
		const includeDemo = url.searchParams.get("includeDemo") === "true";
		return json({
			ok: true,
			payload: JSON.parse(
				usagePayload(
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
			),
		});
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
	if (url.pathname === "/api/usage/hour") {
		// One chart bucket, with the same actor/tag/demo filters as the main
		// report. days:0 makes buildUsageReport's inclusive window one hour.
		const bucket = Number(url.searchParams.get("bucket"));
		const now = Date.now();
		if (
			!Number.isSafeInteger(bucket) ||
			bucket % 3_600_000 !== 0 ||
			bucket > Math.floor(now / 3_600_000) * 3_600_000 ||
			bucket < now - 90 * 86_400_000
		)
			return json(
				{ ok: false, error: "bucket must be an hour in the last 90 days" },
				400,
			);
		maybeHarvest(db);
		return json({
			ok: true,
			bucket,
			report: buildUsageReport(db, {
				days: 0,
				nowMs: bucket,
				team: url.searchParams.get("team") ?? "",
				dept: url.searchParams.get("dept") ?? "",
				includeDemo: url.searchParams.get("includeDemo") === "true",
			}),
		});
	}
	if (url.pathname === "/api/activity-meter") {
		// W243: the decant-shape meter as JSON — weekly activity classify,
		// context-share per lane, usage → lane → request drilldown data path
		// rides /api/usage/cache-drill below (W825).
		maybeHarvest(db);
		const w = Number(url.searchParams.get("weeks") ?? 8) || 8;
		return json({
			ok: true,
			meter: activityReport(db, { weeks: Math.min(26, Math.max(1, w)) }),
		});
	}
	if (url.pathname === "/api/usage/cache-drill") {
		// W825: buckle per-request cache drilldown — per-lane warm-cache
		// aggregates + miss-reason clusters + (lane filter) the lane's
		// per-request rows. Hubs fetched server-side with the cross-hub
		// pattern (TTL-cached, per-hub degrade); params: days, lane, model,
		// day, miss_only=1, sort, limit.
		const { days, filters } = cacheDrillParams(url);
		maybeHarvest(db);
		const local = buildUsageReport(db, { days });
		return json({
			...(await cacheDrillReport({ days, filters })),
			local_transcripts: {
				cache_read_tokens: local.totals.cr,
				requests: local.totals.rq,
				source: local.provenance?.source ?? "legacy-aggregate",
			},
		});
	}
	return null;
}

/** W365: the per-hub rollup, never fatal — any failure degrades to
 *  undefined and the views omit the panel honestly. days rides the query
 *  string (clamped in crossHubRollup). */
async function crossHubUsageSafe(
	url: URL,
): Promise<CrossHubReport | undefined> {
	try {
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		return await crossHubRollup({ days: Math.min(90, Math.max(1, d)) });
	} catch {
		return undefined;
	}
}
