// test/trace-url.e2e.ts — W2268: the clickable details link on every
// client-visible Fleet error. The URL base is operator config, HTTPS or
// loopback HTTP only; encoding is deterministic; unconfigured stays inert
// (no fabricated page); the trace marker/detail contract is unchanged.
import { expect, test } from "@playwright/test";
import {
	traceErrorResponse,
	traceStreamErrorPayload,
} from "../src/error-trace.ts";
import { traceUrl, traceUrlBase } from "../src/trace-url.ts";

const ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${ID}-00f067aa0ba902b7-01`;
const req = () =>
	new Request("http://local.test/v1/messages", {
		headers: { traceparent: TRACEPARENT },
	});

test("traceUrlBase accepts https and loopback http, rejects everything else @unit", () => {
	expect(
		traceUrlBase({
			BUCKLE_TRACE_URL_BASE: "https://nas.example:7809",
		})?.toString(),
	).toBe("https://nas.example:7809/");
	expect(
		traceUrlBase({ BUCKLE_TRACE_URL_BASE: "http://127.0.0.1:7799" })?.hostname,
	).toBe("127.0.0.1");
	expect(
		traceUrlBase({ BUCKLE_TRACE_URL_BASE: "http://localhost:7799" })?.hostname,
	).toBe("localhost");
	expect(
		traceUrlBase({ BUCKLE_TRACE_URL_BASE: "http://[::1]:7799" }),
	).not.toBeNull();
	// plain http off-loopback, credentials, query and junk all refuse
	expect(
		traceUrlBase({ BUCKLE_TRACE_URL_BASE: "http://nas.example:7799" }),
	).toBeNull();
	expect(
		traceUrlBase({ BUCKLE_TRACE_URL_BASE: "https://user:pw@nas.example" }),
	).toBeNull();
	expect(
		traceUrlBase({ BUCKLE_TRACE_URL_BASE: "https://nas.example?x=1" }),
	).toBeNull();
	expect(
		traceUrlBase({ BUCKLE_TRACE_URL_BASE: "ftp://nas.example" }),
	).toBeNull();
	expect(traceUrlBase({ BUCKLE_TRACE_URL_BASE: "not a url" })).toBeNull();
	expect(traceUrlBase({})).toBeNull();
	expect(traceUrlBase({ BUCKLE_TRACE_URL_BASE: "" })).toBeNull();
});

test("traceUrl encodes deterministically and never for a bad id @unit", () => {
	const url = traceUrl(ID, { BUCKLE_TRACE_URL_BASE: "https://board.example" });
	expect(url).toBe(`https://board.example/console/trace?trace_id=${ID}`);
	// trailing slashes on the base collapse; the id stays the only param
	expect(
		traceUrl(ID, { BUCKLE_TRACE_URL_BASE: "https://board.example/sub/" }),
	).toBe(`https://board.example/sub/console/trace?trace_id=${ID}`);
	expect(
		traceUrl("not-a-trace-id", {
			BUCKLE_TRACE_URL_BASE: "https://board.example",
		}),
	).toBeNull();
	expect(traceUrl(ID, {})).toBeNull();
});

test("JSON error bodies carry trace_url only when the base is configured @unit", async () => {
	const provider = () =>
		Response.json(
			{
				type: "/problems/upstream_error",
				code: "no_route",
				detail: "failed",
				why: "failed",
			},
			{ status: 502 },
		);
	const inert = await (
		await traceErrorResponse(req(), provider(), "desktop")
	).json();
	// unconfigured base: NO key in the payload (absent, not null — the
	// envelope gains nothing when no details page exists)
	expect(inert).not.toHaveProperty("trace_url");
	expect(inert.detail).toContain(`trace=${ID}`);

	process.env.BUCKLE_TRACE_URL_BASE = "http://127.0.0.1:7799";
	try {
		const linked = await (
			await traceErrorResponse(req(), provider(), "desktop")
		).json();
		expect(linked.trace_url).toBe(
			`http://127.0.0.1:7799/console/trace?trace_id=${ID}`,
		);
		// the marker contract is untouched by the link
		expect(linked.detail).toContain(`trace=${ID}; origin=desktop`);
	} finally {
		delete process.env.BUCKLE_TRACE_URL_BASE;
	}
});

test("SSE error payloads carry the same trace_url affordance @unit", () => {
	process.env.BUCKLE_TRACE_URL_BASE = "https://board.example";
	try {
		const payload = traceStreamErrorPayload(
			JSON.stringify({
				type: "error",
				error: { type: "overloaded_error", message: "busy" },
			}),
			new Response("x", { status: 200 }),
			ID,
			"desktop",
			"r1",
			"upstream-1",
		);
		const body = JSON.parse(payload) as Record<string, unknown>;
		expect(body.trace_url).toBe(
			`https://board.example/console/trace?trace_id=${ID}`,
		);
	} finally {
		delete process.env.BUCKLE_TRACE_URL_BASE;
	}
});
