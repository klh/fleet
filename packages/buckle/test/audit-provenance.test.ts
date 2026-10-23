import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type RouteAuditDecision } from "../src/ledger.ts";

const selected = "127.0.0.1:4000:glm-5.3-flash";
const candidate = createHash("sha256")
	.update(selected)
	.digest("hex")
	.slice(0, 16);
const traceId = "a".repeat(32);

function decision(rid: string, seen = 1): RouteAuditDecision {
	return {
		rid,
		trace_id: traceId,
		ts: "2026-10-21T00:00:00.000Z",
		actor: "test",
		lane: "",
		dialect: "anthropic",
		hint: "",
		candidates_seen: seen,
		candidates_top: selected,
		target_kind: "local",
		target_host: "127.0.0.1",
		target_port: 4000,
		target_model: "glm-5.3-flash",
		decision: "policy",
		latency_class: "unproven",
		tier: "SIMPLE",
		allow_cloud: true,
		error_code: null,
		why: "test",
		hop: "origin",
	};
}

test("request audit marks selected target exact only when every attempt matches", () => {
	const db = new Ledger(":memory:");
	try {
		db.auditDecision(decision("unattempted"));
		db.auditOutcome("unattempted", {
			status: 503,
			duration_ms: 1,
			ok: false,
			err: "unavailable",
			attempts: 0,
		});
		db.auditDecision(decision("matching"));
		db.auditAttempt({
			rid: "matching",
			traceId,
			ordinal: 1,
			service: "buckle",
			hop: "upstream",
			candidate,
			status: 429,
			refusal: "rate_limited",
			durationMs: 2,
			retryAfterMs: 1000,
			upstreamId: null,
			callId: null,
			upstreamRefusalCode: "local_cold",
			refusalOrigin: "upstream",
		});
		db.auditOutcome("matching", {
			status: 429,
			duration_ms: 2,
			ok: false,
			err: "rate_limited",
			attempts: 1,
		});
		db.auditDecision(decision("fallback"));
		db.auditAttempt({
			rid: "fallback",
			traceId,
			ordinal: 1,
			service: "buckle",
			hop: "upstream",
			candidate: "b".repeat(16),
			status: 503,
			refusal: "overloaded",
			durationMs: 2,
			retryAfterMs: null,
			upstreamId: null,
			callId: null,
			refusalOrigin: "upstream",
		});
		db.auditOutcome("fallback", {
			status: 503,
			duration_ms: 2,
			ok: false,
			err: "overloaded",
			attempts: 1,
		});
		db.auditDecision(decision("multiple", 2));
		db.auditOutcome("multiple", {
			status: 503,
			duration_ms: 1,
			ok: false,
			err: "unavailable",
			attempts: 0,
		});
		db.auditDecision(decision("missing-receipt"));
		db.auditOutcome("missing-receipt", {
			status: 503,
			duration_ms: 1,
			ok: false,
			err: "unavailable",
			attempts: 1,
		});
		db.auditDecision(decision("eventual-success"));
		db.auditAttempt({
			rid: "eventual-success",
			traceId,
			ordinal: 1,
			service: "buckle",
			hop: "upstream",
			candidate,
			status: 429,
			refusal: "rate_limited",
			durationMs: 1,
			retryAfterMs: 1000,
			upstreamId: null,
			callId: null,
			upstreamRefusalCode: "local_cold",
			refusalOrigin: "upstream",
		});
		db.auditAttempt({
			rid: "eventual-success",
			traceId,
			ordinal: 2,
			service: "buckle",
			hop: "upstream",
			candidate,
			status: 200,
			refusal: null,
			durationMs: 1,
			retryAfterMs: null,
			upstreamId: null,
			callId: null,
		});
		db.auditOutcome("eventual-success", {
			status: 200,
			duration_ms: 2,
			ok: true,
			err: null,
			attempts: 2,
		});
		const rows = new Map(
			db.requestsRead({ limit: 10 }).map((row) => [row.rid, row]),
		);
		expect(rows.get("unattempted")).toMatchObject({
			selected_target_exact: true,
			selected_target_attempted: false,
		});
		expect(rows.get("matching")).toMatchObject({
			selected_target_exact: true,
			selected_target_attempted: true,
			upstream_refusal_code: "local_cold",
			refusal_origin: "upstream",
			retry_after_ms: 1000,
		});
		expect(rows.get("fallback")?.selected_target_exact).toBe(false);
		expect(rows.get("multiple")?.selected_target_exact).toBe(false);
		expect(rows.get("missing-receipt")?.selected_target_exact).toBe(false);
		expect(rows.get("eventual-success")).toMatchObject({
			selected_target_exact: true,
			upstream_refusal_code: null,
			refusal_origin: null,
		});
	} finally {
		db.close();
	}
});

test("a cancel whose settle never landed still projects attempted truth", () => {
	const db = new Ledger(":memory:");
	try {
		// W1124.42.1: NULL attempts column + one matching downstream_cancel
		// receipt — attempted projects TRUE from the receipt alone.
		db.auditDecision(decision("legacy-cancel"));
		db.auditAttempt({
			rid: "legacy-cancel",
			traceId,
			ordinal: 1,
			service: "buckle",
			hop: "upstream",
			candidate,
			status: null,
			refusal: "downstream_cancel",
			durationMs: 1,
			retryAfterMs: null,
			upstreamId: null,
			callId: null,
			refusalOrigin: null,
		});
		db.auditOutcome("legacy-cancel", {
			status: 499,
			duration_ms: 1,
			ok: false,
			err: null,
		});
		const rows = new Map(
			db.requestsRead({ limit: 10 }).map((row) => [row.rid, row]),
		);
		expect(rows.get("legacy-cancel")).toMatchObject({
			selected_target_exact: false,
			selected_target_attempted: true,
		});
		// a settled 1 with a NON-selected receipt stays FALSE
		db.auditDecision(decision("mismatch"));
		db.auditAttempt({
			rid: "mismatch",
			traceId,
			ordinal: 1,
			service: "buckle",
			hop: "upstream",
			candidate: "b".repeat(16),
			status: null,
			refusal: "downstream_cancel",
			durationMs: 1,
			retryAfterMs: null,
			upstreamId: null,
			callId: null,
			refusalOrigin: null,
		});
		db.auditOutcome("mismatch", {
			status: 499,
			duration_ms: 1,
			ok: false,
			err: null,
			attempts: 1,
		});
		const all = db.requestsRead({ limit: 10 });
		expect(all.find((row) => row.rid === "mismatch")).toMatchObject({
			selected_target_exact: false,
			selected_target_attempted: false,
		});
	} finally {
		db.close();
	}
});

test("existing attempt ledger migrates provenance columns without losing receipts", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-attempt-migrate-"));
	const path = join(dir, "ledger.db");
	try {
		const old = new Database(path);
		old.exec(`CREATE TABLE route_attempt (
			rid TEXT NOT NULL, ordinal INTEGER NOT NULL, trace_id TEXT NOT NULL,
			ts TEXT NOT NULL, service TEXT NOT NULL, hop TEXT NOT NULL,
			candidate TEXT NOT NULL, status INTEGER, refusal TEXT,
			duration_ms INTEGER NOT NULL, retry_after_ms INTEGER,
			upstream_id TEXT, call_id TEXT, PRIMARY KEY (rid, ordinal))`);
		old.run(`INSERT INTO route_attempt VALUES
			('old', 1, '${traceId}', '2026-10-20T00:00:00Z', 'buckle',
			'upstream', '${candidate}', 429, 'rate_limited', 5, 1000, NULL, NULL)`);
		old.close();
		const ledger = new Ledger(path);
		try {
			expect(ledger.traceAttempts(traceId)[0]).toMatchObject({
				rid: "old",
				upstream_refusal_code: null,
				refusal_origin: null,
			});
			ledger.auditAttempt({
				rid: "new",
				traceId,
				ordinal: 1,
				service: "buckle",
				hop: "upstream",
				candidate,
				status: 429,
				refusal: "rate_limited",
				durationMs: 5,
				retryAfterMs: 1000,
				upstreamId: null,
				callId: null,
				upstreamRefusalCode: "local_cold",
				refusalOrigin: "upstream",
			});
			expect(ledger.traceAttempts(traceId)[1]).toMatchObject({
				rid: "new",
				upstream_refusal_code: "local_cold",
				refusal_origin: "upstream",
			});
		} finally {
			ledger.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
