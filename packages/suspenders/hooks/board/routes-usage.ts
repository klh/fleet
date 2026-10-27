// hooks/board/routes-usage.ts — usage surfaces: /usage /api/usage (W157 route
// module) + /api/activity-meter (W243 decant-shape meter). The fetch fragment
// moved verbatim (route order preserved by the entry's handler list); returns
// null when nothing matches.

import { usagePayload } from "../bin/usage-page-html.ts";
import {
	type CrossHubReport,
	crossHubRollup,
} from "../lib/federation/cross-hub-usage.ts";
import {
	type LaneWork,
	MONITOR_DIMS,
	type MonitorDim,
	monitorReport,
} from "../lib/fleet-loop/monitor-drill.ts";
import { activityReport } from "../lib/harvest/activity-harvest.ts";
import { costByModel, resolveBuckleDb } from "../lib/lanes/lane-spend.ts";
import { costSweepInputs } from "../lib/notify/cost-alerts.ts";
import {
	cacheDrillParams,
	cacheDrillReport,
} from "../lib/usage/cache-drill.ts";
import { evaluateCacheSla } from "../lib/usage/cache-sla.ts";
import {
	defaultLaneCacheLog,
	readLaneCacheLog,
	rowsInWindow,
} from "../lib/usage/cache-telemetry.ts";
import { buildUsageReport } from "../lib/usage/usage.ts";
import { maybeHarvest } from "../lib/usage/usage-harvest.ts";
import { db } from "./context.ts";
import { workAttribution } from "./tasks.ts";
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
	if (url.pathname === "/api/usage/cache-sla") {
		// W1139.1: rolling per-lane cache hit-share SLA — computed live from
		// the W458.4 lane-cache log (the sweep's same source + math); params:
		// window_min, threshold, min_requests. Fail-soft: no log → an empty
		// nodata report (a board badge never blocks the page).
		const win = Math.max(
			1,
			Number(url.searchParams.get("window_min") ?? 60) || 60,
		);
		const thrRaw = Number(url.searchParams.get("threshold") ?? 0.5);
		const threshold = Number.isFinite(thrRaw)
			? Math.min(1, Math.max(0, thrRaw))
			: 0.5;
		const minReq = Math.max(
			1,
			Number(url.searchParams.get("min_requests") ?? 5) || 5,
		);
		const log = defaultLaneCacheLog();
		const rows =
			log === null
				? []
				: rowsInWindow(readLaneCacheLog(log), Date.now() - win * 60_000);
		return json(
			evaluateCacheSla(rows, {
				windowMinutes: win,
				threshold,
				minRequests: minReq,
			}),
		);
	}
	if (url.pathname === "/api/usage/monitor") {
		// W995: the drilldown monitor — buckle ledger grouped by
		// model|provider|hub|lane with throughput/cache/failure/latency
		// aggregates + hourly uPlot series. days is the SHARED window with
		// the page (?days); the work-type join rides the W243 meter.
		const dimRaw = url.searchParams.get("dim") ?? "lane";
		const dim: MonitorDim = (MONITOR_DIMS as readonly string[]).includes(dimRaw)
			? (dimRaw as MonitorDim)
			: "lane";
		const days = Math.min(
			90,
			Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7),
		);
		maybeHarvest(db);
		const meter = activityReport(db, {
			weeks: Math.min(26, Math.max(1, Math.ceil(days / 7))),
		});
		const work: Record<string, LaneWork> = {};
		for (const ar of meter.actors)
			work[ar.actor] = {
				orient: ar.orientShare,
				context: ar.contextShare,
				spr: ar.searchesPerReq,
			};
		const local = buildUsageReport(db, { days });
		return json({
			...(await monitorReport({ days, dim, work })),
			transcripts: {
				source: local.provenance?.source ?? "legacy-aggregate",
				requests: local.totals.rq,
				cache_read_tokens: local.totals.cr,
			},
		});
	}
	if (url.pathname === "/api/usage/cost") {
		// W1132: the cost surface — hourly priced trend, per-model-group rollup
		// and per-item attribution over the buckle ledger. days clamps 1..30;
		// unpriced history reads null (unknown), never zero. Keyless lanes
		// count in trend + byModel (direct router_usage reads).
		const days = Math.min(
			30,
			Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7),
		);
		const ledger = resolveBuckleDb();
		if (!ledger) {
			return json({
				ok: true,
				ledger: null,
				days,
				trend: [],
				byModel: [],
				byItem: [],
			});
		}
		const fromBucket = `${new Date(Date.now() - days * 86_400_000)
			.toISOString()
			.slice(0, 13)}:00`;
		const byItem = Array.from(workAttribution(), ([key, a]) => ({
			id: key.split("\u0000")[1] ?? key,
			cost_usd: a.costUsd,
			requests: a.requests,
			tokens: a.fresh + a.cached + a.out,
			model_groups: a.groups,
		}))
			.sort((x, y) => (y.cost_usd ?? -1) - (x.cost_usd ?? -1))
			.slice(0, 50);
		return json({
			ok: true,
			ledger,
			days,
			trend: costSweepInputs(ledger, { days }).hours,
			byModel: costByModel(ledger, fromBucket),
			byItem,
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
