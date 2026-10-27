// test/network-read-model.test.ts — W858.10.3: the Network overview read
// model — honest sections over ledger + projection dbs: per-hub rows with
// freshness, unsettled-by-kind, recent successful routes, per-interface
// trailing-window throughput, observed hops, and no inferred values (NULL
// usage stays null, empty windows stay null sums, missing dbs degrade
// sections — never fabricated zeros).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import type { Observation } from "../src/observe.ts";
import {
	type NetworkOverviewResult,
	networkOverview,
} from "../src/network-read-model.ts";
import { LaneProjection } from "../src/projection.ts";

test.describe({ tag: "@unit" }, () => {
	const tmpDir = (): string => mkdtempSync(join(tmpdir(), "net-model-"));

	/** A settled ok route with provider-reported usage, ts = now. */
	const settleOk = (
		led: Ledger,
		rid: string,
		host: string,
		model: string,
		toks: { in_tok: number; out_tok: number } | null,
	): void => {
		const ts = new Date().toISOString();
		led.auditDecision({
			rid,
			ts,
			actor: "k1",
			lane: "autow858",
			dialect: "openai",
			hint: "",
			candidates_seen: 1,
			candidates_top: model,
			target_kind: "cloud",
			target_host: host,
			target_port: null,
			target_model: model,
			decision: "route",
			latency_class: "unproven",
			tier: "",
			allow_cloud: true,
			why: "",
			hop: "origin",
		});
		if (toks)
			led.auditUsage(rid, {
				in_tok: toks.in_tok,
				out_tok: toks.out_tok,
				cache_r: 0,
				cache_c: 0,
			});
		led.auditOutcome(rid, {
			status: 200,
			duration_ms: 123,
			ok: true,
			err: null,
		});
	};

	const edgeEvent = (
		source: string,
		id: number,
		data: Record<string, unknown>,
		outcome: string | null,
	): Observation => ({
		specversion: "1.0",
		type: outcome === null ? "lane.request.admitted" : "lane.request.ended",
		source,
		id: String(id),
		time: new Date().toISOString(),
		data: { ...data, ...(outcome === null ? {} : { outcome, status: 200 }) },
	});

	const seedUnsettled = (led: Ledger, rid: string, model: string): void => {
		led.auditDecision({
			rid,
			ts: new Date().toISOString(),
			actor: "k1",
			lane: "autow858",
			dialect: "openai",
			hint: "",
			candidates_seen: 1,
			candidates_top: model,
			target_kind: "cloud",
			target_host: "api.anthropic.com",
			target_port: null,
			target_model: model,
			decision: "route",
			latency_class: "unproven",
			tier: "",
			allow_cloud: true,
			why: "",
			hop: "origin",
		});
	};

	const assertSeeded = (
		r: Extract<NetworkOverviewResult, { ok: true }>,
	): void => {
		// hubs: one source S1, two edges — one active, one ended ok
		expect(r.hubs).toHaveLength(1);
		const hub = r.hubs[0];
		if (!hub) return;
		expect(hub.source).toBe("S1");
		expect(hub.active).toBe(1);
		expect(hub.requests).toBe(2);
		expect(hub.freshness.lastSeq).toBe(3);
		expect(hub.freshness.lastEventAt).not.toBeNull();
		expect(hub.freshness.ageS).not.toBeNull();
		// unsettled decision rows keep their kind with no outcome
		expect(r.unsettled).toEqual([{ kind: "cloud", n: 1 }]);
		// routes: newest first; the bare route keeps null tokens
		expect(r.routes).toHaveLength(2);
		const bare = r.routes.find((x) => x.target_model === "claude-sonnet-5");
		if (!bare) return;
		expect(bare.in_tok).toBeNull();
		expect(bare.out_tok).toBeNull();
		// per-interface rows: one per (kind, host, model) with measured sums
		expect(r.throughput.interfaces).toHaveLength(2);
		const zai = r.throughput.interfaces.find((x) => x.host === "api.z.ai");
		if (!zai) return;
		expect(zai.req15).toBe(1);
		expect(zai.out15).toBe(500);
		expect(zai.out60).toBe(500);
		expect(zai.lastOkAt).not.toBeNull();
		// usage never reported → token sums stay null even when a route settled
		const cp = r.throughput.interfaces.find(
			(x) => x.host === "api.githubcopilot.com",
		);
		if (!cp) return;
		expect(cp.req15).toBe(1);
		expect(cp.in15).toBeNull();
		expect(cp.out15).toBeNull();
		expect(cp.in60).toBeNull();
		// the observed hop: only the peer-forwarded edge counts; the local
		// entry edge (peer null) is NOT a forwarding edge
		expect(r.hops).toEqual([
			{
				origin: "",
				peer: "nas",
				source: "S1",
				n: 1,
				lastAt: expect.any(Number),
			},
		]);
	};

	test.describe("networkOverview", () => {
		test("hourly trend sums model rows and keeps quiet hours in place", () => {
			const dir = tmpDir();
			try {
				const path = join(dir, "buckle.db");
				new Ledger(path).close();
				const db = new Database(path);
				const insert = db.query(
					"INSERT INTO router_usage (hour_bucket, key, model_group, model, in_tok, out_tok, requests) VALUES (?, ?, ?, ?, ?, ?, ?)",
				);
				insert.run("2026-10-20T01:00", "a", "glm", "glm-a", 10, 20, 1);
				insert.run("2026-10-20T01:00", "b", "claude", "claude-b", 30, 40, 2);
				insert.run("2026-10-19T23:00", "a", "glm", "glm-a", 5, 8, 1);
				db.close();
				const result = networkOverview({ ledger: path }, () =>
					Date.UTC(2026, 9, 20, 1, 30),
				);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.throughput.buckets).toHaveLength(24);
				expect(result.throughput.buckets.slice(0, 3)).toEqual([
					{ hour: "2026-10-20T01:00", in_tok: 40, out_tok: 60, requests: 3 },
					{ hour: "2026-10-20T00:00", in_tok: 0, out_tok: 0, requests: 0 },
					{ hour: "2026-10-19T23:00", in_tok: 5, out_tok: 8, requests: 1 },
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("missing ledger = honest ok:false", () => {
			const r = networkOverview({
				ledger: "/nonexistent/buckle.db",
				obsDb: null,
			});
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toContain("not found");
		});

		test("empty ledger degrades sections, never fabricates", () => {
			const dir = tmpDir();
			try {
				const led = new Ledger(join(dir, "buckle.db"));
				led.close();
				const r = networkOverview({ ledger: join(dir, "buckle.db") });
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				expect(r.lastAuditAt).toBeNull();
				expect(r.audit15).toMatchObject({
					attempts: 0,
					succeeded: 0,
					failed: 0,
					unsettled: 0,
					unattributedFailed: 0,
					failures: [],
				});
				expect(r.routes).toEqual([]);
				expect(r.unsettled).toEqual([]);
				// window: COUNT is a true 0; token sums stay null
				expect(r.throughput.window.requests).toBe(0);
				expect(r.throughput.window.in_tok).toBeNull();
				expect(r.throughput.interfaces).toEqual([]);
				expect(r.hops).toEqual([]);
				expect(r.hubs).toEqual([]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("counts failed audits without assigning a local relay to a cloud provider", () => {
			const dir = tmpDir();
			try {
				const path = join(dir, "buckle.db");
				new Ledger(path).close();
				const db = new Database(path);
				const at = "2026-10-20T11:00:00.000Z";
				const insert = db.query(`INSERT INTO route_audit
				(rid, ts, target_kind, target_host, target_port, ok, status)
				VALUES (?, ?, ?, ?, ?, ?, ?)`);
				insert.run("cloud-fail", at, "cloud", "api.z.ai", null, 0, 429);
				insert.run("relay-fail", at, "local", "127.0.0.1", 4100, 0, 502);
				insert.run("unknown-fail", at, null, null, null, 0, 502);
				insert.run("success", at, "cloud", "api.z.ai", null, 1, 200);
				insert.run("pending", at, null, null, null, null, null);
				insert.run(
					"old-fail",
					"2026-10-20T10:40:00.000Z",
					null,
					null,
					null,
					0,
					429,
				);
				db.close();
				const result = networkOverview({ ledger: path }, () =>
					Date.parse("2026-10-20T11:05:00.000Z"),
				);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.audit15).toMatchObject({
					attempts: 5,
					succeeded: 1,
					failed: 3,
					unsettled: 1,
					unattributedFailed: 1,
				});
				expect(result.audit15.failures).toEqual([
					{ kind: null, host: null, port: null, count: 1, lastAt: at },
					{ kind: "cloud", host: "api.z.ai", port: null, count: 1, lastAt: at },
					{
						kind: "local",
						host: "127.0.0.1",
						port: 4100,
						count: 1,
						lastAt: at,
					},
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("seeded dbs expose hubs, interfaces, hops; nulls stay null", () => {
			const dir = tmpDir();
			try {
				const led = new Ledger(join(dir, "buckle.db"));
				settleOk(led, "r-ok", "api.z.ai", "glm-5.3-flash", {
					in_tok: 100,
					out_tok: 500,
				});
				// a settled route with NO provider usage — tokens stay null
				settleOk(
					led,
					"r-bare",
					"api.githubcopilot.com",
					"claude-sonnet-5",
					null,
				);
				seedUnsettled(led, "r-un", "claude-opus-5-5");
				led.close(); // drain the pending ring — readers see committed rows
				const proj = new LaneProjection(join(dir, "obs.db"));
				proj.ingest([
					edgeEvent("S1", 1, { rid: "a1", lane: "L1" }, null),
					edgeEvent("S1", 2, { rid: "a2", lane: "L2", peer: "nas" }, null),
					edgeEvent("S1", 3, { rid: "a2", lane: "L2" }, "ok"),
				]);
				proj.close();
				const r = networkOverview({
					ledger: join(dir, "buckle.db"),
					obsDb: join(dir, "obs.db"),
				});
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				assertSeeded(r);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
