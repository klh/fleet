import { expect, test } from "@playwright/test";
import {
	assessBuckleRoute,
	fetchBuckleRouteAudit,
	RouteAdmission,
} from "../scripts/lib/dispatch-admission.ts";
test.describe("@api", () => {

const now = Date.parse("2026-10-21T12:00:00.000Z");
const row = (ageMs: number, overrides: Record<string, unknown> = {}) => ({
	ts: new Date(now - ageMs).toISOString(),
	traffic_kind: "inference",
	hop: "origin",
	target_model: "glm-5.3-flash",
	target_kind: "local",
	target_host: "127.0.0.1",
	target_port: 4000,
	candidates_seen: 1,
	selected_target_exact: true,
	selected_target_attempted: false,
	status: 502,
	ok: 0,
	error_code: "no_route",
	attempts: 0,
	...overrides,
});

test("three exact internal failures pause only the selected model", () => {
	const rows = [row(1_000), row(2_000), row(3_000)];
	expect(assessBuckleRoute(rows, "glm-5.3-flash", now)).toEqual({
		pause: true,
		failures: 3,
	});
	expect(assessBuckleRoute(rows, "claude-sonnet-5", now).pause).toBe(false);
});

test("bare 429, upstream 503, mixed candidates and unattributed failures never pause", () => {
	for (const override of [
		{ status: 429, error_code: "rate_limited" },
		{ status: 503, error_code: "no_route", attempts: 1 },
		{ candidates_seen: 2 },
		{ selected_target_exact: false },
		{ target_host: null },
		{ target_host: "" },
		{ traffic_kind: "readiness" },
		{ hop: "forwarded" },
	]) {
		expect(
			assessBuckleRoute(
				[row(1_000, override), row(2_000, override), row(3_000, override)],
				"glm-5.3-flash",
				now,
			).pause,
		).toBe(false);
	}
});

test("three exact local_cold receipts hold only while their Retry-After is active", () => {
	const cold = (ageMs: number, overrides: Record<string, unknown> = {}) =>
		row(ageMs, {
			status: 429,
			error_code: "rate_limited",
			attempts: 1,
			selected_target_attempted: true,
			upstream_refusal_code: "local_cold",
			refusal_origin: "upstream",
			retry_after_ms: 5_000,
			...overrides,
		});
	const rows = [
		cold(1_000),
		cold(2_000, { refusal_origin: "bridged-upstream" }),
		cold(3_000),
	];
	expect(assessBuckleRoute(rows, "glm-5.3-flash", now).pause).toBe(true);
	expect(assessBuckleRoute(rows, "glm-5.3-flash", now + 4_000).pause).toBe(
		false,
	);
	for (const override of [
		{ selected_target_exact: false },
		{ selected_target_attempted: false },
		{ upstream_refusal_code: null },
		{ refusal_origin: "network" },
		{ retry_after_ms: null },
		{ retry_after_ms: 0 },
	])
		expect(
			assessBuckleRoute(
				[1_000, 2_000, 3_000].map((age) => cold(age, override)),
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
			"glm-5.3-flash",
			now,
		).pause,
	).toBe(false);
	expect(
		assessBuckleRoute(
			[row(91_000), row(92_000), row(93_000)],
			"glm-5.3-flash",
			now,
		).pause,
	).toBe(false);
	expect(
		assessBuckleRoute(
			[row(1_000), row(2_000), row(3_000), row(4_000, { target_port: 4100 })],
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

test("W1102.1: plaid fail-closed — unavailable audit holds, empty history permits", async () => {
	// [serve, expectPause, reason] — unavailable (throw/503) holds in plaid;
	// authenticated reachable EMPTY history is valid first-launch evidence
	const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
	const deadPort = dead.port;
	dead.stop(true);
	const cases: [string | (() => Response), boolean, string?][] = [
		[`http://127.0.0.1:${deadPort}`, true, "audit read unavailable"],
		[() => new Response(null, { status: 503 }), true, "audit read unavailable"],
		[() => Response.json({ requests: [] }), false],
	];
	for (const [serve, expectPause, reason] of cases) {
		const server = Bun.serve({
			port: 0,
			fetch: typeof serve === "function" ? serve : () => new Response("x"),
		});
		const front =
			typeof serve === "string" ? serve : `http://127.0.0.1:${server.port}`;
		try {
			const plaid = new RouteAdmission(
				true,
				async () => front,
				() => "fixture-admin",
				true,
			);
			const r = await plaid.check("glm-5.3-flash");
			expect(r.pause).toBe(expectPause);
			if (reason) expect(r.reason).toContain(reason);
			// steady posture (requireEvidence default false) NEVER holds here
			const steady = new RouteAdmission(
				true,
				async () => front,
				() => "fixture-admin",
			);
			expect((await steady.check("glm-5.3-flash")).pause).toBe(false);
		} finally {
			server.stop(true);
		}
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
		admission.invalidate();
		expect((await admission.check("glm-5.3-flash")).pause).toBe(true);
		expect(reads).toBe(2);
	} finally {
		server.stop(true);
	}
});

});
