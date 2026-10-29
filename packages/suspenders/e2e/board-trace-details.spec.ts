// e2e/board-trace-details.spec.ts — W2268: the clickable Fleet error trace
// details page on the live board. /console/trace?trace_id= resolves through
// the SERVER-HELD admin key against a stub Buckle (test-kit serveStub) — the
// browser never sees a credential; the W264 host perimeter guards the page.
// Covers: deep link render, admin-key auth from the server side, unknown /
// missing / malformed ids, 429 and 503 from Buckle, and the relayed hop
// chain. Real fleet-board.ts via board-harness; no secrets in the spec.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStub } from "@klh/test-kit";
import { type Board, startBoard } from "../test/helpers/board-harness";

const ID = "4bf92f3577b34da6a3ce929d0e0e4736";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;
// The stub Buckle admin API: every /v1/admin/traces call is recorded with
// its authorization header — the spec asserts the SERVER sent the admin key.
let buckle: ReturnType<typeof serveStub> | null = null;
let beltHome = "";

/** A plausible Buckle traces answer for the relay case (inner hub + local). */
const relayAnswer = () => {
	const t = new Date().toISOString();
	return {
		trace_id: ID,
		requests: [
			{
				rid: "outer-1",
				ts: t,
				status: 502,
				ok: 0,
				decision: "routed",
				error_code: "no_route",
				why: "no entitled upstream",
				target_kind: "buckle",
				target_host: "127.0.0.1",
				target_port: 4101,
				target_model: null,
				duration_ms: 41,
			},
		],
		attempts: [
			{
				rid: "outer-1",
				ordinal: 1,
				ts: t,
				hop: "desktop",
				status: 502,
				refusal: "no_route",
				refusal_origin: "desktop",
				upstream_refusal_code: null,
				provider_error_code: null,
				provider_error_type: null,
				duration_ms: 41,
				retry_after_ms: null,
				call_id: "call-7",
				candidate: "sha:9f",
				provider_pool: null,
				queue_wait_ms: 3,
			},
			{
				rid: "outer-1",
				ordinal: 2,
				ts: t,
				hop: "zai",
				status: 429,
				refusal: "rate_limited",
				refusal_origin: "provider",
				upstream_refusal_code: "429",
				provider_error_code: "rate_limit_exceeded",
				provider_error_type: "rate_limit_error",
				duration_ms: 12,
				retry_after_ms: 3000,
				call_id: "call-8",
				candidate: "sha:1c",
				provider_pool: "zai",
				queue_wait_ms: 0,
			},
		],
	};
};

test.beforeAll(async () => {
	// The stub Buckle default: a full relay-shaped answer for the happy path.
	buckle = serveStub((req) => {
		const id = new URL(req.url).searchParams.get("trace_id") ?? "";
		if (id === "4290000000000000000000000000ff29")
			return Response.json({ error: "rate limited" }, { status: 429 });
		if (id === "5030000000000000000000000000ff53")
			return Response.json({ error: "unavailable" }, { status: 503 });
		if (id === ID) return Response.json(relayAnswer());
		return Response.json({ trace_id: id, requests: [], attempts: [] });
	});
	// A scratch belt env carrying the admin key the board must present to
	// the stub (the harness HOME is the board's own — pin the env vars).
	beltHome = mkdtempSync(join(tmpdir(), "w2268-belt-home-"));
	writeFileSync(
		join(beltHome, "belt.env"),
		"BUCKLE_ADMIN_KEY=bksk-w2268-test\n",
	);
	board = await startBoard("board-trace-details", {
		env: {
			BUCKLE_ADMIN_KEY: "bksk-w2268-test",
			SUSPENDERS_BUCKLE_FRONT: buckle.url,
		},
	});
});

test.afterAll(async () => {
	if (board) await board.stop();
	if (buckle) buckle.close();
	if (beltHome) rmSync(beltHome, { recursive: true, force: true });
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("deep link renders request status, hop chain, timings and refusal source", {
	tag: "@ui",
}, async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/console/trace?trace_id=${ID}`);
	await expect(page.locator("h1.ptitle")).toContainText("Fleet trace");
	const requests = page.locator(".panel", { hasText: "requests" });
	const attempts = page.locator(".panel", { hasText: "hop attempts" });
	// request row: status + sanitized target
	await expect(requests.locator("table.ct")).toContainText("502");
	await expect(requests.locator("table.ct")).toContainText("127.0.0.1:4101");
	// hop chain: both hubs in walk order + refusal source + provider error
	await expect(attempts.locator("table.ct")).toContainText("desktop");
	await expect(attempts.locator("table.ct")).toContainText("zai");
	await expect(attempts.locator("table.ct")).toContainText(
		"rate_limit_exceeded",
	);
	await expect(attempts.locator("table.ct")).toContainText("call-8");
	expect(errors, "uncaught page exceptions").toEqual([]);
});

test("the board resolved the trace with the server-held admin key", async () => {
	const calls = (buckle?.requests ?? []).filter(
		(r) => r.path === "/v1/admin/traces",
	);
	expect(calls.length, "at least one admin traces call").toBeGreaterThan(0);
	expect(calls[0]?.auth).toBe("Bearer bksk-w2268-test");
	expect(calls[0]?.headers.get("authorization")).not.toContain("undefined");
});

test("unknown trace says so — never a fabricated page", { tag: "@ui" }, async ({
	page,
}) => {
	await page.goto(
		`${mustBoard().BASE}/console/trace?trace_id=${"0".repeat(31)}1`,
	);
	await expect(page.locator(".errbox")).toContainText(
		"Unknown or expired trace",
	);
});

test("malformed / missing trace_id is rejected", async () => {
	const bad = await fetch(`${mustBoard().BASE}/api/trace?trace_id=zz`);
	expect(bad.status).toBe(400);
	const html = await fetch(`${mustBoard().BASE}/console/trace`);
	expect(html.status).toBe(200);
	const body = await html.text();
	expect(body).toContain("32 lowercase hex");
});

test("429 from Buckle surfaces honestly", async () => {
	const r = await fetch(
		`${mustBoard().BASE}/api/trace?trace_id=4290000000000000000000000000ff29`,
	);
	const body = (await r.json()) as { state?: string; httpStatus?: number };
	expect(body.state).toBe("http_error");
	expect(body.httpStatus).toBe(429);
});

test("503 from Buckle surfaces honestly", async () => {
	const r = await fetch(
		`${mustBoard().BASE}/api/trace?trace_id=5030000000000000000000000000ff53`,
	);
	const body = (await r.json()) as { state?: string; httpStatus?: number };
	expect(body.state).toBe("http_error");
	expect(body.httpStatus).toBe(503);
});

test("unreachable Buckle degrades to an honest unreachable state", async () => {
	// point a second board at a dead port: no admin API answers at all
	const dead = await startBoard("board-trace-details-dead", {
		env: {
			BUCKLE_ADMIN_KEY: "bksk-w2268-test",
			SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
		},
	});
	try {
		const r = await fetch(`${dead.BASE}/api/trace?trace_id=${ID}`);
		const body = (await r.json()) as { state?: string };
		expect(body.state).toBe("unreachable");
	} finally {
		await dead.stop();
	}
});
