import { expect, test } from "bun:test";
import { fetchBuckleRouteAuditVerdict } from "../scripts/lib/route-audit-read.ts";

const now = Date.parse("2026-10-21T12:00:00.000Z");

test("ok read: authenticated 2xx array rides as rows, single attempt", async () => {
	let calls = 0;
	let auth: string | null = null;
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			calls++;
			auth = request.headers.get("authorization");
			return Response.json({ requests: [] });
		},
	});
	try {
		const v = await fetchBuckleRouteAuditVerdict(
			`http://127.0.0.1:${server.port}`,
			"fixture-admin",
			"glm-5.3-flash",
			now,
			{ boundMs: 500 },
		);
		expect(v.kind).toBe("ok");
		expect(v.rows).toEqual([]);
		expect(v.status).toBe(200);
		expect(v.attempts).toBe(1);
		expect(v.note).toBe("");
		expect(auth).toBe("Bearer fixture-admin");
		expect(calls).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("401 answers once, never retried, note names the status", async () => {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls++;
			return new Response(null, { status: 401 });
		},
	});
	try {
		const v = await fetchBuckleRouteAuditVerdict(
			`http://127.0.0.1:${server.port}`,
			"fixture-admin",
			"glm-5.3-flash",
			now,
			{ boundMs: 500 },
		);
		expect(v.kind).toBe("status");
		expect(v.status).toBe(401);
		expect(v.attempts).toBe(1);
		expect(v.note).toContain("HTTP 401");
		expect(calls).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("persistent 5xx: one retry, verdict names the class and the retry", async () => {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls++;
			return new Response(null, { status: 503 });
		},
	});
	try {
		const v = await fetchBuckleRouteAuditVerdict(
			`http://127.0.0.1:${server.port}`,
			"fail-admin",
			"glm-5.3-flash",
			now,
			{ boundMs: 500, gapMs: 1 },
		);
		expect(v.kind).toBe("status");
		expect(v.status).toBe(503);
		expect(v.attempts).toBe(2);
		expect(v.note).toContain("HTTP 503");
		expect(v.note).toContain("retried once");
		expect(calls).toBe(2);
	} finally {
		server.stop(true);
	}
});

test("5xx-then-ok: the transient blip no longer holds (retry lands rows)", async () => {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls++;
			return calls === 1
				? new Response(null, { status: 503 })
				: Response.json({ requests: [] });
		},
	});
	try {
		const v = await fetchBuckleRouteAuditVerdict(
			`http://127.0.0.1:${server.port}`,
			"fail-admin",
			"glm-5.3-flash",
			now,
			{ boundMs: 500, gapMs: 1 },
		);
		expect(v.kind).toBe("ok");
		expect(v.attempts).toBe(2);
		expect(v.rows).toEqual([]);
	} finally {
		server.stop(true);
	}
});

test("odd 2xx shape answers once, never retried", async () => {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			calls++;
			return Response.json({});
		},
	});
	try {
		const v = await fetchBuckleRouteAuditVerdict(
			`http://127.0.0.1:${server.port}`,
			"fail-admin",
			"glm-5.3-flash",
			now,
			{ boundMs: 500 },
		);
		expect(v.kind).toBe("shape");
		expect(v.attempts).toBe(1);
		expect(v.note).toContain("unexpected body shape");
		expect(calls).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("hung front times out twice then holds, note names the bound", async () => {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async () => {
			calls++;
			await Bun.sleep(10_000);
			return Response.json({ requests: [] });
		},
	});
	try {
		const v = await fetchBuckleRouteAuditVerdict(
			`http://127.0.0.1:${server.port}`,
			"fail-admin",
			"glm-5.3-flash",
			now,
			{ boundMs: 60, gapMs: 1 },
		);
		expect(v.kind).toBe("timeout");
		expect(v.attempts).toBe(2);
		expect(v.note).toContain("(bound 60ms)");
		expect(v.note).toContain("retried once");
		expect(calls).toBe(2);
	} finally {
		server.stop(true);
	}
});

test("closed front is unreachable, retried once, then holds", async () => {
	const v = await fetchBuckleRouteAuditVerdict(
		"http://127.0.0.1:1",
		"fail-admin",
		"glm-5.3-flash",
		now,
		{ boundMs: 500, gapMs: 1 },
	);
	expect(v.kind).toBe("unreachable");
	expect(v.attempts).toBe(2);
	expect(v.note).toContain("unreachable");
});

test("missing front/token/model never wires a read", async () => {
	const v = await fetchBuckleRouteAuditVerdict(
		null,
		"some-token",
		"glm-5.3-flash",
		now,
	);
	expect(v.kind).toBe("unconfigured");
	expect(v.attempts).toBe(0);
	expect(v.rows).toBeNull();
});
