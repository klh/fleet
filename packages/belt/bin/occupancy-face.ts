// occupancy-face.ts — W2618 belt dashboard face over the per-hub occupancy
// endpoints. Each hub's own buckle serves its aggregate (hub total +
// per-model + per-user) — no cross-hub calls; the upstream-sees-downstream
// topology (W2620 lineage). The face fetches every hub's
// GET /v1/admin/occupancy with that hub's stack token_file credential and
// degrades honestly: a hub that is down, tokenless or uncapped answers a
// null snapshot with a note, never a fabricated zero.
import { readFileSync } from "node:fs";
import { tryLoadStack } from "@klh/suspenders/hooks/lib/stack-config.ts";
import { readHubs, type HubRow } from "./hubs.ts";

export interface HubOccupancyRow {
	hub: string;
	base: string;
	report: OccupancyReportLike | null;
	note: string | null;
}

type BoundedNum = number | null;

/** Structural slice of the buckle OccupancyReport — read structurally so
 *  an upstream shape drift answers null fields, never a throw. */
export interface OccupancyReportLike {
	enabled: boolean;
	generated_ms: number;
	derived_total: number;
	totals: { current: number; max: BoundedNum; basis: string };
	models: Array<{
		model: string;
		current: number;
		max: BoundedNum;
		pct: BoundedNum;
		users: Array<{ user: string; current: number; max: BoundedNum }>;
	}>;
	gauges: {
		admitted_1m: number;
		admitted_5m: number;
		active: number;
	};
	samples: Array<{
		ts_ms: number;
		total: number;
		by_model: Record<string, number>;
	}>;
}

const isFiniteReport = (v: unknown): v is OccupancyReportLike => {
	if (v === null || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	return (
		typeof r.enabled === "boolean" &&
		typeof r.generated_ms === "number" &&
		Array.isArray(r.models) &&
		typeof r.gauges === "object" &&
		r.gauges !== null &&
		typeof r.totals === "object" &&
		r.totals !== null
	);
};

/** Fetch one hub's occupancy report. Null report + a note on any failure
 *  (down, 4xx/5xx, tokenless, non-JSON) — the board renders "unreachable"
 *  honestly instead of a fabricated zero. */
export async function hubOccupancy(
	hub: HubRow,
	tokenFile: string | null,
): Promise<HubOccupancyRow> {
	if (!tokenFile)
		return {
			hub: hub.label,
			base: hub.base,
			report: null,
			note: "no stack token_file for this hub",
		};
	let key = "";
	try {
		key = readFileSync(tokenFile, "utf8").trim();
	} catch (e) {
		return {
			hub: hub.label,
			base: hub.base,
			report: null,
			note: `token unreadable: ${String(e)}`,
		};
	}
	if (!key)
		return {
			hub: hub.label,
			base: hub.base,
			report: null,
			note: "empty token",
		};
	try {
		const response = await fetch(new URL("/v1/admin/occupancy", hub.base), {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(1500),
		});
		if (!response.ok)
			return {
				hub: hub.label,
				base: hub.base,
				report: null,
				note: `HTTP ${response.status}`,
			};
		const payload: unknown = await response.json();
		if (!isFiniteReport(payload))
			return {
				hub: hub.label,
				base: hub.base,
				report: null,
				note: "unexpected payload shape",
			};
		return { hub: hub.label, base: hub.base, report: payload, note: null };
	} catch (e) {
		return {
			hub: hub.label,
			base: hub.base,
			report: null,
			note: `unreachable: ${String(e)}`,
		};
	}
}

/** Every known hub's occupancy row: stack profiles (token_file) joined with
 *  the hubs.json candidate bases — the shape GET /api/occupancy serves. */
export async function occupancyRows(): Promise<HubOccupancyRow[]> {
	const profiles = tryLoadStack()?.hubs ?? {};
	return Promise.all(
		readHubs().map((hub) =>
			hubOccupancy(hub, profiles[hub.label.toLowerCase()]?.token_file ?? null),
		),
	);
}

/** The GET /api/occupancy body the belt dashboard serves. */
export async function occupancyApiPayload(): Promise<{
	updated: string;
	hubs: HubOccupancyRow[];
}> {
	return { updated: new Date().toISOString(), hubs: await occupancyRows() };
}
