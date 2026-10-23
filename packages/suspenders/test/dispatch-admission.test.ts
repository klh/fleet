import { expect, test } from "bun:test";
import {
	assessBuckleRoute,
	fetchBuckleColdReceipts,
	fetchBuckleRouteAudit,
	RouteAdmission,
} from "../scripts/lib/dispatch-admission.ts";

const now = Date.parse("2026-10-21T12:00:00.000Z");
const TRACE = "a".repeat(32);
const row = (ageMs: number, overrides: Record<string, unknown> = {}) => ({
	ts: new Date(now - ageMs).toISOString(),
	traffic_kind: "inference",
	hop: "origin",
	trace_id: TRACE,
	target_model: "glm-5.3-flash",
	target_kind: "local",
	target_host: "127.0.0.1",
	target_port: 4000,
	candidates_seen: 1,
	status: 502,
	ok: 0,
	error_code: "no_route",
	attempts: 0,
	...overrides,
});

test("three exact internal failures pause only the selected model", () => {
	const rows = [row(1_000), row(2_000), row(3_000)];
	expect(assessBuckleRoute(rows, null, "glm-5.3-flash", now)).toEqual({
		pause: true,
		failures: 3,
	});
	expect(assessBuckleRoute(rows, null, "claude-sonnet-5", now).pause).toBe(
		false,
	);
});

test("bare 429, upstream 503, mixed candidates and unattributed failures never pause", () => {
	for (const override of [
		{ status: 429, error_code: "rate_limited" },
		{ status: 503, error_code: "no_route", attempts: 1 },
		{ candidates_seen: 2 },
		{ trace_id: "z".repeat(32) },
		{ trace_id: "nothex" },
		{ target_host: null },
		{ target_host: "" },
		{ traffic_kind: "readiness" },
		{ hop: "forwarded" },
	]) {
		expect(
			assessBuckleRoute(
				[row(1_000, override), row(2_000, override), row(3_000, override)],
				new Map(),
				"glm-5.3-flash",
				now,
			).pause,
		).toBe(false);
	}
});

test("cold receipts: local-port 429+Retry-After holds until expiry; cloud and bare never", () => {
	const cold = (ageMs: number, overrides: Record<string, unknown> = {}) =>
		row(ageMs, { status: 429, error_code: null, attempts: 1, ...overrides });
	const receipt = (ageMs: number, overrides: Record<string, unknown> = {}) => ({
		ts: new Date(now - ageMs).toISOString(),
		hop: ":8902",
		port: 8902,
		status: 429,
		retry_after_ms: 5_000,
		failure_kind: "http",
		...overrides,
	});
	// one trace per request: each row's receipt rides its own trace
	const TRACES = [TRACE, "b".repeat(32), "c".repeat(32)];
	const rows = TRACES.map((trace_id, i) => cold((i + 1) * 1_000, { trace_id }));
	const perRow = (make: (ageMs: number) => unknown[]) =>
		new Map(TRACES.map((trace_id, i) => [trace_id, make((i + 1) * 1_000)]));
	const hot = perRow((ageMs) => [receipt(ageMs)]);
	expect(assessBuckleRoute(rows, hot, "glm-5.3-flash", now).pause).toBe(true);
	// expired Retry-After → the route clears (TTL)
	expect(assessBuckleRoute(rows, hot, "glm-5.3-flash", now + 4_000).pause).toBe(
		false,
	);
	// cloud-port receipts can never type the row cold
	for (const port of [0, 4100]) {
		const cloud = perRow((ageMs) => [receipt(ageMs, { port })]);
		expect(assessBuckleRoute(rows, cloud, "glm-5.3-flash", now).pause).toBe(
			false,
		);
	}
	// receipts without Retry-After = bare 429s, never count
	const bare = perRow((ageMs) => [receipt(ageMs, { retry_after_ms: null })]);
	expect(assessBuckleRoute(rows, bare, "glm-5.3-flash", now).pause).toBe(false);
	// no receipts at all = bare 429, never counts
	expect(assessBuckleRoute(rows, new Map(), "glm-5.3-flash", now).pause).toBe(
		false,
	);
	// only the row's own trace receipts type it: one receipted trace + two
	// bare traces = a single failure, never a pause
	expect(
		assessBuckleRoute(
			rows,
			new Map([[TRACE, [receipt(1_000)]]]),
			"glm-5.3-flash",
			now,
		).pause,
	).toBe(false);
});

test("later success clears, stale failures expire, alternate targets stay unknown", () => {
	expect(
		assessBuckleRoute(
			[
				row(500, { status: 200, ok: 1, error_code: null }),
				row(1_000),
				row(2_000),
				row(3_000),
			],
			new Map(),
			"glm-5.3-flash",
			now,
		).pause,
	).toBe(false);
	expect(
		assessBuckleRoute(
			[row(91_000), row(92_000), row(93_000)],
			new Map(),
			"glm-5.3-flash",
			now,
		).pause,
	).toBe(false);
	expect(
		assessBuckleRoute(
			[row(1_000), row(2_000), row(3_000), row(4_000, { target_port: 4100 })],
			new Map(),
			"glm-5.3-flash",
			now,
		).pause,
	).toBe(false);
});

test("audit fetch is authenticated, bounded and rejects missing evidence", async () => {
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			seen.push(new URL(request.url).pathname);
			if (request.headers.get("authorization") !== "Bearer fixture-admin")
				return new Response(null, { status: 401 });
			return Response.json({ requests: [row(1_000)] });
		},
	});
	try {
		const front = `http://127.0.0.1:${server.port}`;
		expect(
			await fetchBuckleRouteAudit(front, null, "glm-5.3-flash", now),
		).toBeNull();
		expect(
			await fetchBuckleRouteAudit(front, "fixture-admin", "glm-5.3-flash", now),
		).toHaveLength(1);
		expect(seen).toEqual(["/v1/admin/requests"]);
	} finally {
		server.stop(true);
	}
});

test("one audit read per selected model, with no read for an unpinned lane", async () => {
	let reads = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			reads++;
			return Response.json({
				requests: [row(1_000), row(2_000), row(3_000)].map((r) => ({
					...r,
					ts: new Date(Date.now() - 1_000).toISOString(),
				})),
			});
		},
	});
	try {
		const admission = new RouteAdmission(
			true,
			async () => `http://127.0.0.1:${server.port}`,
			() => "fixture-admin",
		);
		expect((await admission.check(null)).pause).toBe(false);
		expect(reads).toBe(0);
		expect((await admission.check("glm-5.3-flash")).pause).toBe(true);
		expect((await admission.check("glm-5.3-flash")).pause).toBe(true);
		expect(reads).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("cold-receipt fetch is authenticated, hex-gated and capped", async () => {
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const url = new URL(request.url);
			seen.push(`${request.method} ${url.pathname}?${url.searchParams}`);
			if (request.headers.get("authorization") !== "Bearer fixture-admin")
				return new Response(null, { status: 401 });
			return Response.json({
				belt: {
					status: "ok",
					attempts: [
						{
							ts: new Date(now - 1_000).toISOString(),
							port: 8902,
							status: 429,
							retry_after_ms: 5_000,
						},
					],
				},
			});
		},
	});
	try {
		const front = `http://127.0.0.1:${server.port}`;
		const out = await fetchBuckleColdReceipts(front, "fixture-admin", [
			TRACE,
			"nothex",
			"Z".repeat(32),
		]);
		expect(out.get(TRACE)?.[0].port).toBe(8902);
		expect(out.size).toBe(1);
		expect(seen).toEqual([`GET /v1/admin/traces?trace_id=${TRACE}`]);
	} finally {
		server.stop(true);
	}
});
