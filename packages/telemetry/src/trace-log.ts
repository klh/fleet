// Bounded, body-free read of Belt's append-only routing receipts. This is a
// diagnostic connector, not a second source of routing truth.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TRACE_ID = /^[0-9a-f]{32}$/;
const LABEL = /^[a-z][a-z0-9_-]{0,39}$/;
const CORRELATION = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 200;

export interface BeltTraceAttempt {
	source: "belt";
	ts: string;
	trace_id: string;
	request_id: string | null;
	ordinal: number;
	hop: string;
	port: number | null;
	status: number | null;
	duration_ms: number | null;
	retry_after_ms: number | null;
	failure_kind: string | null;
	upstream_call_id: string | null;
	upstream_rid: string | null;
}

export interface BeltTraceRead {
	status: "ok" | "unavailable";
	tail_truncated: boolean;
	attempts: BeltTraceAttempt[];
}

function boundedInt(v: unknown, max: number): number | null {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max
		? v
		: null;
}

function correlation(v: unknown): string | null {
	return typeof v === "string" && CORRELATION.test(v) ? v : null;
}

function attempt(v: unknown, traceId: string): BeltTraceAttempt | null {
	if (!v || typeof v !== "object") return null;
	const row = v as Record<string, unknown>;
	if (row.event !== "upstream_attempt" || row.trace_id !== traceId) return null;
	if (typeof row.ts !== "string" || !/^\d{4}-\d\d-\d\dT/.test(row.ts))
		return null;
	if (typeof row.hop !== "string" || !LABEL.test(row.hop)) return null;
	const ordinal = boundedInt(row.attempt, 1_000_000);
	if (ordinal === null) return null;
	return {
		source: "belt",
		ts: row.ts.slice(0, 32),
		trace_id: traceId,
		request_id: correlation(row.request_id),
		ordinal,
		hop: row.hop,
		port: boundedInt(row.port, 65535),
		status: boundedInt(row.status, 599),
		duration_ms: boundedInt(row.duration_ms, 3_600_000),
		retry_after_ms: boundedInt(row.retry_after_ms, 3_600_000),
		failure_kind:
			typeof row.failure_kind === "string" && LABEL.test(row.failure_kind)
				? row.failure_kind
				: null,
		upstream_call_id: correlation(row.upstream_call_id),
		upstream_rid: correlation(row.upstream_rid),
	};
}

/** Fixed-path tail read. Missing logs stay visibly unavailable; old traces
 * beyond the bounded tail are explicitly marked incomplete. */
export function readBeltTrace(path: string, traceId: string): BeltTraceRead {
	if (!TRACE_ID.test(traceId))
		return { status: "unavailable", tail_truncated: false, attempts: [] };
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { status: "unavailable", tail_truncated: false, attempts: [] };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile())
			return { status: "unavailable", tail_truncated: false, attempts: [] };
		const start = Math.max(0, stat.size - MAX_BYTES);
		const bytes = Buffer.alloc(stat.size - start);
		const count = readSync(fd, bytes, 0, bytes.length, start);
		const lines = bytes.subarray(0, count).toString("utf8").split("\n");
		if (start > 0) lines.shift(); // first line may be partial
		const attempts: BeltTraceAttempt[] = [];
		for (const line of lines) {
			if (!line?.includes(traceId)) continue;
			try {
				const parsed = attempt(JSON.parse(line) as unknown, traceId);
				if (parsed) attempts.push(parsed);
			} catch {
				// A torn final write is not an attempt receipt.
			}
		}
		return {
			status: "ok",
			tail_truncated: start > 0 || attempts.length > MAX_ROWS,
			attempts: attempts.slice(-MAX_ROWS),
		};
	} catch {
		return { status: "unavailable", tail_truncated: false, attempts: [] };
	} finally {
		closeSync(fd);
	}
}
