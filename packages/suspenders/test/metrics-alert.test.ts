import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AlertState,
	counterSpikes,
	diffAlerts,
	familyDrops,
	loadState,
	parseProm,
	queueAlerts,
	saveState,
	scrapeTarget,
	statusAlerts,
	throughputOnsets,
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
		const prev = parseProm('buckle_ledger_dropped_total{kind="usage"} 1');
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
				'buckle_ledger_dropped_total{kind="usage"} 1',
				'buckle_cooldown_ejections_total{dep="d1"} 7',
				"http_requests_total 100",
			].join("\n"),
		);
		const cur = parseProm(
			[
				'buckle_ledger_dropped_total{kind="usage"} 4',
				'buckle_cooldown_ejections_total{dep="d1"} 2',
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
		expect(statusAlerts({ healthy: false }, now)).toEqual([
			{ kind: "HEALTH", detail: "/status reports healthy=false" },
		]);
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
		// above the 24h METRICS_ALERT_QUEUE_HOURS default — a 3h queue is under it
		const over = { count: 3, oldestMs: 30 * 3_600_000 };
		const under = { count: 1, oldestMs: 10 * 60_000 };
		expect(queueAlerts(s, over)).toHaveLength(1);
		expect(queueAlerts(s, over)).toHaveLength(0); // sticky
		expect(queueAlerts(s, under)).toHaveLength(1); // RECOVER
	});
});

describe("throughputOnsets", () => {
	test("onset fires once, silent while gauge holds 1, silent on clear", () => {
		const gauge = (v: number) =>
			parseProm(
				`buckle_throughput_incident_active{node="spoke",incident="abc",model="m"} ${v}`,
			);
		// first sighting (series appears at 1) = onset
		expect(throughputOnsets([], gauge(1))).toEqual([
			{
				labels: "incident=abc,model=m,node=spoke",
				detail: "throughput incident active: incident=abc,model=m,node=spoke",
			},
		]);
		// gauge holds 1 across passes = same incident, no re-fire
		expect(throughputOnsets(gauge(1), gauge(1))).toEqual([]);
		// cleared gauge alone reports nothing (clearance rides diffAlerts)
		expect(throughputOnsets(gauge(1), gauge(0))).toEqual([]);
		// a NEW incident (different cohort) is a fresh onset
		expect(
			throughputOnsets(
				gauge(1),
				parseProm(
					'buckle_throughput_incident_active{node="spoke",incident="def",model="m"} 1',
				),
			),
		).toHaveLength(1);
	});
});

describe("diffAlerts THROUGHPUT", () => {
	const gaugeLine = (v: number) =>
		`buckle_throughput_incident_active{node="spoke",incident="abc"} ${v}`;
	test("onset alerts THROUGHPUT, sticky at 1, RECOVER on clear", () => {
		const st = {
			url: "http://t",
			misses: 0,
			lastOkAt: null,
			active: {},
			series: parseProm(gaugeLine(0)),
		};
		const atOne = parseProm(gaugeLine(1));
		// 0 -> 1: onset
		const onset = diffAlerts(st, atOne, null, 0);
		expect(onset.map((a) => a.kind)).toEqual(["THROUGHPUT"]);
		expect(onset[0]?.detail).toContain("incident=abc");
		expect(st.active["THROUGHPUT:incident=abc,node=spoke"]).toBe("on");
		// 1 -> 1: sticky, silent (scrapeTarget assigns st.series = cur after
		// the diff — mirror that between passes)
		st.series = atOne;
		expect(diffAlerts(st, atOne, null, 0)).toEqual([]);
		// 1 -> 0: RECOVER
		const cleared = diffAlerts(st, parseProm(gaugeLine(0)), null, 0);
		expect(cleared.map((a) => a.kind)).toEqual(["RECOVER"]);
		expect(cleared[0]?.detail).toContain("cleared");
	});
	test("series vanishing with the retention window also recovers", () => {
		const st = {
			url: "http://t",
			misses: 1,
			lastOkAt: null,
			active: { 'THROUGHPUT:incident="abc",node="spoke"': "on" },
			series: [],
		};
		const alerts = diffAlerts(st, parseProm("unrelated_total 1"), null, 0);
		expect(alerts.map((a) => a.kind)).toEqual(["RECOVER"]);
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

describe("scrapeTarget admin join", () => {
	const adminServer = (gauge: string) =>
		Bun.serve({
			port: 0,
			fetch: (req) => {
				const path = new URL(req.url).pathname;
				if (path === "/status")
					return Response.json({ service: "stub", healthy: true });
				if (path === "/metrics") return new Response("http_requests_total 1");
				if (path === "/v1/admin/metrics") {
					if (req.headers.get("authorization") !== "Bearer fixture-admin-key")
						return new Response("denied", { status: 401 });
					return new Response(gauge);
				}
				return new Response("nope", { status: 404 });
			},
		});
	test("no key configured: admin face never scraped, no THROUGHPUT onset", async () => {
		const server = adminServer(
			'buckle_throughput_incident_active{node="spoke",incident="abc"} 1',
		);
		try {
			const s = freshState();
			expect(
				await scrapeTarget(s, `http://127.0.0.1:${server.port}`, 1),
			).toEqual([]);
		} finally {
			server.stop(true);
		}
	});
	test("key configured: joined admin gauge fires THROUGHPUT onset", async () => {
		const server = adminServer(
			'buckle_throughput_incident_active{node="spoke",incident="abc"} 1',
		);
		const saved = process.env.METRICS_ALERT_BUCKLE_ADMIN_KEY_FILE;
		const keyFile = join(import.meta.dir, "metrics-alert-admin-key-fixture");
		writeFileSync(keyFile, "BUCKLE_ADMIN_KEY=fixture-admin-key\n");
		try {
			process.env.METRICS_ALERT_BUCKLE_ADMIN_KEY_FILE = keyFile;
			const s = freshState();
			const alerts = await scrapeTarget(
				s,
				`http://127.0.0.1:${server.port}`,
				1,
			);
			expect(alerts.map((a) => a.kind)).toEqual(["THROUGHPUT"]);
			expect(
				s.targets[`http://127.0.0.1:${server.port}`]?.active[
					"THROUGHPUT:incident=abc,node=spoke"
				],
			).toBe("on");
		} finally {
			if (saved === undefined)
				delete process.env.METRICS_ALERT_BUCKLE_ADMIN_KEY_FILE;
			else process.env.METRICS_ALERT_BUCKLE_ADMIN_KEY_FILE = saved;
			Bun.spawnSync(["rm", "-f", keyFile]);
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
