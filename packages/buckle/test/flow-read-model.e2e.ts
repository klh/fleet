// test/flow-read-model.e2e.ts — W2673.1: the gateway flow feed read model —
// windowed request-edge aggregation (senders/gateway/targets/attention)
// over seeded projection + ledger dbs: honest windows (COUNT measured,
// empty = series [] not null, missing dbs = ok:false), window
// normalization, caps with truncation reporting, and the attention
// signals (error-rate, guardrail blocks, unsettled climb).

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	FLOW_ROWS_CAP,
	type FlowResult,
	type FlowSnapshot,
	flowSnapshot,
	normalizeFlowWindow,
} from "../src/flow-read-model.ts";
import { Ledger } from "../src/ledger.ts";
import type { Observation } from "../src/observe.ts";
import { LaneProjection } from "../src/projection.ts";

test.describe("@unit", () => {
	// W2673.3: kit-mandated scratch fixture (W1135.1.3) — seeded dbs live in
	// the scratch home; world.clean() is the bounded teardown.
	const world = (): { dir: string; clean: () => void } => {
		const w = scratchWorld({ prefix: "flow-model-" });
		return { dir: w.home, clean: () => w.clean() };
	};

	const NOW = Date.parse("2026-11-03T21:00:00.000Z");
	const now = (): number => NOW;
	let seq = 0;
	const edge = (
		source: string,
		rid: string,
		lane: string,
		actor: string,
		admittedAt: number,
		outcome: string | null,
	): Observation => ({
		specversion: "1.0",
		type: outcome === null ? "lane.request.admitted" : "lane.request.ended",
		source,
		id: String(++seq),
		time: new Date(admittedAt).toISOString(),
		data: {
			rid,
			lane,
			actor,
			dialect: "anthropic",
			model: "",
			traceparent: `00-${rid.padEnd(32, "0").slice(0, 32)}-0123456789abcdef-01`,
			...(outcome === null ? {} : { outcome, status: 200, attempts: 1 }),
		},
	});

	const ok = (r: FlowResult): Extract<FlowSnapshot, { ok: true }> => {
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		return r;
	};

	test("normalizeFlowWindow accepts offered lengths, defaults 300", () => {
		expect(normalizeFlowWindow(60)).toBe(60);
		expect(normalizeFlowWindow("300")).toBe(300);
		expect(normalizeFlowWindow(600)).toBe(600);
		expect(normalizeFlowWindow("10")).toBe(300);
		expect(normalizeFlowWindow(null)).toBe(300);
		expect(normalizeFlowWindow("bogus")).toBe(300);
	});

	test("seeded window aggregates senders, gateway series, targets, attention", () => {
		const scratch = world();
		const dir = scratch.dir;
		try {
			const proj = new LaneProjection(join(dir, "obs.db"));
			// W2673.1 lane: 6 requests in-window (2 errored), 1 pre-window
			// (excluded), 1 still active.
			const rows: Observation[] = [
				edge(
					"buckle://local/boot1",
					"r-old",
					"lane-old",
					"a1",
					NOW - 700_000,
					null,
				),
				edge(
					"buckle://local/boot1",
					"r-old",
					"lane-old",
					"a1",
					NOW - 690_000,
					"ok",
				),
			];
			for (let i = 0; i < 6; i++) {
				const rid = `r-w${i}`;
				rows.push(
					edge(
						"buckle://local/boot1",
						rid,
						"autow2673-1",
						"a1",
						NOW - 60_000 - i * 5000,
						null,
					),
				);
				rows.push(
					edge(
						"buckle://local/boot1",
						rid,
						"autow2673-1",
						"a1",
						NOW - 55_000 - i * 5000,
						i < 2 ? "errored" : "policy",
					),
				);
			}
			rows.push(
				edge(
					"buckle://local/boot1",
					"r-live",
					"autow2673-2",
					"a2",
					NOW - 10_000,
					null,
				),
			);
			proj.ingest(rows, NOW);
			proj.close();
			// ledger: glm-5.3 3 settled (1 failed) + 1 unsettled; local-swarm
			// 5 settled all failed (error-rate attention).
			const ledger = join(dir, "buckle.db");
			new Ledger(ledger).close();
			const db = new Database(ledger);
			const insert = db.query(`INSERT INTO route_audit
			(rid, ts, lane, actor, dialect, target_kind, target_host, target_model, ok, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			insert.run(
				"l1",
				new Date(NOW - 90_000).toISOString(),
				"autow2673-1",
				"a1",
				"anthropic",
				"local",
				"127.0.0.1",
				"glm-5.3",
				1,
				200,
			);
			insert.run(
				"l2",
				new Date(NOW - 80_000).toISOString(),
				"autow2673-1",
				"a1",
				"anthropic",
				"local",
				"127.0.0.1",
				"glm-5.3",
				0,
				502,
			);
			insert.run(
				"l3",
				new Date(NOW - 70_000).toISOString(),
				"autow2673-1",
				"a1",
				"anthropic",
				"local",
				"127.0.0.1",
				"glm-5.3",
				1,
				200,
			);
			insert.run(
				"l-un",
				new Date(NOW - 30_000).toISOString(),
				"autow2673-2",
				"a2",
				"anthropic",
				null,
				null,
				null,
				null,
				null,
			);
			for (let i = 0; i < 5; i++)
				insert.run(
					`ls${i}`,
					new Date(NOW - 50_000 - i * 1000).toISOString(),
					"autow2673-1",
					"a1",
					"anthropic",
					"local",
					"127.0.0.1",
					"local-swarm",
					0,
					500,
				);
			// a pre-window settled row: excluded from targets
			insert.run(
				"l-old",
				new Date(NOW - 700_000).toISOString(),
				"autow2673-1",
				"a1",
				"anthropic",
				"cloud",
				"api.old",
				"old-model",
				1,
				200,
			);
			db.close();

			const r = ok(
				flowSnapshot({ ledger, obsDb: join(dir, "obs.db") }, 600, now, "local"),
			);
			// gateway: 7 in-window edges (6 lane-1 + 1 live), 2 errored, 1 active
			expect(r.windowS).toBe(600);
			expect(r.gateway.id).toBe("local");
			expect(r.gateway.requests).toBe(7);
			expect(r.gateway.errors).toBe(2);
			expect(r.gateway.active).toBe(1);
			expect(r.gateway.reqPerS).toBeCloseTo(7 / 600, 2);
			// series: 30s buckets over the window, trimmed to the cap
			expect(r.gateway.series).not.toBeNull();
			const seriesTotal = (r.gateway.series ?? []).reduce(
				(n, b) => n + b.requests,
				0,
			);
			expect(seriesTotal).toBe(7);
			// senders: lane rows with per-lane counts; pre-window lane excluded
			expect(r.senders.map((s) => s.lane)).toEqual([
				"autow2673-1",
				"autow2673-2",
			]);
			const s1 = r.senders.find((s) => s.lane === "autow2673-1");
			expect(s1?.requests).toBe(6);
			expect(s1?.errors).toBe(2);
			expect(s1?.reqPerS).toBeCloseTo(6 / 600, 2);
			// targets: ledger-settled rows in-window, grouped by model
			expect(r.targets.map((t) => t.name)).toEqual(["local-swarm", "glm-5.3"]);
			const glm = r.targets.find((t) => t.name === "glm-5.3");
			expect(glm?.kind).toBe("model");
			expect(glm?.requests).toBe(3);
			expect(glm?.errors).toBe(1);
			// attention: local-swarm 5/5 failed ≥ threshold; unsettled row counted
			const kinds = r.attention.map((a) => a.kind);
			expect(kinds).toContain("error-rate");
			expect(
				r.attention.find(
					(a) => a.kind === "error-rate" && a.subject === "local-swarm",
				)?.n,
			).toBe(5);
			expect(kinds).toContain("unsettled-climb");
			expect(r.coverage).toEqual({
				projectionAvailable: true,
				ledgerAvailable: true,
				sendersTruncated: 0,
				targetsTruncated: 0,
			});
		} finally {
			scratch.clean();
		}
	});

	test("empty window stays honest: 0 counts, series [], no fabricated attention", () => {
		const scratch = world();
		const dir = scratch.dir;
		try {
			const ledger = join(dir, "buckle.db");
			new Ledger(ledger).close();
			const db = new Database(ledger);
			// everything pre-window
			db.query(`INSERT INTO route_audit
			(rid, ts, lane, actor, dialect, target_kind, target_host, target_model, ok, status)
			VALUES ('x', ?, 'l', 'a', 'anthropic', 'local', 'h', 'm', 1, 200)`).run(
				new Date(NOW - 700_000).toISOString(),
			);
			db.close();
			const proj = new LaneProjection(join(dir, "obs.db"));
			proj.ingest(
				[
					edge(
						"buckle://local/boot1",
						"r-old",
						"lane",
						"a1",
						NOW - 700_000,
						null,
					),
					edge(
						"buckle://local/boot1",
						"r-old",
						"lane",
						"a1",
						NOW - 690_000,
						"ok",
					),
				],
				NOW,
			);
			proj.close();
			const r = ok(
				flowSnapshot({ ledger, obsDb: join(dir, "obs.db") }, 60, now, "local"),
			);
			expect(r.gateway.requests).toBe(0);
			expect(r.gateway.reqPerS).toBe(0);
			expect(r.gateway.series).toEqual([]);
			expect(r.senders).toEqual([]);
			expect(r.targets).toEqual([]);
			expect(r.attention).toEqual([]);
		} finally {
			scratch.clean();
		}
	});

	test("denied + degraded outcomes surface guardrail attention rows", () => {
		const scratch = world();
		const dir = scratch.dir;
		try {
			const proj = new LaneProjection(join(dir, "obs.db"));
			proj.ingest(
				[
					edge("buckle://local/boot1", "g1", "l", "a1", NOW - 5000, null),
					edge("buckle://local/boot1", "g1", "l", "a1", NOW - 4000, "denied"),
					edge("buckle://local/boot1", "g2", "l", "a1", NOW - 3000, null),
					edge("buckle://local/boot1", "g2", "l", "a1", NOW - 2000, "degraded"),
				],
				NOW,
			);
			proj.close();
			const r = ok(
				flowSnapshot({ obsDb: join(dir, "obs.db") }, 60, now, "local"),
			);
			const guard = r.attention.filter((a) => a.kind === "guardrail-blocks");
			expect(guard).toHaveLength(2);
			expect(guard.find((a) => a.detail.includes("blocked"))?.n).toBe(1);
			expect(guard.find((a) => a.detail.includes("masked"))?.n).toBe(1);
			expect(r.coverage.projectionAvailable).toBe(true);
			expect(r.coverage.ledgerAvailable).toBe(false);
		} finally {
			scratch.clean();
		}
	});

	test(`sender rows past the cap report truncation, never silent drop`, () => {
		const scratch = world();
		const dir = scratch.dir;
		try {
			const proj = new LaneProjection(join(dir, "obs.db"));
			const rows: Observation[] = [];
			for (let i = 0; i < FLOW_ROWS_CAP + 3; i++) {
				rows.push(
					edge(
						"buckle://local/boot1",
						`rc${i}`,
						`lane-${i}`,
						`a${i}`,
						NOW - 5000,
						null,
					),
				);
				rows.push(
					edge(
						"buckle://local/boot1",
						`rc${i}`,
						`lane-${i}`,
						`a${i}`,
						NOW - 4000,
						"ok",
					),
				);
			}
			proj.ingest(rows, NOW);
			proj.close();
			const r = ok(
				flowSnapshot({ obsDb: join(dir, "obs.db") }, 300, now, "local"),
			);
			expect(r.senders).toHaveLength(FLOW_ROWS_CAP);
			expect(r.coverage.sendersTruncated).toBe(3);
			// gateway totals stay full-fidelity (the cap is a display bound)
			expect(r.gateway.requests).toBe(FLOW_ROWS_CAP + 3);
		} finally {
			scratch.clean();
		}
	});

	test("both dbs absent = honest ok:false", () => {
		const r = flowSnapshot(
			{ ledger: "/nonexistent/buckle.db", obsDb: "/nonexistent/obs.db" },
			300,
			now,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("unavailable");
	});
});
