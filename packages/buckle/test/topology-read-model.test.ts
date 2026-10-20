import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaneProjection } from "../src/projection.ts";
import { topologySnapshot } from "../src/topology-read-model.ts";

const TRACE = "a".repeat(32);
const TRACEPARENT = `00-${TRACE}-${"b".repeat(16)}-01`;
const instant = Date.UTC(2026, 9, 20, 11, 0);

function fixture(hubs: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "topology-"));
	const obsDb = join(dir, "observations.db");
	const ledger = join(dir, "buckle.db");
	const proj = new LaneProjection(obsDb);
	const events = hubs.flatMap((hub, index) => {
		const source = `buckle://${hub}/boot`;
		const data = {
			rid: `r${index}`,
			lane: "lane-1",
			actor: "actor",
			model: "model",
			dialect: "anthropic",
			traceparent: TRACEPARENT,
			origin: hubs[0] ?? "",
			...(index ? { peer: hubs[index - 1] } : {}),
		};
		return [
			{
				specversion: "1.0" as const,
				type: "lane.request.admitted" as const,
				source,
				id: "1",
				// Intentionally skew clocks: peer markers, not timestamps, order hops.
				time: new Date(
					instant - 6000 + (hubs.length - index) * 1000,
				).toISOString(),
				data,
			},
			{
				specversion: "1.0" as const,
				type: "lane.request.ended" as const,
				source,
				id: "2",
				time: new Date(
					instant - 3000 + (hubs.length - index) * 1000,
				).toISOString(),
				data: { ...data, outcome: "ok", status: 200 },
			},
		];
	});
	proj.ingest(events, instant);
	proj.ingest(events, instant); // duplicate replay must not double count
	proj.close();
	const db = new Database(ledger);
	db.exec(`CREATE TABLE route_audit (
		rid TEXT, trace_id TEXT, ts TEXT, ok INTEGER, hop TEXT,
		target_kind TEXT, target_host TEXT, target_port INTEGER,
		in_tok INTEGER, out_tok INTEGER)`);
	const insert = db.query(
		"INSERT INTO route_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	insert.run(
		"origin",
		TRACE,
		new Date(instant - 1000).toISOString(),
		1,
		"origin",
		null,
		null,
		null,
		10,
		2,
	);
	insert.run(
		"forwarded",
		TRACE,
		new Date(instant - 1000).toISOString(),
		1,
		"forwarded",
		null,
		null,
		null,
		10,
		2,
	);
	db.close();
	return { dir, obsDb, ledger };
}

describe("topologySnapshot", () => {
	for (const hubs of [
		["mac", "ikea"],
		["mac", "ikea", "z"],
	]) {
		test(`${hubs.length} hops produce one request and ordered measured edges`, () => {
			const f = fixture(hubs);
			try {
				const result = topologySnapshot(f, () => instant);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.schemaVersion).toBe(1);
				expect(result.totals).toEqual({
					requests: 1,
					failed: 0,
					active: 0,
					inputTokens: 10,
					outputTokens: 2,
				});
				expect(result.traces[0]?.hops).toEqual(hubs);
				expect(result.edges.map((edge) => edge.id).sort()).toEqual(
					hubs
						.slice(1)
						.map((hub, index) => `edge:${hubs[index]}->${hub}`)
						.sort(),
				);
				expect(
					result.edges.every(
						(edge) => edge.requests === 1 && edge.evidence === "trace",
					),
				).toBe(true);
				expect(result.coverage.observedHops).toBe(hubs.length);
				expect(result.coverage.tracedHops).toBe(hubs.length);
				expect(result.coverage.usageBearingOrigins).toBe(1);
			} finally {
				rmSync(f.dir, { recursive: true, force: true });
			}
		});
	}

	test("missing projection and ledger report unavailable rather than an empty estate", () => {
		expect(topologySnapshot({ ledger: "/missing" })).toEqual({
			ok: false,
			reason: "hub observations and local ledger unavailable",
		});
	});

	test("local ledger still exposes observed targets when remote projection is absent", () => {
		const f = fixture(["mac"]);
		try {
			const db = new Database(f.ledger);
			db.query(
				"UPDATE route_audit SET target_kind = ?, target_host = ?, target_port = ? WHERE hop = 'origin'",
			).run("hub", "127.0.0.1", 4301);
			db.close();
			const result = topologySnapshot(
				{ ledger: f.ledger },
				() => instant,
				"mac",
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.coverage.projectionAvailable).toBe(false);
			expect(result.coverage.ledgerOnlyRequests).toBe(1);
			expect(result.targets[0]?.id).toBe("target:hub:127.0.0.1:4301");
			expect(result.edges[0]).toMatchObject({
				from: "hub:mac",
				to: "target:hub:127.0.0.1:4301",
				evidence: "ledger",
				requests: 1,
			});
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	test("an untraced local projection and its ledger row count once", () => {
		const f = fixture(["mac"]);
		try {
			const projection = new Database(f.obsDb);
			projection.run("UPDATE request_edges SET traceparent = ''");
			projection.close();
			const ledger = new Database(f.ledger);
			ledger.run(
				"UPDATE route_audit SET trace_id = NULL, rid = 'r0' WHERE hop = 'origin'",
			);
			ledger.close();
			const result = topologySnapshot(f, () => instant, "mac");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.totals.requests).toBe(1);
			expect(result.coverage.ledgerOnlyRequests).toBe(0);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	});
});
