// test/e2e-account-policy-mandatory.test.ts — W1265.2 discovery + hint
// precedence over the real ingress: named /v1/models resolves the account
// class (anonymous/unknown 403, forged /w slug 403, root passthrough) and
// filters the listing to the entitled groups; the legacy bare face is bound
// too under an active doc; prefer= ranks ONLY permitted candidates (audit
// names the entitled head); must= never substitutes across the boundary —
// no entitled full fit is a typed refusal with zero outbound.
import { describe, expect, test } from "bun:test";
import {
	type AccountPolicyDoc,
	defaultAccountPolicy,
} from "../src/account-policy.ts";
import { stashPrincipal } from "../src/gov/federation.ts";
import type { Principal } from "../src/gov/middleware.ts";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

function principal(name: string | null, kind = "api_key"): Principal {
	return {
		kind,
		keyId: "k1",
		name,
		team: null,
		actor: name,
		scopes: ["buckle:proxy:WRITE_*"],
		jti: null,
		rpm: null,
		tpm: null,
	};
}

const DOC: AccountPolicyDoc = {
	version: 1,
	classes: [
		{
			id: "ikea-work",
			tier: "work",
			keys: ["fleet-ikea-*"],
			providers: ["github_copilot"],
			groups: ["claude-*"],
		},
		{
			id: "personal",
			tier: "personal",
			keys: ["fleet-personal-*"],
			providers: ["zai", "openrouter"],
			groups: ["claude-*"],
		},
	],
};

function poolOf(copilot: string, zai: string): UpstreamPool {
	return {
		groups: () => ["claude-sonnet-5", "gpt-corp"],
		deployments: (g) =>
			g === "gpt-corp"
				? [
						{
							group: g,
							url: copilot,
							dialect: "openai" as const,
							adapter: "github_copilot",
						},
					]
				: [
						{
							group: g,
							url: copilot,
							dialect: "anthropic" as const,
							adapter: "github_copilot",
						},
						{
							group: g,
							url: zai,
							dialect: "anthropic" as const,
							adapter: "zai",
						},
					],
	};
}

// The hint-facing pool: the copilot row carries the asked wire id (full
// hint fit) while the entitled zai row serves zai-x — a hint naming the
// asked model targets the FORBIDDEN row only.
function hintPool(copilot: string, zai: string): UpstreamPool {
	return {
		groups: () => ["claude-sonnet-5"],
		deployments: (g) => [
			{
				group: g,
				url: copilot,
				dialect: "anthropic" as const,
				adapter: "github_copilot",
				model: g,
			},
			{
				group: g,
				url: zai,
				dialect: "anthropic" as const,
				adapter: "zai",
				model: "zai-x",
			},
		],
	};
}

function deps(pool: UpstreamPool, doc: AccountPolicyDoc | null = DOC) {
	return testDeps(pool, { accountPolicy: doc });
}

async function fetchAs(
	app: ReturnType<typeof createApp>,
	url: string,
	init: { method: string; headers?: Record<string, string>; body?: string },
	p: Principal | null,
): Promise<Response> {
	const req = new Request(url, {
		method: init.method,
		headers: init.headers,
		body: init.body,
	});
	if (p !== null) stashPrincipal(req, p);
	const res = await app.fetch(req);
	await Bun.sleep(20);
	return res;
}

const postBody = JSON.stringify({
	model: "claude-sonnet-5",
	stream: false,
});

describe("W1265.2 mandatory — model discovery is account-bound", () => {
	test("named /openai/v1/models GET: entitled groups only", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const app = createApp(deps(poolOf(copilot.url, zai.url)));
		const res = await fetchAs(
			app,
			`${zai.url}/openai/v1/models`,
			{ method: "GET" },
			principal("fleet-personal-1"),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { data: Array<{ id: string }> };
		expect(out.data.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
		expect(copilot.calls.length).toBe(0);
		expect(zai.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});

	test("named /anthropic/v1/models HEAD rides the same binding", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const app = createApp(deps(poolOf(copilot.url, zai.url)));
		const res = await fetchAs(
			app,
			`${zai.url}/anthropic/v1/models`,
			{ method: "HEAD" },
			principal("fleet-ikea-1"),
		);
		expect(res.status).toBe(200);
		copilot.close();
		zai.close();
	});

	test("anonymous named models = 403 repo_unknown", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const app = createApp(deps(poolOf(copilot.url, zai.url)));
		const res = await fetchAs(
			app,
			`${zai.url}/openai/v1/models`,
			{ method: "GET" },
			null,
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { code?: string }).code).toBe(
			"buckle.repo_unknown",
		);
		copilot.close();
		zai.close();
	});

	test("forged /w slug on named models = 403 lane_bind_mismatch", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const app = createApp(deps(poolOf(copilot.url, zai.url)));
		const res = await fetchAs(
			app,
			`${zai.url}/w/fleet-personal-2/openai/v1/models`,
			{ method: "GET" },
			principal("fleet-personal-1"),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { code?: string }).code).toBe(
			"buckle.lane_bind_mismatch",
		);
		copilot.close();
		zai.close();
	});

	test("matching /w slug rides; root lists unfiltered", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const app = createApp(deps(poolOf(copilot.url, zai.url)));
		const mine = await fetchAs(
			app,
			`${zai.url}/w/fleet-personal-1/openai/v1/models`,
			{ method: "GET" },
			principal("fleet-personal-1"),
		);
		expect(mine.status).toBe(200);
		expect(
			((await mine.json()) as { data: Array<{ id: string }> }).data.map(
				(m) => m.id,
			),
		).toEqual(["claude-sonnet-5"]);
		const root = await fetchAs(
			app,
			`${zai.url}/openai/v1/models`,
			{ method: "GET" },
			principal(null, "root"),
		);
		expect(root.status).toBe(200);
		expect(
			((await root.json()) as { data: Array<{ id: string }> }).data.map(
				(m) => m.id,
			),
		).toEqual(["claude-sonnet-5", "gpt-corp"]);
		copilot.close();
		zai.close();
	});

	test("legacy bare /v1/models is bound under an active doc; inert stays open", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const app = createApp(deps(poolOf(copilot.url, zai.url)));
		const anon = await fetchAs(app, `${zai.url}/v1/models`, { method: "GET" }, null);
		expect(anon.status).toBe(403);
		const mine = await fetchAs(
			app,
			`${zai.url}/v1/models`,
			{ method: "GET" },
			principal("fleet-personal-1"),
		);
		expect(mine.status).toBe(200);
		expect(
			((await mine.json()) as { data: Array<{ id: string }> }).data.map(
				(m) => m.id,
			),
		).toEqual(["claude-sonnet-5"]);
		// explicit off (doc null): the boundary is disabled — behaves as before
		const off = createApp(deps(poolOf(copilot.url, zai.url), null));
		const open = await fetchAs(
			off,
			`${zai.url}/v1/models`,
			{ method: "GET" },
			null,
		);
		expect(open.status).toBe(200);
		expect(
			((await open.json()) as { data: Array<{ id: string }> }).data,
		).toHaveLength(2);
		copilot.close();
		zai.close();
	});

	test("mandatory general default: named models open to any named key, anonymous refused", async () => {
		const def = defaultAccountPolicy();
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const app = createApp(deps(poolOf(copilot.url, zai.url), def.doc));
		const ok = await fetchAs(
			app,
			`${zai.url}/openai/v1/models`,
			{ method: "GET" },
			principal("any-tool-key"),
		);
		expect(ok.status).toBe(200);
		const anon = await fetchAs(
			app,
			`${zai.url}/openai/v1/models`,
			{ method: "GET" },
			null,
		);
		expect(anon.status).toBe(403);
		copilot.close();
		zai.close();
	});
});

describe("W1265.2 mandatory — hint precedence inside the boundary", () => {
	test("must= outside the boundary refuses typed, zero outbound (never substitutes)", async () => {
		const copilot = await startMockUpstream(() =>
			Response.json({
				id: "m-c",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const zai = await startMockUpstream(() =>
			Response.json({
				id: "m-z",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const app = createApp(deps(hintPool(copilot.url, zai.url)));
		const res = await fetchAs(
			app,
			`${zai.url}/v1/messages`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-belt-hint": "must model:claude-sonnet-5",
				},
				body: postBody,
			},
			principal("fleet-personal-1"),
		);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { code?: string }).code).toBe(
			"buckle.tier_no_upstream",
		);
		expect(copilot.calls.length).toBe(0);
		expect(zai.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});

	test("prefer= ranks only permitted candidates; the audit names the entitled head", async () => {
		const copilot = await startMockUpstream(() =>
			Response.json({
				id: "m-c",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const zai = await startMockUpstream(() =>
			Response.json({
				id: "m-z",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const d = deps(hintPool(copilot.url, zai.url));
		const app = createApp(d);
		const res = await fetchAs(
			app,
			`${zai.url}/v1/messages`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-belt-hint": "prefer model:claude-sonnet-5",
				},
				body: postBody,
			},
			principal("fleet-personal-1"),
		);
		expect(res.status).toBe(200);
		expect(zai.calls.length).toBe(1);
		expect(copilot.calls.length).toBe(0);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(String(audit.why)).toContain(":zai-x");
		copilot.close();
		zai.close();
	});

	test("must= inside the boundary still rides the full fit", async () => {
		const copilot = await startMockUpstream(() =>
			Response.json({
				id: "m-c",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const zai = await startMockUpstream(() =>
			Response.json({
				id: "m-z",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const app = createApp(deps(hintPool(copilot.url, zai.url)));
		const res = await fetchAs(
			app,
			`${zai.url}/v1/messages`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-belt-hint": "must model:zai-x",
				},
				body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
			},
			principal("fleet-personal-1"),
		);
		expect(res.status).toBe(200);
		expect(zai.calls.length).toBe(1);
		expect(copilot.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});
});
