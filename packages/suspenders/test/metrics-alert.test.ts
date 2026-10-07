import { describe, expect, test } from "bun:test";
import {
	counterSpikes,
	familyDrops,
	formatAlert,
	loadState,
	parseProm,
	queueAlerts,
	saveState,
	scrapeTarget,
	statusAlerts,
	type AlertState,
} from "../hooks/bin/metrics-alert.ts";

const freshState = (): AlertState => ({ targets: {} });

describe("parseProm", () => {
	test("parses labeled and bare series, skips comments", () => {
		const rows = parseProm(
			[
				"# HELP x",
				"# TYPE x counter",
				'http_requests_total{route="/v1/messages"} 3',
				"http_requests_total 5",
				"garbage line without value",
			].join("\n"),
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({
			name: "http_requests_total",
			labels: { route: "/v1/messages" },
			value: 3,
		});
		expect(rows[1]?.value).toBe(5);
	});
});

describe("familyDrops", () => {
	test("detects a vanished family", () => {
		const prev = parseProm("buckle_ledger_dropped_total{kind=\"usage\"} 1");
		const cur = parseProm("http_requests_total 1");
		expect(familyDrops(prev, cur)).toEqual([
			{ name: "buckle_ledger_dropped_total", labels: "kind=usage" },
		]);
	});
});

describe("counterSpikes", () => {
	test("alerts on increase, ignores resets and other families", () => {
		const prev = parseProm(
			[
				"buckle_ledger_dropped_total{kind=\"usage\"} 1",
				"buckle_cooldown_ejections_total{dep=\"d1\"} 7",
				"http_requests_total 100",
			].join("\n"),
		);
		const cur = parseProm(
			[
				"buckle_ledger_dropped_total{kind=\"usage\"} 4",
				"buckle_cooldown_ejections_total{dep=\"d1\"} 2",
				"http_requests_total 110",
			].join("\n"),
		);
		expect(counterSpikes(prev, cur)).toEqual([
			{ name: "buckle_ledger_dropped_total", labels: "kind=usage", delta: 3 },
		]);
	});
});

describe("statusAlerts", () => {
	const now = Date.parse("2026-10-07T12:00:00Z");
	test("healthy=false alerts", () => {
		expect(
			statusAlerts({ healthy: false }, now),
		).toEqual([{ kind: "HEALTH", detail: "/status reports healthy=false" }]);
	});
	test("fresh last_error alerts, stale does not", () => {
		const fresh = statusAlerts(
			{ last_error: { at: "2026-10-07T11:58:00Z", message: "boom" } },
			now,
		);
		expect(fresh).toHaveLength(1);
		expect(fresh[0]?.kind).toBe("ERROR");
		const stale = statusAlerts(
			{ last_error: { at: "2026-10-07T10:00:00Z", message: "boom" } },
			now,
		);
		expect(stale).toEqual([]);
	});
});

describe("queueAlerts", () => {
	test("sticky QUEUE then RECOVER", () => {
		const s = freshState();
		const over = { count: 3, oldestMs: 3 * 3_600_000 };
		const under = { count: 1, oldestMs: 10 * 60_000 };
		expect(queueAlerts(s, over)).toHaveLength(1);
		expect(queueAlerts(s, over)).toHaveLength(0); // sticky
		expect(queueAlerts(s, under)).toHaveLength(1); // RECOVER
	});
});

describe("scrapeTarget", () => {
	test("drop at threshold, then recover", async () => {
		let healthy = false;
		const server = Bun.serve({
			port: 0,
			fetch: (req) => {
				const path = new URL(req.url).pathname;
				if (!healthy) return new Response("nope", { status: 500 });
				if (path === "/status")
					return Response.json({ service: "stub", healthy: true });
				return new Response("http_requests_total 1");
			},
		});
		try {
			const url = `http://127.0.0.1:${server.port}`;
			const s = freshState();
			await scrapeTarget(s, url, 1);
			expect(s.targets[url]?.misses).toBe(1);
			await scrapeTarget(s, url, 2);
			expect(s.targets[url]?.misses).toBe(2);
			expect(s.targets[url]?.active.DROP).toBeDefined();
			healthy = true;
			const recovered = await scrapeTarget(s, url, 3);
			expect(recovered.map((a) => a.kind)).toEqual(["RECOVER"]);
			expect(s.targets[url]?.misses).toBe(0);
		} finally {
			server.stop(true);
		}
	});
});

describe("state io", () => {
	test("save + load round-trip via tmp file", () => {
		const path = `${import.meta.dir}/metrics-alert-state-test.json`;
		const s = freshState();
		saveState(s, path);
		expect(loadState(path)).toEqual({ targets: {} });
		Bun.spawnSync(["rm", "-f", path]);
	});
});
