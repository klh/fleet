import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latencyReport, renderReport } from "../src/latency-report.ts";

test.afterEach(() => {
	// scratch dirs are unique per test; nothing persists
});

test("latency report buckets request sizes and separates streaming", () => {
	const rows = [
		{
			transportJson: JSON.stringify({ requestBodyBytes: 5000, headersMs: 900 }),
			streamReceipt: null,
			queueWaitMs: 0,
		},
		{
			transportJson: JSON.stringify({
				requestBodyBytes: 50_000,
				headersMs: 2000,
			}),
			streamReceipt: "x",
			queueWaitMs: 120,
		},
		{
			transportJson: JSON.stringify({
				requestBodyBytes: 900_000,
				headersMs: 76_562,
			}),
			streamReceipt: null,
			queueWaitMs: 0,
		},
		{
			transportJson: JSON.stringify({
				requestBodyBytes: 900_000,
				headersMs: 3000,
			}),
			streamReceipt: "x",
			queueWaitMs: 5,
		},
		{ transportJson: null, streamReceipt: null, queueWaitMs: null },
		{ transportJson: "not-json", streamReceipt: null, queueWaitMs: null },
	];
	const report = latencyReport(rows);
	expect(report.attempts).toBe(4);
	expect(report.buckets.map((b) => b.bucket).sort()).toEqual([
		"10-100k",
		"500k+",
		"<10k",
	]);
	const big = report.buckets.find((b) => b.bucket === "500k+");
	expect(big?.n).toBe(2);
	expect(big?.headersMs.p50).toBe(76_562);
	expect(report.nonStreaming.n).toBe(2);
	expect(report.streaming.n).toBe(2);
	expect(Number.isFinite(report.pearsonRequestBytesHeadersMs)).toBe(true);
	expect(renderReport(report)).toContain("pearson");
});

test("cli face renders the same report from a scratch ledger", async () => {
	const dir = mkdtempSync(join(tmpdir(), "w2247-latency-"));
	try {
		const dbPath = join(dir, "buckle.db");
		const db = new Database(dbPath);
		db.exec(
			`CREATE TABLE route_attempt (rid TEXT PRIMARY KEY, trace_id TEXT, ts TEXT, status INTEGER, queue_wait_ms INTEGER, transport_json TEXT);
			 CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT, stream_receipt TEXT);
			 INSERT INTO route_attempt VALUES ('r1','t1','2026-10-29T00:00:00Z',200,0,'{"requestBodyBytes":912384,"headersMs":76562}');
			 INSERT INTO route_audit VALUES ('r1','2026-10-29T00:00:00Z',NULL);`,
		);
		db.close();
		const proc = Bun.spawnSync([
			"bun",
			join(import.meta.dir, "..", "bin", "latency-report.ts"),
			"--db",
			dbPath,
		]);
		expect(proc.exitCode).toBe(0);
		const out = new TextDecoder().decode(proc.stdout);
		expect(out).toContain("attempts with transport evidence: 1");
		expect(out).toContain("500k+");
		expect(out).toContain("76562");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
