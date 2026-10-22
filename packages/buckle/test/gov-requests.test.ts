// test/gov-requests.test.ts — W824 GET /v1/admin/requests: per-request
// inspection over the route_audit ledger through a real Bun.serve gate.
// Covers the gate class (admin:READ_), the key NAME join surviving
// revocation (minted-then-revoked), the cap + filter contract, and the
// never-key-material law.
import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger.ts";
import { startMockUpstream } from "./mock.ts";
import {
	CHAT_BODY,
	chat,
	issueViaAdmin,
	ROOT,
	startGate,
} from "./fixtures/gate.ts";

const OPENAI_USAGE = {
	id: "w824",
	choices: [],
	usage: {
		prompt_tokens: 11,
		completion_tokens: 7,
		prompt_tokens_details: { cached_tokens: 5 },
	},
};

interface ReqRow {
	rid: string;
	trace_id: string | null;
	ts: string;
	actor: string;
	lane: string;
	target_model: string | null;
	decision: string;
	status: number | null;
	ok: number | null;
	attempts: number | null;
	in_tok: number | null;
	out_tok: number | null;
	cache_r: number | null;
	cache_c: number | null;
	key_name: string | null;
	key_team: string | null;
	err: string | null;
	traffic_kind: string | null;
	upstream_refusal_code: string | null;
	refusal_origin: string | null;
	retry_after_ms: number | null;
	selected_target_exact: boolean;
}

async function getRequests(
	base: string,
	token: string,
	query = "",
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${base}/v1/admin/requests${query}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const body = (await res.json()) as Record<string, unknown>;
	return { status: res.status, body };
}

describe("W824 gate class", () => {
	test("trace connector is admin-only and validates the trace ID", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const path = "/v1/admin/traces?trace_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const bare = await fetch(`${gate.base}${path}`);
		expect(bare.status).toBe(401);
		const allowed = await fetch(`${gate.base}${path}`, {
			headers: { authorization: `Bearer ${ROOT}` },
		});
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toMatchObject({ requests: [], attempts: [] });
		const invalid = await fetch(`${gate.base}/v1/admin/traces?trace_id=bad`, {
			headers: { authorization: `Bearer ${ROOT}` },
		});
		expect(invalid.status).toBe(400);
		gate.stop();
		upstream.close();
	});
	test("401 bare, 403 proxy-scoped, 204 OPTIONS + Allow", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const bare = await fetch(`${gate.base}/v1/admin/requests`);
		expect(bare.status).toBe(401);
		const lane = await issueViaAdmin(gate.base, {
			name: "lane-proxy-only",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const forbidden = await getRequests(gate.base, lane.key);
		expect(forbidden.status).toBe(403);
		const pre = await fetch(`${gate.base}/v1/admin/requests`, {
			method: "OPTIONS",
		});
		expect(pre.status).toBe(204);
		expect(pre.headers.get("allow")).toBe("GET, OPTIONS");
		gate.stop();
		upstream.close();
	});
});

describe("W824 per-request rows", () => {
	test("provider cold refusal stays distinct from generic 429 in request audit", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json(
				{ error: { type: "rate_limit_error", message: "warming" } },
				{
					status: 429,
					headers: {
						"x-klh-refusal": "local_cold",
						"x-klh-service": "belt",
						"retry-after": "1",
					},
				},
			),
		);
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		try {
			const lane = await issueViaAdmin(gate.base, {
				name: "cold-lane",
				scopes: ["buckle:proxy:WRITE_"],
			});
			expect((await chat(gate.base, lane.key)).status).toBe(429);
			const out = await getRequests(gate.base, ROOT, "?inference=true");
			expect(out.status).toBe(200);
			const row = (out.body.requests as ReqRow[])[0];
			expect(row).toMatchObject({
				status: 429,
				error_code: "rate_limited",
				upstream_refusal_code: "local_cold",
				refusal_origin: "upstream",
				retry_after_ms: 1000,
				selected_target_exact: true,
			});
			const trace = await fetch(
				`${gate.base}/v1/admin/traces?trace_id=${row?.trace_id}`,
				{
					headers: { authorization: `Bearer ${ROOT}` },
				},
			);
			const detail = (await trace.json()) as {
				attempts: Array<Record<string, unknown>>;
			};
			expect(detail.attempts[0]).toMatchObject({
				upstream_refusal_code: "local_cold",
				refusal_origin: "upstream",
			});
		} finally {
			gate.stop();
			upstream.close();
		}
	});
	test("one trace query joins the live route and each Buckle attempt", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const lane = await issueViaAdmin(gate.base, {
			name: "trace-lane",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const traceId = "c".repeat(32);
		const response = await chat(gate.base, lane.key, {
			headers: { traceparent: `00-${traceId}-1234567890abcdef-01` },
		});
		expect(response.status).toBe(200);
		const res = await fetch(
			`${gate.base}/v1/admin/traces?trace_id=${traceId}`,
			{ headers: { authorization: `Bearer ${ROOT}` } },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			requests: ReqRow[];
			attempts: Array<Record<string, unknown>>;
		};
		expect(body.requests).toHaveLength(1);
		expect(body.attempts).toHaveLength(1);
		expect(body.attempts[0]).toMatchObject({
			trace_id: traceId,
			ordinal: 1,
			service: "buckle",
			status: 200,
		});
		expect(body.attempts[0]?.rid).toBe(body.requests[0]?.rid);
		gate.stop();
		upstream.close();
	});
	test("exposes and filters W3C trace IDs without changing the request ID", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const lane = await issueViaAdmin(gate.base, {
			name: "trace-lane",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const auditor = await issueViaAdmin(gate.base, {
			name: "auditor",
			scopes: ["buckle:admin:READ_"],
		});
		const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
		await chat(gate.base, lane.key, {
			headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
		});
		await chat(gate.base, lane.key);
		const all = await getRequests(gate.base, auditor.key);
		const rows = all.body.requests as ReqRow[];
		expect(rows.length).toBe(2);
		expect(rows.find((row) => row.trace_id === traceId)?.rid).toBeTruthy();
		expect(rows.every((row) => /^[0-9a-f]{32}$/.test(row.trace_id ?? ""))).toBe(
			true,
		);
		const filtered = await getRequests(
			gate.base,
			auditor.key,
			`?trace_id=${traceId}`,
		);
		expect(
			(filtered.body.requests as ReqRow[]).map((row) => row.trace_id),
		).toEqual([traceId]);
		expect(
			(await getRequests(gate.base, auditor.key, "?trace_id=bad")).status,
		).toBe(400);
		gate.stop();
		upstream.close();
	});
	test("usage join + key name join", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const lane = await issueViaAdmin(gate.base, {
			name: "lane-autow824",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const auditor = await issueViaAdmin(gate.base, {
			name: "auditor",
			scopes: ["buckle:admin:READ_"],
		});
		await chat(gate.base, lane.key);
		await chat(gate.base, lane.key);
		const out = await getRequests(gate.base, auditor.key);
		expect(out.status).toBe(200);
		const rows = out.body.requests as ReqRow[];
		expect(rows.length).toBe(2);
		const row = rows[0];
		expect(row.actor).toBe(lane.keyId);
		expect(row.key_name).toBe("lane-autow824");
		expect(row.status).toBe(200);
		expect(row.ok).toBe(1);
		expect(row.in_tok).toBe(11);
		expect(row.out_tok).toBe(7);
		expect(row.cache_r).toBe(5);
		expect(row.attempts).toBe(1);
		gate.stop();
		upstream.close();
	});

	test("newest first + never key material", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const lane = await issueViaAdmin(gate.base, {
			name: "lane-autow824",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const auditor = await issueViaAdmin(gate.base, {
			name: "auditor",
			scopes: ["buckle:admin:READ_"],
		});
		await chat(gate.base, lane.key);
		await chat(gate.base, lane.key);
		const out = await getRequests(gate.base, auditor.key);
		const rows = out.body.requests as ReqRow[];
		expect(rows.length).toBe(2);
		expect(rows[0].ts >= rows[1].ts).toBe(true);
		const raw = JSON.stringify(out.body);
		expect(raw.includes(lane.key)).toBe(false);
		expect(raw.includes("key_hash")).toBe(false);
		gate.stop();
		upstream.close();
	});
});

describe("W824 minted-then-revoked", () => {
	test("rows keep the key NAME join after revocation", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const lane = await issueViaAdmin(gate.base, {
			name: "lane-gone",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const auditor = await issueViaAdmin(gate.base, {
			name: "auditor",
			scopes: ["buckle:admin:READ_"],
		});
		await chat(gate.base, lane.key);
		const rev = await fetch(`${gate.base}/v1/admin/keys/${lane.keyId}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
		});
		expect(rev.status).toBe(200);
		expect((await chat(gate.base, lane.key)).status).toBe(401);
		const out = await getRequests(gate.base, auditor.key);
		const rows = out.body.requests as ReqRow[];
		// the post-revocation 401 audits a denial row too (denied audits too,
		// W136) — attributed to the same key id
		expect(rows.length).toBe(2);
		const routed = rows.find((r) => r.ok === 1);
		const denied = rows.find((r) => r.ok === 0);
		expect(routed).toBeTruthy();
		expect(denied).toBeTruthy();
		expect(routed?.actor).toBe(lane.keyId);
		expect(routed?.key_name).toBe("lane-gone");
		expect(denied?.actor).toBe(lane.keyId);
		expect(denied?.key_name).toBe("lane-gone");
		gate.stop();
		upstream.close();
	});
});

describe("W824 cap + filters", () => {
	test("limit default/clamp/400", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const lane = await issueViaAdmin(gate.base, {
			name: "lane-filters",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const auditor = await issueViaAdmin(gate.base, {
			name: "auditor",
			scopes: ["buckle:admin:READ_"],
		});
		await chat(gate.base, lane.key);
		expect((await chat(gate.base, "wrong-key")).status).toBe(401);
		const inference = await getRequests(
			gate.base,
			auditor.key,
			"?inference=true",
		);
		expect(
			(inference.body.requests as ReqRow[]).map((r) => r.target_model),
		).toEqual(["glm-5.3-flash"]);
		const one = await getRequests(gate.base, auditor.key, "?limit=1");
		expect((one.body.requests as ReqRow[]).length).toBe(1);
		const badLimit = await getRequests(gate.base, auditor.key, "?limit=abc");
		expect(badLimit.status).toBe(400);
		expect(badLimit.body.code).toBe("buckle.bad_limit");
		const clamped = await getRequests(gate.base, auditor.key, "?limit=9999");
		expect(clamped.status).toBe(200);
		const mine = await getRequests(
			gate.base,
			auditor.key,
			`?key=${lane.keyId}`,
		);
		const mineRows = mine.body.requests as ReqRow[];
		expect(mineRows.length).toBe(1);
		expect(mineRows[0].actor).toBe(lane.keyId);
		const future = new Date(Date.now() + 60_000).toISOString();
		const none = await getRequests(
			gate.base,
			auditor.key,
			`?since=${encodeURIComponent(future)}`,
		);
		expect((none.body.requests as ReqRow[]).length).toBe(0);
		gate.stop();
		upstream.close();
	});
});

describe("W824 read cap", () => {
	test("inference filter applies before the cap so denied ingress cannot hide model traffic", () => {
		const ledger = new Ledger(
			`/tmp/buckle-w824-filter-${Date.now()}-${process.pid}.db`,
			undefined,
			{ flushMs: 10_000 },
		);
		const base = {
			actor: "captest",
			lane: "",
			dialect: "openai",
			hint: "",
			candidates_seen: 0,
			candidates_top: "",
			target_kind: null,
			target_host: null,
			target_port: null,
			target_model: null,
			decision: "denied",
			latency_class: "unproven",
			tier: "",
			allow_cloud: false,
			error_code: null,
			why: "",
		};
		ledger.auditDecision({
			...base,
			rid: "model-request",
			ts: "2026-10-19T09:00:00.000Z",
			lane: "lane-one",
			target_model: "glm-5.3-flash",
			decision: "policy",
		});
		for (let i = 0; i < 510; i++)
			ledger.auditDecision({
				...base,
				rid: `denied-${i}`,
				ts: "2026-10-19T10:00:00.000Z",
			});
		expect(ledger.requestsRead({ limit: 500 }).length).toBe(500);
		expect(
			ledger.requestsRead({ limit: 500, inference: true }).map((r) => r.rid),
		).toEqual(["model-request"]);
		ledger.close();
	});

	test("long err/why truncate at read (bodies never re-served)", () => {
		const dir = `/tmp/buckle-w824-${Date.now()}-${process.pid}-${Math.random()
			.toString(36)
			.slice(2, 6)}`;
		const ledger = new Ledger(`${dir}.db`, undefined, { flushMs: 10_000 });
		const long = "x".repeat(600);
		ledger.auditDecision({
			rid: "w824cap",
			ts: new Date().toISOString(),
			actor: "captest",
			lane: "",
			dialect: "openai",
			hint: "",
			candidates_seen: 0,
			candidates_top: "",
			target_kind: null,
			target_host: null,
			target_port: null,
			target_model: null,
			decision: "errored",
			latency_class: "unproven",
			tier: "",
			allow_cloud: false,
			error_code: "no_route",
			why: long,
		});
		ledger.auditOutcome("w824cap", {
			status: 502,
			duration_ms: 4,
			ok: false,
			err: "e".repeat(600),
		});
		const rows = ledger.requestsRead({ limit: 50, errors: true });
		expect(rows.length).toBe(1);
		expect(rows[0].why.length).toBe(201);
		expect(rows[0].why.endsWith("…")).toBe(true);
		expect(rows[0].err?.length).toBe(201);
		ledger.close();
	});
});

describe("W921 traffic kind", () => {
	test("marked root-auth requests persist readiness; everything else stays inference", async () => {
		const upstream = await startMockUpstream(() => Response.json(OPENAI_USAGE));
		const gate = await startGate({ upstreamUrl: upstream.url, auth: { rootKey: ROOT } });
		const lane = await issueViaAdmin(gate.base, {
			name: "w921-lane",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const auditor = await issueViaAdmin(gate.base, {
			name: "w921-auditor",
			scopes: ["buckle:admin:READ_"],
		});
		const chat = (token: string, marker = false): Promise<Response> =>
			fetch(`${gate.base}/v1/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					...(marker ? { "x-klh-traffic": "readiness" } : {}),
				},
				body: CHAT_BODY,
			});
		await chat(ROOT, true); // root + mark → readiness
		await chat(lane.key, true); // lane key + mark → inference
		await chat(ROOT); // root, unmarked → inference (break-glass stays honest)
		const res = await getRequests(gate.base, auditor.key);
		const rows = res.body.requests as ReqRow[];
		expect(rows.length).toBe(3);
		const kinds = rows.map((r) => r.traffic_kind).sort();
		expect(kinds).toEqual(["inference", "inference", "readiness"]);
		gate.stop();
		upstream.close();
	});
});
