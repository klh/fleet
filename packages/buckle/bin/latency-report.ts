// bin/latency-report.ts — W2247/W2247.1 CLI face: renders the request-size
// vs headers/first-body latency report from a buckle ledger (read-only,
// never writes).
//
//	bun bin/latency-report.ts [--db PATH]
//
// Default db rides defaultDbPath() (BUCKLE_DB or the runtime home). The
// diagnosis this tool banks (HEADERS metric, r ≈ -0.06 over 132k attempts,
// 2026-10-29): large request bodies are NOT the headers-time driver; the
// tail is non-streaming generation time. firstBodyByteMs is rendered
// separately from observed values only — see docs/design/w2247-*.md.
import { Database } from "bun:sqlite";
import {
	latencyReport,
	renderReport,
	type LatencyRow,
} from "../src/latency-report.ts";
import { defaultDbPath } from "../src/server.ts";

const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const db = new Database(
	arg("db") ?? defaultDbPath(process.env as { BUCKLE_DB?: string }),
	{ readonly: true },
);
const rows = db
	.query(
		`SELECT r.transport_json AS tj, a.stream_receipt AS sr, r.queue_wait_ms AS qw
		 FROM route_attempt r LEFT JOIN route_audit a ON a.rid = r.rid`,
	)
	.all() as Array<{ tj: string | null; sr: unknown; qw: number | null }>;
const latencyRows: LatencyRow[] = rows.map((r) => ({
	transportJson: r.tj,
	streamReceipt: r.sr,
	queueWaitMs: r.qw,
}));
console.log(renderReport(latencyReport(latencyRows)));
