import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { seedUsage } from "../hooks/bin/usage-seed.ts";
import { buildUsageReport } from "../hooks/lib/usage.ts";
import { probePathFor } from "../../belt/bin/inventory-probe.ts";

function seeded() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER, hb INTEGER, state TEXT, actor TEXT, tags TEXT)",
	);
	db.run(
		"CREATE TABLE usage_rollup (hour_bucket INTEGER, actor TEXT, model TEXT, model_group TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER, requests INTEGER, PRIMARY KEY(hour_bucket, actor, model))",
	);
	const nowMs = Date.parse("2026-10-01T10:00:00Z");
	seedUsage(db, { nowMs });
	db.run("DELETE FROM sessions");
	return { db, nowMs };
}
test("orphaned legacy seed rows require exact deterministic fingerprint", () => {
	const { db, nowMs } = seeded();
	const report = buildUsageReport(db, { nowMs });
	expect(report.demo.excludedActors).toBe(2);
	expect(report.totals.tok).toBe(0);
	expect(
		db.query("SELECT COUNT(*) n FROM usage_actor_provenance").get(),
	).toEqual({ n: 2 });
	expect(
		buildUsageReport(db, { nowMs, includeDemo: true }).totals.tok,
	).toBeGreaterThan(100);
	db.close();
});
test("similar actor names and altered seed values are retained as unverified traffic", () => {
	const { db, nowMs } = seeded();
	db.run(
		"UPDATE usage_rollup SET in_tok = in_tok + 1 WHERE actor = 'demo:alice@demo'",
	);
	expect(buildUsageReport(db, { nowMs }).demo.excludedActors).toBe(0);
	db.close();
});
test("a real session overrides matching legacy seed actor provenance", () => {
	const { db, nowMs } = seeded();
	db.run(
		"INSERT INTO sessions(sid, actor, role, project, started_at) VALUES ('real', 'demo:alice@demo', 'dev', 'real-project', 1)",
	);
	expect(buildUsageReport(db, { nowMs }).actors.map((a) => a.actor)).toContain(
		"demo:alice@demo",
	);
	db.close();
});
test("canonical configured model check uses declared path or OpenAPI model route", () => {
	expect(probePathFor({})).toBe("/v1/models");
	expect(probePathFor({ probePath: "/health" })).toBe("/health");
});
