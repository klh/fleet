// W1238.5 — http-kit unit tests: the shared kind table (kind ↔ status
// coherence), the one problem+json shape, the Retry-After parse/cap rule,
// conditional requests (ETag/If-None-Match/If-Match) and the idempotency
// replay primitive.
import { describe, expect, test } from "bun:test";
import {
	capRetryAfterS,
	etagJson,
	etagOf,
	idempotentPost,
	ifMatchHits,
	ifNoneMatchHits,
	IdempotencyCache,
	KINDS,
	parseRetryAfterS,
	problem,
	preconditionFailed,
	requestFingerprint,
	statusKind,
	type SemanticKind,
} from "../src/http-kit.ts";

const req = (path: string, method = "GET", headers?: HeadersInit): Request =>
	new Request(`http://kit.local${path}`, { method, headers });

describe("semantic kinds — one table", () => {
	test("every kind's default status round-trips through statusKind", () => {
		for (const [kind, meta] of Object.entries(KINDS)) {
			const viaStatus = statusKind(meta.status);
			expect(viaStatus).toBe(kind as SemanticKind);
		}
	});

	test("unmapped statuses fall back to server / bad_request", () => {
		expect(statusKind(505)).toBe("server");
		expect(statusKind(418)).toBe("bad_request");
		expect(statusKind(200)).toBe("bad_request");
		expect(statusKind(302)).toBe("bad_request");
	});

	test("412 rides state_conflict (stale-copy semantics)", () => {
		expect(statusKind(412)).toBe("state_conflict");
	});

	test("failure kinds retry; client-error kinds never do", () => {
		expect(KINDS.rate_limited.retryable).toBe(true);
		expect(KINDS.overloaded.retryable).toBe(true);
		expect(KINDS.timeout.retryable).toBe(true);
		expect(KINDS.network.retryable).toBe(true);
		expect(KINDS.server.retryable).toBe(true);
		expect(KINDS.auth.retryable).toBe(false);
		expect(KINDS.bad_request.retryable).toBe(false);
		expect(KINDS.not_found.retryable).toBe(false);
	});
});

describe("problem+json — the one shape", () => {
	test("carries kind + code + why + instance + next steps", async () => {
		const res = problem({
			service: "buckle",
			status: 429,
			code: "buckle.rate_limit_error",
			why: "slow down",
			instance: "/v1/messages",
			next: ["wait Retry-After seconds before the next dispatch"],
		});
		expect(res.status).toBe(429);
		expect(res.headers.get("content-type")).toBe("application/problem+json");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			type: "/problems/rate_limited",
			kind: "rate_limited",
			title: "Too Many Requests",
			status: 429,
			detail: "slow down",
			instance: "/v1/messages",
			code: "buckle.rate_limit_error",
			why: "slow down",
			agent_next_steps: ["wait Retry-After seconds before the next dispatch"],
		});
	});

	test("title defaults from status; override honored; detail can differ from why", async () => {
		const res = problem({
			service: "belt",
			hop: "ingress",
			status: 429,
			code: "belt.rate_limited",
			why: "rpm window spent",
			detail: "slow down",
			title: "Slow Down",
		});
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.title).toBe("Slow Down");
		expect(body.detail).toBe("slow down");
		expect(body.why).toBe("rpm window spent");
	});

	test("kind defaults from status; challenge and extra headers pass through", async () => {
		const res = problem({
			service: "buckle",
			status: 401,
			code: "buckle.auth_required",
			why: "no credential",
			challenge: 'Bearer realm="buckle"',
			headers: { "retry-after": "7" },
		});
		expect(res.headers.get("www-authenticate")).toBe('Bearer realm="buckle"');
		expect(res.headers.get("retry-after")).toBe("7");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.kind).toBe("auth");
		expect(body.type).toBe("/problems/auth");
	});

	test("emitter identity rides the hop headers; refusal = code suffix", async () => {
		const res = problem({
			service: "belt",
			hop: "ingress",
			status: 405,
			code: "belt.method_not_allowed",
			why: "allows: GET, OPTIONS",
		});
		expect(res.headers.get("x-klh-service")).toBe("belt");
		expect(res.headers.get("x-klh-hop")).toBe("ingress");
		expect(res.headers.get("x-klh-refusal")).toBe("method_not_allowed");
	});

	test("preconditionFailed → 412 + state_conflict", async () => {
		const res = preconditionFailed("belt", "/api/x");
		expect(res.status).toBe(412);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.kind).toBe("state_conflict");
		expect(body.code).toBe("belt.precondition_failed");
	});
});

describe("retry-after — parse + one cap", () => {
	test("delta-seconds, decimals, HTTP-date; empty/garbage/negative → null", () => {
		expect(parseRetryAfterS("120")).toBe(120);
		expect(parseRetryAfterS("0.5")).toBe(0.5);
		expect(
			parseRetryAfterS(
				"Fri, 02 Oct 2026 00:00:03 GMT",
				() => 1_790_899_200_000,
			),
		).toBe(3);
		expect(parseRetryAfterS(null)).toBe(null);
		expect(parseRetryAfterS("")).toBe(null);
		expect(parseRetryAfterS("soon")).toBe(null);
		expect(parseRetryAfterS("-1")).toBe(null);
	});

	test("Headers form parses; cap clamps to [0, cap]; null passes through", () => {
		expect(parseRetryAfterS(new Headers({ "retry-after": "42" }))).toBe(42);
		expect(capRetryAfterS(259_200, 300)).toBe(300);
		expect(capRetryAfterS(-5, 300)).toBe(0);
		expect(capRetryAfterS(null)).toBe(null);
		expect(capRetryAfterS(undefined)).toBe(null);
		expect(capRetryAfterS(7, 300)).toBe(7);
	});
});

describe("conditional requests", () => {
	test("etagOf is a stable quoted sha256 prefix; body change moves it", () => {
		expect(etagOf('{"a":1}')).toBe(etagOf('{"a":1}'));
		expect(etagOf('{"a":1}')).toMatch(/^"[0-9a-f]{32}"$/);
		expect(etagOf('{"a":1}')).not.toBe(etagOf('{"a":2}'));
	});

	test("If-None-Match weak comparison: W/, lists, *", () => {
		expect(ifNoneMatchHits('W/"abc"', '"abc"')).toBe(true);
		expect(ifNoneMatchHits('"x", "abc"', '"abc"')).toBe(true);
		expect(ifNoneMatchHits("*", '"abc"')).toBe(true);
		expect(ifNoneMatchHits(null, '"abc"')).toBe(false);
	});

	test("If-Match is STRONG: a weak W/ entry never matches", () => {
		expect(ifMatchHits('"abc"', '"abc"')).toBe(true);
		expect(ifMatchHits("*", '"abc"')).toBe(true);
		expect(ifMatchHits('W/"abc"', '"abc"')).toBe(false);
		expect(ifMatchHits(null, '"abc"')).toBe(false);
	});

	test("etagJson: 200 + ETag, then 304 with ETag echo on a hit", () => {
		const r1 = etagJson(req("/api/status"), '{"ts":"t1"}');
		expect(r1.status).toBe(200);
		const etag = r1.headers.get("etag");
		expect(etag).not.toBeNull();
		const r2 = etagJson(
			req("/api/status", "GET", { "if-none-match": etag ?? "" }),
			'{"ts":"t1"}',
		);
		expect(r2.status).toBe(304);
		expect(r2.headers.get("etag")).toBe(etag);
	});
});

describe("idempotency — bounded replay", () => {
	test("cache: hit, miss, mismatch, TTL expiry, ring eviction", () => {
		let t = 1_000;
		const c = new IdempotencyCache(2, 60_000, () => t);
		const r1 = { status: 200, headers: {}, body: "one" };
		c.store("k1", "fp1", r1);
		expect(c.replay("k1", "fp1")).toEqual(r1);
		expect(c.replay("k1", "fpX")).toBe("mismatch");
		expect(c.replay("kX", "fp1")).toBe(null);
		t += 61_000;
		expect(c.replay("k1", "fp1")).toBe(null); // expired
		c.store("k1", "fp1", r1);
		c.store("k2", "fp2", { status: 200, headers: {}, body: "two" });
		c.store("k3", "fp3", { status: 200, headers: {}, body: "three" });
		expect(c.replay("k1", "fp1")).toBe(null); // ring-evicted (cap 2)
	});

	test("idempotentPost: no key → straight through with the original req", async () => {
		let sawRequest = false;
		const res = await idempotentPost(
			req("/x", "POST"),
			"svc",
			async (r) => {
				sawRequest = r !== null;
				return new Response('{"ok":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			new IdempotencyCache(),
		);
		expect(sawRequest).toBe(true);
		expect(res.status).toBe(200);
		expect(res.headers.get("idempotency-replayed")).toBeNull();
	});

	test("requestFingerprint: deterministic for equal requests, covers body", () => {
		const a = requestFingerprint(req("/x", "POST"), '{"a":1}');
		const b = requestFingerprint(req("/x", "POST"), '{"a":1}');
		const c = requestFingerprint(req("/x", "POST"), '{"a":2}');
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	test("replay hit: stored status/body again + idempotency-replayed header", async () => {
		const cache = new IdempotencyCache();
		const run = () =>
			idempotentPost(
				req("/x", "POST", { "idempotency-key": "k-1" }),
				"svc",
				async (r) =>
					new Response(`echo: ${await r.text()}`, {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				cache,
			);
		const first = await run();
		expect(first.status).toBe(201);
		expect(first.headers.get("idempotency-replayed")).toBeNull();
		const second = await run();
		expect(second.status).toBe(201);
		expect(second.headers.get("idempotency-replayed")).toBe("true");
		expect(await second.text()).toBe("echo: ");

		const third = await run();
		expect(third.headers.get("idempotency-replayed")).toBe("true");
		expect(await third.text()).toBe("echo: ");
	});

	test("key reuse with a different payload → 422 problem, kind state_conflict", async () => {
		const cache = new IdempotencyCache();
		const run = (body: string) =>
			idempotentPost(
				new Request("http://kit.local/x", {
					method: "POST",
					headers: { "idempotency-key": "k-2" },
					body,
				}),
				"svc",
				async () =>
					new Response(`body was: ${body}`, {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				cache,
			);
		const a = await run('{"a":1}');
		expect(a.status).toBe(201);
		expect(await a.text()).toBe('body was: {"a":1}');
		const b = await run('{"a":2}');
		const body = (await b.json()) as Record<string, unknown>;
		expect(b.status).toBe(422);
		expect(body.kind).toBe("state_conflict");
		expect(body.code).toBe("svc.idempotency_key_reuse");
	});

	test("5xx JSON and non-JSON responses are never stored", async () => {
		const cache = new IdempotencyCache();
		let calls = 0;
		const run = (h: HeadersInit, status: number) =>
			idempotentPost(
				req("/x", "POST", { "idempotency-key": "k-3" }),
				"svc",
				async () => {
					calls++;
					return new Response('{"e":1}', { status, headers: h });
				},
				cache,
			);
		await run({ "content-type": "text/plain" }, 201);
		await run({ "content-type": "application/json" }, 503);
		await run({ "content-type": "text/plain" }, 201);
		expect(calls).toBe(3);
	});
});
