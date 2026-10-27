// test/ledger-cost.test.ts — W1132: cost + rate_version land per ledger row
// at write time: the hourly rollup accumulates priced sums (unpriced stays
// NULL), the per-request audit row prices at enqueue only when the caller
// names the model, a pre-cost database heals via the pragma ALTERs, and the
// W824 inspection read surfaces both columns.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { pricerOf, type CostPolicy } from "../src/cost.ts";
import {
	Ledger,
	type RouteAuditDecision,
	type UsageRecord,
} from "../src/ledger.ts";

const TABLE: CostPolicy = {
	version: "test-v1",
	models: {
		priced: { in_per_tok: 0.000002, out_per_tok: 0.00001 },
	},
};

const pricer = pricerOf(TABLE);

const rec = (model: string, in_tok: number): UsageRecord => ({
	key: "",
	group: "g",
	model,
	in_tok,
	out_tok: 1,
	cache_r: 0,
	cache_c: 0,
	requests: 1,
});

const dec = (rid: string): RouteAuditDecision => ({
	hop: "origin",
	rid,
	ts: "2026-10-23T00:00:00.000Z",
	actor: "a",
	lane: "lane-x",
	dialect: "anthropic",
	hint: "",
	candidates_seen: 1,
	candidates_top: "c",
	target_kind: null,
	target_host: null,
	target_port: null,
	target_model: null,
	decision: "policy",
	latency_class: "unproven",
	tier: "SIMPLE",
	allow_cloud: false,
	error_code: null,
	why: "w",
});

describe("Ledger cost (W1132)", () => {
	test("hourly rollup: priced sums accumulate; unpriced stays NULL", () => {
		const db = new Ledger(":memory:", undefined, { pricer });
		db.record(rec("priced", 100));
		db.record(rec("priced", 50));
		db.record(rec("opaque", 10));
		const rows = db.rows();
		expect(rows.length).toBe(2);
		const priced = rows.find((r) => r.model === "priced");
		const opaque = rows.find((r) => r.model === "opaque");
		expect(priced?.cost_usd).toBeCloseTo(150 * 0.000002 + 2 * 0.00001, 12);
		expect(priced?.rate_version).toBe("test-v1");
		expect(opaque?.cost_usd).toBe(null);
		expect(opaque?.rate_version).toBe("");
		db.close();
	});

	test("auditUsage: prices at enqueue when the caller names the model", () => {
		const db = new Ledger(":memory:", undefined, { pricer });
		db.auditDecision(dec("rQ"));
		db.auditOutcome("rQ", { status: 200, duration_ms: 4, ok: true, err: null });
		db.auditUsage(
			"rQ",
			{ in_tok: 1000, out_tok: 100, cache_r: 0, cache_c: 0 },
			true,
			true,
			"priced",
		);
		const row = db.auditRows()[0] ?? {};
		expect(row.cost_usd).toBeCloseTo(1000 * 0.000002 + 100 * 0.00001, 12);
		expect(row.rate_version).toBe("test-v1");
		db.close();
	});

	test("auditUsage without a model stays NULL (no name = cannot price)", () => {
		const db = new Ledger(":memory:", undefined, { pricer });
		db.auditDecision(dec("rM"));
		db.auditOutcome("rM", { status: 200, duration_ms: 4, ok: true, err: null });
		db.auditUsage("rM", { in_tok: 1000, out_tok: 100, cache_r: 0, cache_c: 0 });
		const row = db.auditRows()[0] ?? {};
		expect(row.cost_usd).toBe(null);
		expect(row.rate_version).toBe("");
		db.close();
	});

	test("pre-cost db heals: columns re-added, legacy rows read NULL/''", () => {
		const path = `/tmp/buckle-cost-heal-${Date.now()}-${process.pid}.db`;
		const seed = new Ledger(path);
		seed.record(rec("priced", 10));
		seed.auditDecision(dec("rL"));
		seed.auditUsage("rL", { in_tok: 5, out_tok: 1, cache_r: 0, cache_c: 0 });
		seed.close();
		// regress the file to the pre-cost shape: drop all four columns raw
		const raw = new Database(path);
		for (const [tbl, col] of [
			["router_usage", "cost_usd"],
			["router_usage", "rate_version"],
			["route_audit", "cost_usd"],
			["route_audit", "rate_version"],
		] as const)
			raw.run(`ALTER TABLE ${tbl} DROP COLUMN ${col}`);
		raw.close();
		const db = new Ledger(path, undefined, { pricer });
		db.record(rec("priced", 100));
		const row = db.rows()[0] ?? {};
		// tokens accumulate onto the legacy row; cost is the PRICED rows' sum
		// only (the unpriced seed contributed NULL, now filled by the insert)
		expect(row.in_tok).toBe(110);
		expect(row.cost_usd).toBeCloseTo(100 * 0.000002 + 1 * 0.00001, 12);
		expect(row.rate_version).toBe("test-v1");
		db.close();
	});

	test("requestsRead carries cost_usd + rate_version (W824 surface)", () => {
		const db = new Ledger(":memory:", undefined, { pricer });
		db.auditDecision(dec("rR"));
		db.auditOutcome("rR", { status: 200, duration_ms: 4, ok: true, err: null });
		db.auditUsage(
			"rR",
			{ in_tok: 10, out_tok: 1, cache_r: 0, cache_c: 0 },
			true,
			true,
			"priced",
		);
		const rows = db.requestsRead({ limit: 10 });
		expect(rows[0]?.cost_usd).toBeCloseTo(10 * 0.000002 + 1 * 0.00001, 12);
		expect(rows[0]?.rate_version).toBe("test-v1");
		db.close();
	});
});
