// Work item → dispatched lane → Buckle request rows. The join is by the
// dispatch intent's lane sid and Buckle's /w/<sid> attribution. Each Buckle
// row also carries its own W3C trace ID when written by a current gateway.
import type {
	BuckleRequestRow,
	HubDrillStatus,
} from "../lib/usage/cache-drill.ts";
import { cacheDrillReport } from "../lib/usage/cache-drill.ts";
import { db } from "./context.ts";

export interface WorkLane {
	sid: string;
	executor: string;
	host: string;
	state: string;
	attempt: number;
}

export interface ExecutionHop {
	at: number;
	traceId: string | null;
	phase: "model.request";
	service: string;
	hub: string;
	hop: string;
	model: string | null;
	endpoint: string | null;
	ms: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	status: "ok" | "error" | "unknown";
	requestId: string;
}

export interface WorkExecutionTrace {
	lane: WorkLane | null;
	days: number;
	hubs: Pick<HubDrillStatus, "label" | "ok" | "reason">[];
	hops: ExecutionHop[];
	limited: boolean;
}

/** Only metadata and token counts; never prompts, keys, or provider bodies. */
export function executionHops(rows: BuckleRequestRow[]): ExecutionHop[] {
	const seen = new Set<string>();
	const hops: ExecutionHop[] = [];
	for (const row of rows) {
		const key = `${row.hub ?? "unknown"}\0${row.rid}`;
		if (seen.has(key)) continue;
		seen.add(key);
		hops.push({
			at: Date.parse(row.ts),
			traceId: row.trace_id,
			phase: "model.request",
			service: "Buckle",
			hub: row.hub ?? "unknown",
			hop: row.hop,
			model: row.target_model,
			endpoint: row.target_host,
			ms: row.duration_ms,
			inputTokens: row.in_tok,
			outputTokens: row.out_tok,
			cacheReadTokens: row.cache_r,
			status: row.ok === true ? "ok" : row.ok === false ? "error" : "unknown",
			requestId: row.rid,
		});
	}
	return hops.sort((a, b) => a.at - b.at);
}

/** Separate from /api/task: remote hub reads may take seconds on a cold TTL. */
export async function executionTraceForWork(
	project: string,
	id: string,
	days: number,
): Promise<WorkExecutionTrace> {
	let lane: WorkLane | null = null;
	try {
		lane = db
			.query(
				"SELECT sid,executor,host,state,attempt FROM lane_launch_intents WHERE project = ? AND item = ?",
			)
			.get(project, id) as WorkLane | null;
	} catch {
		// A fresh Board may open before dispatch creates its intent table.
	}
	if (!lane) return { lane: null, days, hubs: [], hops: [], limited: false };
	const report = await cacheDrillReport({
		days,
		filters: { lane: lane.sid, limit: 200 },
	});
	const rows = report.lane_scope?.requests ?? [];
	return {
		lane,
		days: report.days,
		hubs: report.hubs.map(({ label, ok, reason }) => ({ label, ok, reason })),
		hops: executionHops(rows),
		limited: rows.length >= 200,
	};
}
