// test/e2e-account-policy.test.ts — the W1265.1 zero-outbound matrix over
// the real ingress path: IKEA class → Copilot row rides; personal → Z.ai
// rides; spoofed claim / unknown key / entitlement / wrong-wire /
// cross-boundary fallback all refuse with typed codes and ZERO upstream
// calls; every decision row carries the repo hash + tier + key name.
import { describe, expect, test } from "bun:test";
import {
	type AccountPolicyDoc,
	defaultAccountPolicy,
	REPO_CLAIM_HEADER,
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
			repos: ["/Users/*/dev/ikea/*"],
			providers: ["github_copilot"],
			groups: ["claude-*"],
		},
		{
			id: "personal",
			tier: "personal",
			keys: ["fleet-personal-*"],
			providers: ["zai", "openrouter"],
			groups: ["*"],
		},
	],
};

function poolOf(copilot: string, zai: string): UpstreamPool {
	return {
		groups: () => ["claude-sonnet-5"],
		deployments: (g) => [
			{
				group: g,
				url: copilot,
				dialect: "anthropic" as const,
				adapter: "github_copilot",
			},
			{ group: g, url: zai, dialect: "anthropic" as const, adapter: "zai" },
		],
	};
}

function deps(pool: UpstreamPool, doc: AccountPolicyDoc | null = DOC): AppDeps {
	return testDeps(pool, { accountPolicy: doc });
}

async function ingest(
	app: ReturnType<typeof createApp>,
	url: string,
	headers: Record<string, string>,
	p: Principal | null,
): Promise<Response> {
	const req = new Request(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
	});
	if (p !== null) stashPrincipal(req, p);
	const res = await app.fetch(req);
	await Bun.sleep(20);
	return res;
}

describe("W1265.1 e2e — account policy at the ingress", () => {
	test("IKEA key → Copilot row rides (provider + group entitled)", async () => {
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
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const res = await ingest(
			app,
			`${copilot.url}/v1/messages`,
			{ [REPO_CLAIM_HEADER]: "/Users/someone/dev/ikea/mono" }, // scrub:allow
			principal("fleet-ikea-lane1"),
		);
		expect(res.status).toBe(200);
		expect(copilot.calls.length).toBe(1);
		expect(zai.calls.length).toBe(0);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.account_tier).toBe("work");
		expect(audit.key_name).toBe("fleet-ikea-lane1");
		expect(String(audit.repo_hash)).toMatch(/^[0-9a-f]{16}$/);
		copilot.close();
		zai.close();
	});

	test("personal key → Z.ai row only (copilot untouched)", async () => {
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
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const res = await ingest(
			app,
			`${zai.url}/v1/messages`,
			{},
			principal("fleet-personal-1"),
		);
		expect(res.status).toBe(200);
		expect(zai.calls.length).toBe(1);
		expect(copilot.calls.length).toBe(0);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.account_tier).toBe("personal");
		copilot.close();
		zai.close();
	});

	test("spoofed x-klh-repo on a personal key = 403 repo_claim_mismatch, zero outbound", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const res = await ingest(
			app,
			`${zai.url}/v1/messages`,
			{ [REPO_CLAIM_HEADER]: "/Users/someone/dev/ikea/mono" }, // scrub:allow
			principal("fleet-personal-1"),
		);
		expect(res.status).toBe(403);
		const out = (await res.json()) as { code?: string };
		expect(out.code).toBe("buckle.repo_claim_mismatch");
		expect(copilot.calls.length).toBe(0);
		expect(zai.calls.length).toBe(0);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.error_code).toBe("buckle.repo_claim_mismatch");
		copilot.close();
		zai.close();
	});

	test("key outside every class = 403 repo_unknown, zero outbound", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const res = await ingest(
			app,
			`${zai.url}/v1/messages`,
			{},
			principal("mystery-key"),
		);
		expect(res.status).toBe(403);
		expect(copilot.calls.length).toBe(0);
		expect(zai.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});

	test("entitlement mismatch = 403 tier_entitlement, zero outbound", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		// (single-test fix) drop the stray successful probe request — it made
		// the copilot mock's call count 1 before the actual refusal request.
		const body = { model: "glm-5", stream: false };
		const req = new Request(`${zai.url}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[REPO_CLAIM_HEADER]: "/Users/someone/dev/ikea/mono", // scrub:allow
			},
			body: JSON.stringify(body),
		});
		stashPrincipal(req, principal("fleet-ikea-lane1"));
		const res2 = await app.fetch(req);
		await Bun.sleep(10);
		expect(res2.status).toBe(403);
		const out = (await res2.json()) as { code?: string };
		expect(out.code).toBe("buckle.tier_entitlement");
		expect(zai.calls.length).toBe(0);
		expect(copilot.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});

	test("cross-boundary fallback blocked: entitled copilot row fails, healthy zai NEVER called", async () => {
		const copilot = await startMockUpstream(
			() => new Response("kaboom", { status: 500 }),
		);
		const zai = await startMockUpstream(() =>
			Response.json({
				id: "m-z",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const res = await ingest(
			app,
			`${copilot.url}/v1/messages`,
			{ [REPO_CLAIM_HEADER]: "/Users/someone/dev/ikea/mono" }, // scrub:allow
			principal("fleet-ikea-lane1"),
		);
		expect(copilot.calls.length).toBeGreaterThanOrEqual(1);
		expect(zai.calls.length).toBe(0);
		expect([500, 502, 503]).toContain(res.status);
		copilot.close();
		zai.close();
	});

	test("wrong wire on a named base = local 4xx, zero outbound (parent guard)", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const req = new Request(`${zai.url}/anthropic/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
		});
		stashPrincipal(req, principal("fleet-ikea-lane1"));
		const res = await app.fetch(req);
		expect(res.status).toBe(404);
		const out = (await res.json()) as { code?: string };
		expect(out.code).toBe("buckle.wire_mismatch");
		expect(copilot.calls.length).toBe(0);
		expect(zai.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});

	test("/zai pinned named route composes with the personal class (zero copilot calls)", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() =>
			Response.json({
				id: "m-z",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const req = new Request(`${zai.url}/zai/anthropic/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
		});
		stashPrincipal(req, principal("fleet-personal-1"));
		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		expect(zai.calls.length).toBe(1);
		expect(copilot.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});

	test("root bypass rides anywhere (break-glass)", async () => {
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
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const res = await ingest(
			app,
			`${copilot.url}/v1/messages`,
			{},
			principal(null, "root"),
		);
		expect(res.status).toBe(200);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.account_tier).toBe("root");
		copilot.close();
		zai.close();
	});

	test("inert posture: no doc + no principal behaves as before", async () => {
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
		const d = deps(poolOf(copilot.url, zai.url), null);
		const app = createApp(d);
		const res = await ingest(app, `${copilot.url}/v1/messages`, {}, null);
		expect(res.status).toBe(200);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.account_tier ?? null).toBeNull();
		copilot.close();
		zai.close();
	});

	test("W1265.2 mandatory posture: absent config resolves the general default (personal ride, copilot excluded, anonymous refused)", async () => {
		const def = defaultAccountPolicy();
		expect(def.source).toBe("default:general");
		expect(def.doc.classes[0]?.general).toBe(true);
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
		// generic tool key → personal row only; the enterprise row is denied
		const d = deps(poolOf(copilot.url, zai.url), def.doc);
		const app = createApp(d);
		const ok = await ingest(
			app,
			`${zai.url}/v1/messages`,
			{},
			principal("any-tool-key"),
		);
		expect(ok.status).toBe(200);
		expect(zai.calls.length).toBe(1);
		expect(copilot.calls.length).toBe(0);
		// enterprise-only pool → the general allowlist refuses (no entitled
		// row), zero outbound — no implicit provider switch, no crossover
		const copilotOnly = await startMockUpstream(() =>
			Response.json({
				id: "m-c",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const d2 = deps(
			{
				groups: () => ["claude-sonnet-5"],
				deployments: (g) => [
					{
						group: g,
						url: copilotOnly.url,
						dialect: "anthropic" as const,
						adapter: "github_copilot",
					},
				],
			},
			def.doc,
		);
		const app2 = createApp(d2);
		const nope = await ingest(
			app2,
			`${copilotOnly.url}/v1/messages`,
			{},
			principal("any-tool-key"),
		);
		expect(nope.status).toBe(503);
		expect(((await nope.json()) as { code?: string }).code).toBe(
			"buckle.tier_no_upstream",
		);
		expect(copilotOnly.calls.length).toBe(0);
		// anonymous on the mandatory default → refused before routing
		const anon = await ingest(app, `${zai.url}/v1/messages`, {}, null);
		expect(anon.status).toBe(403);
		expect(((await anon.json()) as { code?: string }).code).toBe(
			"buckle.repo_unknown",
		);
		copilot.close();
		zai.close();
		copilotOnly.close();
	});

	test("W1265.2 forged /w slug: session key riding a foreign lane = 403 lane_bind_mismatch, zero outbound", async () => {
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
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const forge = new Request(`${zai.url}/w/fleet-personal-2/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
		});
		stashPrincipal(forge, principal("fleet-personal-1"));
		const res = await app.fetch(forge);
		await Bun.sleep(10);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { code?: string }).code).toBe(
			"buckle.lane_bind_mismatch",
		);
		expect(copilot.calls.length).toBe(0);
		expect(zai.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});

	test("W1265.2 matching /w slug rides with lane attribution", async () => {
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
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const req = new Request(`${zai.url}/w/fleet-personal-1/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-5", stream: false }),
		});
		stashPrincipal(req, principal("fleet-personal-1"));
		const res = await app.fetch(req);
		await Bun.sleep(20);
		expect(res.status).toBe(200);
		expect(zai.calls.length).toBe(1);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.lane).toBe("fleet-personal-1");
		expect(audit.account_tier).toBe("personal");
		copilot.close();
		zai.close();
	});

	test("gate-off + active policy = fail closed (repo_unknown)", async () => {
		const copilot = await startMockUpstream(() => Response.json({ id: "m-c" }));
		const zai = await startMockUpstream(() => Response.json({ id: "m-z" }));
		const d = deps(poolOf(copilot.url, zai.url));
		const app = createApp(d);
		const res = await ingest(app, `${copilot.url}/v1/messages`, {}, null);
		expect(res.status).toBe(403);
		const out = (await res.json()) as { code?: string };
		expect(out.code).toBe("buckle.repo_unknown");
		expect(copilot.calls.length).toBe(0);
		expect(zai.calls.length).toBe(0);
		copilot.close();
		zai.close();
	});
});
