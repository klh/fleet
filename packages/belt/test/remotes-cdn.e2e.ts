// test/remotes-cdn.test.ts — W308: CDN-fronted TLS endpoints (z.ai 421).
// endpointUrl keeps the DNS hostname in the tls-leg URLs (SNI/Host must
// match the CDN vhost) and cdnFetch pins one connection per request with
// a single 421 fresh-connection retry. Connection behavior rides a real
// stub server; the tls-leg URL wiring is asserted via a stubbed global
// fetch, because a live TLS leg would need a trusted cert that an offline
// unit run cannot mint.
import { expect, test } from "@playwright/test";
import {
	catalogFor,
	cdnFetch,
	endpointUrl,
	probeEndpoint,
	routeTask,
} from "../bin/remotes.ts";
import type { RemoteEndpoint, RemoteMachine } from "../bin/remotes.ts";

const counts = new Map<string, number>();
const seenConn: (string | null)[] = [];
const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
		seenConn.push(req.headers.get("connection"));
		if (url.pathname === "/421-then-200")
			return counts.get(url.pathname) === 1
				? new Response("misdirected", { status: 421 })
				: Response.json({ ok: true });
		if (url.pathname === "/always-500")
			return new Response("boom", { status: 500 });
		if (url.pathname === "/models")
			return Response.json({ data: [{ id: "cloud-m" }] });
		if (url.pathname === "/v1/models")
			return Response.json({ data: [{ id: "m-a" }] });
		return new Response("nope", { status: 400 });
	},
});
test.afterAll(() => {
	stub.stop(true);
});

const machine = (host = "stub.invalid"): RemoteMachine => ({
	name: "w308stub",
	host,
	ip_fallback: "127.0.0.1",
	endpoints: [],
});

const ep = (
	port: number,
	extra: Partial<RemoteEndpoint> = {},
): RemoteEndpoint => ({
	port,
	protocol: "openai",
	roles: ["general"],
	model: "m-default",
	...extra,
});

test("cdnFetch: connection: close rides every request (stub-observed) @unit", async () => {
	const before = seenConn.length;
	const r = await cdnFetch(`http://127.0.0.1:${stub.port}/v1/models`);
	expect(r.ok).toBe(true);
	expect(seenConn.slice(before)).toEqual(["close"]);
});

test("cdnFetch: 421 gets ONE fresh-connection retry @unit", async () => {
	const r = await cdnFetch(`http://127.0.0.1:${stub.port}/421-then-200`);
	expect(r.status).toBe(200);
	expect(counts.get("/421-then-200")).toBe(2);
});

test("cdnFetch: non-421 failures never retry (500 stays once) @unit", async () => {
	const r = await cdnFetch(`http://127.0.0.1:${stub.port}/always-500`);
	expect(r.status).toBe(500);
	expect(counts.get("/always-500")).toBe(1);
});

test("endpointUrl: base verbatim, tls by hostname, lan by ip @unit", () => {
	// machine() uses stub.invalid — unresolvable, so the lan leg rides the
	// ip_fallback deterministically (DNS-first would grab a live IP for a
	// real host like api.z.ai, which is correct product behavior).
	const m = machine();
	expect(
		endpointUrl(
			m,
			ep(443, { base: "https://api.z.ai/api/paas/v4" }),
			"/models",
		),
	).toBe("https://api.z.ai/api/paas/v4/models");
	expect(endpointUrl(m, ep(443, { tls: true }), "/v1/models")).toBe(
		"https://stub.invalid:443/v1/models",
	);
	expect(endpointUrl(m, ep(8123), "/health")).toBe(
		"http://127.0.0.1:8123/health",
	);
	expect(
		endpointUrl({ ...m, ip_fallback: undefined }, ep(8123), "/health"),
	).toBeNull();
});

test("probe + route + catalog on a tls endpoint ride https by hostname @unit", async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (
		url: string | URL | globalThis.Request,
		init?: RequestInit,
	) => {
		calls.push({ url: String(url), init });
		if (String(url).endsWith("/v1/chat/completions"))
			return Response.json({
				choices: [{ message: { content: "ECHO" } }],
			});
		return Response.json({ ok: true, data: [{ id: "tls-m" }] });
	}) as unknown as typeof fetch;
	try {
		const m = machine("api.z.ai");
		const tls = ep(443, { tls: true, api_key: "k-w308" });
		const urls = (): string[] => calls.map((c) => c.url);
		expect(await probeEndpoint(m, tls)).toBe(true);
		expect(await catalogFor(m, tls)).toEqual(["tls-m"]);
		expect(await routeTask(m, tls, "hi")).toBe("ECHO");
		expect(urls()).toEqual([
			"https://api.z.ai:443/v1/models",
			"https://api.z.ai:443/v1/models",
			"https://api.z.ai:443/v1/chat/completions",
		]);
		const closed = calls.every(
			(c) =>
				(c.init?.headers as Record<string, string> | undefined)?.connection ===
				"close",
		);
		expect(closed).toBe(true);
	} finally {
		globalThis.fetch = original;
	}
});

test("anthropic protocol: probe rides /v1/models with x-api-key; routeTask fails closed @unit", async () => {
	const calls: { init?: RequestInit }[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (
		_url: string | URL | globalThis.Request,
		init?: RequestInit,
	) => {
		calls.push({ init });
		return Response.json({ data: [{ id: "a-m" }] });
	}) as unknown as typeof fetch;
	try {
		const m = machine("api.anthropic.com");
		const anth = ep(443, {
			tls: true,
			protocol: "anthropic",
			api_key: "sk-ant-test",
		});
		expect(await probeEndpoint(m, anth)).toBe(true);
		expect(await catalogFor(m, anth)).toEqual(["a-m"]);
		await assertAnthropicHeaders(calls);
		await expectAnthropicRouteFail(m, anth);
	} finally {
		globalThis.fetch = original;
	}
});

async function assertAnthropicHeaders(
	calls: { init?: RequestInit }[],
): Promise<void> {
	const hdr = (c: { init?: RequestInit }): string | undefined => {
		const h = c.init?.headers as Record<string, string> | undefined;
		return h ? h["x-api-key"] : undefined;
	};
	const auth = (c: { init?: RequestInit }): string | undefined => {
		const h = c.init?.headers as Record<string, string> | undefined;
		return h ? h.authorization : undefined;
	};
	expect(calls.slice(0, 2).every((c) => hdr(c) === "sk-ant-test")).toBe(true);
	expect(calls.every((c) => auth(c) === undefined)).toBe(true);
}

async function expectAnthropicRouteFail(
	m: RemoteMachine,
	anth: RemoteEndpoint,
): Promise<void> {
	expect(routeTask(m, anth, "hi")).rejects.toThrow(
		"anthropic-protocol — belt routes openai-wire tasks only",
	);
}
