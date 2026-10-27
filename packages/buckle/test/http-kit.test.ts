// test/http-kit.test.ts — W1303.2 kit behavior pins: status matrix, problem
// bodies (field errors, clamped Retry-After), clamp + env max, etag/if-match,
// 202, deadline propagation, idempotency replay + body-mismatch 422, token
// buckets, shed queue (429 vs 503, health reservation), route table (404 vs
// 405+Allow, HEAD/OPTIONS automatic).
import { afterEach, describe, expect, test } from "bun:test";
import {
	accepted202,
	CallerBuckets,
	clampRetryAfter,
	DEADLINE_HEADER,
	deadlineHeaders,
	etagOf,
	HttpProblem,
	IdempotencyStore,
	idempotentRespond,
	ifMatchMissing,
	ifMatchState,
	parseRequestDeadline,
	problemFrom,
	problemOf,
	RouteTable,
	retryAfterHeaders,
	retryAfterMaxS,
	ShedQueue,
	STATUS_OF,
	TokenBucket,
	toProblemResponse,
} from "../src/http-kit.ts";

const get = (r: Response): Promise<Record<string, unknown>> => r.json();

afterEach(() => {
	delete process.env.BUCKLE_RETRY_AFTER_MAX_S;
});

describe("status matrix + problem bodies", () => {
	test("kind → status: 429 you-send-too-much vs 503 we-struggle, 412/428, 422", () => {
		expect(STATUS_OF.rate_limited).toBe(429);
		expect(STATUS_OF.overloaded).toBe(503);
		expect(STATUS_OF.precondition_failed).toBe(412);
		expect(STATUS_OF.precondition_required).toBe(428);
		expect(STATUS_OF.validation).toBe(422);
	});

	test("problem+json body grammar: type/title/status/code/why", async () => {
		const r = toProblemResponse(
			problemOf("validation", {
				code: "buckle.settings_invalid",
				why: "must be booleans",
			}),
		);
		expect(r.status).toBe(422);
		expect(r.headers.get("content-type")).toBe("application/problem+json");
		const b = await get(r);
		expect(b.type).toBe("/problems/invalid_request");
		expect(b.title).toBe("Unprocessable Content");
		expect(b.code).toBe("buckle.settings_invalid");
		expect(b.why).toBe("must be booleans");
	});
});

describe("field errors + clamped emission", () => {
	test("422 validation carries field errors", async () => {
		const b = await get(
			toProblemResponse(
				problemOf("validation", {
					code: "buckle.fields_invalid",
					why: "two fields wrong",
					fields: [
						{ field: "a", why: "must be true or false" },
						{ field: "b", why: "required" },
					],
				}),
			),
		);
		expect(Array.isArray(b.errors)).toBe(true);
		expect((b.errors as unknown[]).length).toBe(2);
	});

	test("retry-after on a problem emission is clamped", async () => {
		process.env.BUCKLE_RETRY_AFTER_MAX_S = "120";
		const r = toProblemResponse(
			problemOf("rate_limited", {
				code: "buckle.rate_limited",
				why: "budget exceeded",
				retryAfterS: 2_592_000,
			}),
		);
		expect(r.headers.get("retry-after")).toBe("120");
	});
});

describe("problemFrom", () => {
	test("HttpProblem renders itself, unknown → 500 curated", async () => {
		const known = await get(
			problemFrom(
				problemOf("conflict", { code: "buckle.conflict", why: "dupe" }),
			),
		);
		expect(known.status).toBe(409);
		const unknown = await get(problemFrom(new Error("secret internals")));
		expect(unknown.status).toBe(500);
		expect(unknown.why).toBe("internal error");
		const hp = new HttpProblem("not_found", {
			code: "buckle.missing",
			why: "gone",
		});
		expect((await get(problemFrom(hp))).status).toBe(404);
	});
});

describe("retry-after clamp", () => {
	test("clampRetryAfter caps at the configured max (env override)", () => {
		expect(clampRetryAfter(2_592_000)).toBe(300);
		process.env.BUCKLE_RETRY_AFTER_MAX_S = "60";
		expect(clampRetryAfter(2_592_000)).toBe(60);
		expect(clampRetryAfter(30)).toBe(30);
		expect(clampRetryAfter(0)).toBe(0);
		expect(clampRetryAfter(Number.NaN)).toBe(60);
		expect(retryAfterMaxS()).toBe(60);
	});

	test("retryAfterHeaders: absent → {}, present → clamped delta", () => {
		expect(retryAfterHeaders(null)).toEqual({});
		expect(retryAfterHeaders(undefined)).toEqual({});
		process.env.BUCKLE_RETRY_AFTER_MAX_S = "10";
		expect(retryAfterHeaders(43_200)).toEqual({ "retry-after": "10" });
		expect(retryAfterHeaders(4)).toEqual({ "retry-after": "4" });
	});
});

describe("etag + if-match", () => {
	test("etagOf stable across equal states, differs on change", () => {
		expect(etagOf({ a: 1, b: 2 })).toBe(etagOf({ b: 2, a: 1 }));
		expect(etagOf({ a: 1 })).not.toBe(etagOf({ a: 2 }));
	});

	test("ifMatchState: absent and * are ok, stale token is mismatch", () => {
		const h = new Headers();
		expect(ifMatchState(h, `"x1"`)).toBe("ok");
		h.set("if-match", "*");
		expect(ifMatchState(h, `"x1"`)).toBe("ok");
		h.set("if-match", '"stale"');
		expect(ifMatchState(h, `"x1"`)).toBe("mismatch");
		h.set("if-match", '"x1"');
		expect(ifMatchState(h, `"x1"`)).toBe("ok");
	});

	test("ifMatchMissing: 428 gate for required conditionals on writes", () => {
		expect(ifMatchMissing(new Headers())).toBe(true);
		const h = new Headers({ "if-match": '"x1"' });
		expect(ifMatchMissing(h)).toBe(false);
	});
});

describe("202 + deadline propagation", () => {
	test("accepted202 carries Location + the status path in the body", async () => {
		const r = accepted202("/jobs/j-1", { traceId: "t1" });
		expect(r.status).toBe(202);
		expect(r.headers.get("location")).toBe("/jobs/j-1");
		const b = await get(r);
		expect(b.ok).toBe(true);
		expect(b.status).toBe("/jobs/j-1");
	});

	test("parseRequestDeadline: absent/invalid → null, future/expired parsed", () => {
		const now = () => 1_000_000;
		expect(parseRequestDeadline(new Headers(), now)).toBe(null);
		const bad = new Headers({ [DEADLINE_HEADER]: "not-a-number" });
		expect(parseRequestDeadline(bad, now)).toBe(null);
		const future = new Headers({ [DEADLINE_HEADER]: "1000500" });
		const d = parseRequestDeadline(future, now);
		expect(d?.remainingMs).toBe(500);
		const past = new Headers({ [DEADLINE_HEADER]: "999000" });
		const d2 = parseRequestDeadline(past, now);
		expect(d2?.remainingMs).toBe(-1000);
		expect(deadlineHeaders(1_000_500)).toEqual({
			[DEADLINE_HEADER]: "1000500",
		});
	});
});

const reqWith = (body: string, key?: string): Request =>
	new Request("http://x/v1/things", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key === undefined ? {} : { "idempotency-key": key }),
		},
		body,
	});

describe("idempotency replay", () => {
	test("same key + same body replays the stored response", async () => {
		const store = new IdempotencyStore({ ttlS: 3600 });
		let runs = 0;
		const run = async (): Promise<Response> => {
			runs += 1;
			return Response.json({ ok: true, n: runs }, { status: 201 });
		};
		const r1 = await idempotentRespond(store, reqWith(`{"a":1}`, "k1"), run);
		expect(r1.status).toBe(201);
		const r2 = await idempotentRespond(store, reqWith(`{"a":1}`, "k1"), run);
		expect(r2.status).toBe(201);
		expect(r2.headers.get("idempotency-replayed").length > 0).toBe(true);
		expect(runs).toBe(1);
	});
});

describe("idempotency body mismatch", () => {
	test("same key + different body → 422, nothing runs", async () => {
		const store = new IdempotencyStore({ ttlS: 3600 });
		let runs = 0;
		const run = async (): Promise<Response> => {
			runs += 1;
			return Response.json({ ok: true });
		};
		await idempotentRespond(store, reqWith(`{"a":1}`, "k2"), run);
		const clash = await idempotentRespond(store, reqWith(`{"a":2}`, "k2"), run);
		expect(clash.status).toBe(422);
		expect(runs).toBe(1);
		const b = await get(clash);
		expect(b.code).toBe("buckle.idempotency_body_mismatch");
	});
});

describe("idempotency passthrough + bounds", () => {
	test("no key → passthrough; 5xx never stored; ttl expiry", async () => {
		const store = new IdempotencyStore({ ttlS: 3600 });
		let runs = 0;
		const run = async (): Promise<Response> => {
			runs += 1;
			return Response.json({ ok: true, n: runs });
		};
		const plain = await idempotentRespond(store, reqWith(`{}`), run);
		expect(plain.status).toBe(200);
		const failing = async (): Promise<Response> =>
			new Response("boom", { status: 503 });
		await idempotentRespond(store, reqWith(`{}`, "k3"), failing);
		expect(store.size).toBe(0);
		let clock = 0;
		const ttl = new IdempotencyStore({ ttlS: 10, now: () => clock });
		await idempotentRespond(ttl, reqWith(`{}`, "k4"), run);
		expect(ttl.size).toBe(1);
		clock = 11_000;
		expect(ttl.get("k4")).toBe(null);
	});
});

describe("token buckets", () => {
	test("drain → retryAfterS; refill over fake time", () => {
		let clock = 0;
		const b = new TokenBucket({
			capacity: 2,
			refillPerS: 1,
			now: () => clock,
		});
		expect(b.tryTake()).toBe(true);
		expect(b.tryTake()).toBe(true);
		expect(b.tryTake()).toBe(false);
		expect(b.retryAfterS()).toBeGreaterThanOrEqual(1);
		clock = 2_500;
		expect(b.tryTake()).toBe(true);
	});

	test("CallerBuckets: one bucket per caller, independent drains", () => {
		const clock = 0;
		const cb = new CallerBuckets({
			capacity: 1,
			refillPerS: 0.1,
			now: () => clock,
		});
		expect(cb.take("a")).toEqual({ ok: true });
		expect(cb.take("a").ok).toBe(false);
		expect(cb.take("b")).toEqual({ ok: true });
	});
});

describe("shed queue admission", () => {
	test("429 you-send-too-much vs 503 we-struggle", () => {
		const q = new ShedQueue({
			capacity: 2,
			reserved: 1,
			buckets: new CallerBuckets({ capacity: 100, refillPerS: 100 }),
			shedRetryAfterS: 4,
		});
		const a = q.admit("a");
		if (!a.ok) throw new Error("first admit must pass");
		const b = q.admit("b");
		expect(b.ok).toBe(false);
		if (!b.ok) {
			expect(b.status).toBe(503);
			expect(b.retryAfterS).toBe(4);
		}
		const tight = new ShedQueue({
			capacity: 10,
			reserved: 0,
			buckets: new CallerBuckets({ capacity: 1, refillPerS: 0.001 }),
			shedRetryAfterS: 4,
		});
		expect(tight.admit("z", {}).ok).toBe(true);
		const z2 = tight.admit("z", {});
		expect(z2.ok).toBe(false);
		if (!z2.ok) expect(z2.status).toBe(429);
	});

	test("reserved health capacity admits always", () => {
		const q = new ShedQueue({
			capacity: 2,
			reserved: 2,
			buckets: new CallerBuckets({ capacity: 100, refillPerS: 100 }),
			shedRetryAfterS: 4,
		});
		const h = q.admit("h", { health: true });
		expect(h.ok).toBe(true);
		const n = q.admit("n", {});
		expect(n.ok).toBe(false);
		if (!n.ok) expect(n.status).toBe(503);
	});

	test("release frees the slot", () => {
		const q = new ShedQueue({
			capacity: 2,
			reserved: 1,
			buckets: new CallerBuckets({ capacity: 100, refillPerS: 100 }),
			shedRetryAfterS: 4,
		});
		const a = q.admit("a");
		const b = q.admit("b");
		expect(b.ok).toBe(false);
		if (a.ok) a.release();
		const c = q.admit("c");
		expect(c.ok).toBe(true);
		if (c.ok) c.release();
	});
});

describe("route table", () => {
	const table = new RouteTable(
		[
			{
				method: "GET",
				pattern: "/aids/status",
				handler: (): Response => Response.json({ ok: true, route: "status" }),
			},
			{
				method: "POST",
				pattern: "/v1/admin/keys/:id([0-9a-f]{12})/revoke",
				handler: ({ params }): Response =>
					Response.json({ ok: true, id: params.id }),
			},
			{
				method: "POST",
				pattern: "/aids/preseed",
				handler: (): Response | null => null,
			},
		],
		{ service: "buckle" },
	);

	test("match + regex-group params", async () => {
		const r = await table.serve(
			new Request("http://x/v1/admin/keys/abcdef123456/revoke", {
				method: "POST",
			}),
		);
		expect(r?.status).toBe(200);
	});

	test("unknown path → null fall-through (main dispatch owns the 404)", async () => {
		expect(
			await table.serve(new Request("http://x/nope"), new URL("http://x/nope")),
		).toBe(null);
	});

	test("known path, wrong method → 405 problem + Allow", async () => {
		const r = await table.serve(
			new Request("http://x/aids/status", { method: "DELETE" }),
		);
		expect(r?.status).toBe(405);
		expect(r?.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
		const b = await get(r as Response);
		expect(b.code).toBe("buckle.method_not_allowed");
	});

	test("OPTIONS automatic → 204 + Allow", async () => {
		const r = await table.serve(
			new Request("http://x/aids/status", { method: "OPTIONS" }),
		);
		expect(r?.status).toBe(204);
		expect(r?.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	});

	test("HEAD rides GET with the body stripped", async () => {
		const r = await table.serve(
			new Request("http://x/aids/status", { method: "HEAD" }),
		);
		expect(r?.status).toBe(200);
		expect(await r?.text()).toBe("");
	});

	test("handler null → honest fall-through", async () => {
		expect(
			await table.serve(
				new Request("http://x/aids/preseed", { method: "POST" }),
			),
		).toBe(null);
	});
});
