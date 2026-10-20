// A versioned, observation-backed graph. A trace counts once even when it
// crosses several Buckle hubs; missing trace or usage is explicit coverage.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { NetworkDbPaths } from "./network-read-model.ts";

const WINDOW_MS = 15 * 60_000;
const TRACE_DETAIL_CAP = 200;
const TRACE_ID = /^[0-9a-f]{32}$/;

interface EdgeRecord {
	source: string;
	rid: string;
	traceparent: string;
	admitted_at: number;
	ended_at: number | null;
	outcome: string | null;
	origin: string;
	peer: string | null;
}

interface UsageRecord {
	rid: string;
	trace_id: string | null;
	ts: string;
	ok: number | null;
	hop: string | null;
	target_kind: string | null;
	target_host: string | null;
	target_port: number | null;
	in_tok: number | null;
	out_tok: number | null;
}

export interface TopologySnapshot {
	ok: true;
	schemaVersion: 1;
	observedAt: string;
	windowStart: string;
	hubs: Array<{
		id: string;
		name: string;
		lastSeenAt: string;
		freshnessS: number;
	}>;
	targets: Array<{
		id: string;
		kind: string;
		host: string;
		port: number | null;
		lastSeenAt: string;
	}>;
	edges: Array<{
		id: string;
		from: string;
		to: string;
		requests: number;
		failed: number;
		active: number;
		inputTokens: number | null;
		outputTokens: number | null;
		coverage: {
			source: "projection" | "local-origin-ledger";
			usageBearingRequests: number;
		};
		lastSeenAt: string;
		evidence: "trace" | "peer" | "ledger";
	}>;
	traces: Array<{
		id: string;
		hops: string[];
		complete: boolean;
		lastSeenAt: string;
	}>;
	totals: {
		requests: number;
		failed: number;
		active: number;
		inputTokens: number | null;
		outputTokens: number | null;
	};
	coverage: {
		projectionAvailable: boolean;
		projectionTruncated: boolean;
		ledgerAvailable: boolean;
		observedHops: number;
		tracedHops: number;
		usageBearingOrigins: number;
		tracesReturned: number;
		tracesTotal: number;
		ledgerOnlyRequests: number;
		/** Never describe local-ledger usage as estate-wide coverage. */
		tokensScope: "local-origin-ledger" | "unavailable";
	};
}

export type TopologyResult = TopologySnapshot | { ok: false; reason: string };

function hubName(source: string): string {
	const match = /^buckle:\/\/([^/]+)\//.exec(source);
	return match?.[1] ?? source;
}

function traceId(traceparent: string): string | null {
	const id = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(
		traceparent,
	)?.[1];
	return id && TRACE_ID.test(id) && id !== "0".repeat(32) ? id : null;
}

/** Peer markers give causal order even when hub clocks disagree. A partial
 * chain falls back to admission time and remains marked incomplete. */
function orderHops(rows: EdgeRecord[]): { hops: string[]; linked: boolean } {
	const pending = [...rows];
	const ordered: string[] = [];
	let next = pending.findIndex((row) => !row.peer);
	const hasRoot = next >= 0;
	if (next < 0) next = 0;
	while (pending.length > 0) {
		const row = pending.splice(next, 1)[0];
		if (!row) break;
		const hub = hubName(row.source);
		ordered.push(hub);
		next = pending.findIndex((candidate) => candidate.peer === hub);
		if (next < 0) break;
	}
	return { hops: ordered, linked: hasRoot && pending.length === 0 };
}

function readRows(
	path: string,
	sql: string,
	since: string | number,
): unknown[] {
	const db = new Database(path, { readonly: true });
	try {
		return db.query(sql).all(since);
	} finally {
		db.close();
	}
}

export function topologySnapshot(
	paths: NetworkDbPaths,
	now: () => number = Date.now,
	localHub = "local",
): TopologyResult {
	const at = now();
	const since = at - WINDOW_MS;
	let records: EdgeRecord[] = [];
	let projectionAvailable = false;
	let projectionTruncated = false;
	if (paths.obsDb && existsSync(paths.obsDb)) {
		try {
			const fetched = readRows(
				paths.obsDb,
				`SELECT source, rid, traceparent, admitted_at, ended_at, outcome,
				origin, peer FROM request_edges WHERE admitted_at >= ?
				ORDER BY admitted_at, source, rid LIMIT 10001`,
				since,
			) as EdgeRecord[];
			projectionTruncated = fetched.length > 10000;
			records = fetched.slice(0, 10000);
			projectionAvailable = true;
		} catch {
			// A readable local ledger still yields observed target edges.
		}
	}
	const hubs = new Map<string, number>();
	const edges = new Map<
		string,
		{
			from: string;
			to: string;
			traces: Set<string>;
			failed: Set<string>;
			active: Set<string>;
			inputTokens: number;
			outputTokens: number;
			usageBearingRequests: Set<string>;
			last: number;
			evidence: "trace" | "peer" | "ledger";
		}
	>();
	const targets = new Map<
		string,
		{ kind: string; host: string; port: number | null; last: number }
	>();
	const traces = new Map<string, { rows: EdgeRecord[]; last: number }>();
	let tracedHops = 0;
	for (const row of records) {
		const atRow = row.admitted_at;
		const hub = hubName(row.source);
		hubs.set(hub, Math.max(hubs.get(hub) ?? 0, atRow));
		const id = traceId(row.traceparent) ?? `untraced:${hub}:${row.rid}`;
		if (!id.startsWith("untraced:")) tracedHops++;
		const trace = traces.get(id) ?? { rows: [], last: 0 };
		trace.rows.push(row);
		trace.last = Math.max(trace.last, atRow);
		traces.set(id, trace);
		if (row.peer) {
			const from = row.peer;
			hubs.set(from, Math.max(hubs.get(from) ?? 0, atRow));
			const key = `${from}\u0000${hub}`;
			const edge = edges.get(key) ?? {
				from,
				to: hub,
				traces: new Set<string>(),
				failed: new Set<string>(),
				active: new Set<string>(),
				inputTokens: 0,
				outputTokens: 0,
				usageBearingRequests: new Set<string>(),
				last: 0,
				evidence: "trace" as const,
			};
			edge.traces.add(id);
			if (row.outcome === "errored" || row.outcome === "denied")
				edge.failed.add(id);
			if (row.ended_at === null) edge.active.add(id);
			edge.last = Math.max(edge.last, atRow);
			if (id.startsWith("untraced:")) edge.evidence = "peer";
			edges.set(key, edge);
		}
	}
	let usage: UsageRecord[] = [];
	let ledgerAvailable = false;
	if (existsSync(paths.ledger)) {
		try {
			usage = readRows(
				paths.ledger,
				`SELECT rid, trace_id, ts, ok, hop, target_kind, target_host,
				target_port, in_tok, out_tok FROM route_audit
				WHERE ts >= ? AND hop = 'origin'`,
				new Date(since).toISOString(),
			) as UsageRecord[];
			ledgerAvailable = true;
		} catch {
			// Old or unavailable ledgers leave token totals unknown.
		}
	}
	if (!projectionAvailable && !ledgerAvailable)
		return {
			ok: false,
			reason: "hub observations and local ledger unavailable",
		};
	const ledgerTraceIds = new Set<string>();
	const ledgerFailedIds = new Set<string>();
	const ledgerActiveIds = new Set<string>();
	for (const row of usage) {
		const id =
			row.trace_id && TRACE_ID.test(row.trace_id)
				? row.trace_id
				: `untraced:${localHub}:${row.rid}`;
		ledgerTraceIds.add(id);
		if (row.ok === 0) ledgerFailedIds.add(id);
		if (row.ok === null) ledgerActiveIds.add(id);
		if (!row.target_kind || !row.target_host) continue;
		const key = `${row.target_kind}:${row.target_host}:${row.target_port ?? ""}`;
		const last = Date.parse(row.ts);
		if (!Number.isFinite(last)) continue;
		targets.set(key, {
			kind: row.target_kind,
			host: row.target_host,
			port: row.target_port,
			last: Math.max(targets.get(key)?.last ?? 0, last),
		});
		const edgeKey = `${localHub}\u0000target:${key}`;
		const edge = edges.get(edgeKey) ?? {
			from: localHub,
			to: `target:${key}`,
			traces: new Set<string>(),
			failed: new Set<string>(),
			active: new Set<string>(),
			inputTokens: 0,
			outputTokens: 0,
			usageBearingRequests: new Set<string>(),
			last: 0,
			evidence: "ledger" as const,
		};
		edge.traces.add(id);
		if (row.ok === 0) edge.failed.add(id);
		if (row.ok === null) edge.active.add(id);
		if (row.ok === 1 && row.in_tok !== null && row.out_tok !== null) {
			edge.inputTokens += row.in_tok;
			edge.outputTokens += row.out_tok;
			edge.usageBearingRequests.add(id);
		}
		edge.last = Math.max(edge.last, last);
		edges.set(edgeKey, edge);
		hubs.set(localHub, Math.max(hubs.get(localHub) ?? 0, last));
	}
	const knownUsage = usage.filter(
		(row) => row.ok === 1 && row.in_tok !== null && row.out_tok !== null,
	);
	const traceRows = [...traces.entries()].map(([id, trace]) => {
		const { hops, linked } = orderHops(trace.rows);
		return {
			id,
			hops: [...new Set(hops)],
			complete:
				linked &&
				trace.rows.every(
					(row) => row.ended_at !== null && row.outcome !== "unknown",
				),
			lastSeenAt: new Date(trace.last).toISOString(),
		};
	});
	return {
		ok: true,
		schemaVersion: 1,
		observedAt: new Date(at).toISOString(),
		windowStart: new Date(since).toISOString(),
		hubs: [...hubs.entries()].map(([name, last]) => ({
			id: `hub:${name}`,
			name,
			lastSeenAt: new Date(last).toISOString(),
			freshnessS: Math.max(0, Math.floor((at - last) / 1000)),
		})),
		targets: [...targets.entries()].map(([key, target]) => ({
			id: `target:${key}`,
			kind: target.kind,
			host: target.host,
			port: target.port,
			lastSeenAt: new Date(target.last).toISOString(),
		})),
		edges: [...edges.values()].map((edge) => ({
			id: `edge:${edge.from}->${edge.to}`,
			from: `hub:${edge.from}`,
			to: edge.to.startsWith("target:") ? edge.to : `hub:${edge.to}`,
			requests: edge.traces.size,
			failed: edge.failed.size,
			active: edge.active.size,
			inputTokens: edge.usageBearingRequests.size ? edge.inputTokens : null,
			outputTokens: edge.usageBearingRequests.size ? edge.outputTokens : null,
			coverage: {
				source:
					edge.evidence === "ledger" ? "local-origin-ledger" : "projection",
				usageBearingRequests: edge.usageBearingRequests.size,
			},
			lastSeenAt: new Date(edge.last).toISOString(),
			evidence: edge.evidence,
		})),
		traces: traceRows
			.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
			.slice(0, TRACE_DETAIL_CAP),
		totals: {
			requests: new Set([...traces.keys(), ...ledgerTraceIds]).size,
			failed: new Set([
				...ledgerFailedIds,
				...traceRows
					.filter((trace) =>
						traces
							.get(trace.id)
							?.rows.some(
								(row) => row.outcome === "errored" || row.outcome === "denied",
							),
					)
					.map((trace) => trace.id),
			]).size,
			active: new Set([
				...ledgerActiveIds,
				...traceRows
					.filter((trace) =>
						traces.get(trace.id)?.rows.some((row) => row.ended_at === null),
					)
					.map((trace) => trace.id),
			]).size,
			inputTokens: knownUsage.length
				? knownUsage.reduce((n, row) => n + (row.in_tok ?? 0), 0)
				: null,
			outputTokens: knownUsage.length
				? knownUsage.reduce((n, row) => n + (row.out_tok ?? 0), 0)
				: null,
		},
		coverage: {
			projectionAvailable,
			projectionTruncated,
			ledgerAvailable,
			observedHops: records.length,
			tracedHops,
			usageBearingOrigins: knownUsage.length,
			tracesReturned: Math.min(traceRows.length, TRACE_DETAIL_CAP),
			tracesTotal: traceRows.length,
			ledgerOnlyRequests: [...ledgerTraceIds].filter((id) => !traces.has(id))
				.length,
			tokensScope: ledgerAvailable ? "local-origin-ledger" : "unavailable",
		},
	};
}
