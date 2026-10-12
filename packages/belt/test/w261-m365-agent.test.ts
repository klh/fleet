// W261 — belt M365 custom-engine agent wrapper: delegated Entra auth
// (device-code + 0600 cache), Graph Retrieval grounding client, agent
// endpoint (Activity in → grounded reply out). All upstreams are stub
// Bun.serve servers on port 0 — no live tenant, no real keys.
import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	awaitDeviceApproval,
	beginDeviceLogin,
	getDelegatedToken,
	loadEntraConfig,
	logout,
	readTokenCache,
	writeTokenCache,
} from "../bin/m365/entra-auth.ts";
import {
	ground,
	loadRetrievalOptions,
	normalizeHits,
} from "../bin/m365/retrieval.ts";
import {
	clearKeyCache,
	defaultDeps,
	handleAgentActivity,
	m365AgentFetch,
	parseActivity,
	shimCompletion,
	type AgentDeps,
} from "../bin/m365/agent-endpoint.ts";

const dir = mkdtempSync(join(tmpdir(), "w261-m365-"));
const CACHE = join(dir, "tokens.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// --- stub upstreams (one server plays OIDC + Graph + JWKS) ---

const STUB_PORT = 0;
let tokenGrants = 0; // device-code approvals issued
const refreshAttempts: string[] = [];
let graphMode: "ok" | "unauth" | "garbage" = "ok";
let graphCalls = 0;

const stub = Bun.serve({
	port: STUB_PORT,
	hostname: "127.0.0.1",
	fetch: async (req) => {
		const url = new URL(req.url);
		const body =
			req.method === "POST" ? new URLSearchParams(await req.text()) : null;
		if (url.pathname.endsWith("/oauth2/v2.0/devicecode"))
			return Response.json({
				device_code: "dc1",
				user_code: "ABCD-1234",
				verification_uri: "https://microsoft.com/devicelogin",
				interval: 1,
				expires_in: 900,
			});
		if (url.pathname.endsWith("/oauth2/v2.0/token")) {
			if (
				body?.get("grant_type") ===
				"urn:ietf:params:oauth:grant-type:device_code"
			) {
				tokenGrants++;
				if (tokenGrants <= 2)
					return Response.json({ error: "authorization_pending" });
				return Response.json({
					access_token: "at-device",
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "rt-good",
				});
			}
			const rt = body?.get("refresh_token") ?? "";
			refreshAttempts.push(rt);
			if (rt === "rt-dead")
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			return Response.json({
				access_token: "at-refreshed",
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: "rt-rotated",
			});
		}
		if (url.pathname.endsWith("/discovery/v2.0/keys"))
			return Response.json({ keys: [RSA_JWK] });
		if (url.pathname.endsWith("/copilot/retrieval")) {
			graphCalls++;
			if (graphMode === "unauth") return new Response("no", { status: 401 });
			if (graphMode === "garbage")
				return Response.json({ totally: "different" });
			return Response.json({
				responses: [
					{
						retrievalHits: [
							{
								webUrl: "https://contoso.sharepoint.com/w261-brief.docx",
								displayName: "W261 brief",
								summary: "Door C wrapper spec",
								resourceType: "listItem",
							},
							{
								url: "https://contoso.sharepoint.com/legacy",
								title: "legacy field names",
							},
						],
					},
				],
			});
		}
		if (url.pathname === "/v1/messages")
			return Response.json({
				content: [{ type: "text", text: "grounded answer" }],
			});
		return new Response("not found", { status: 404 });
	},
});

const BASE = `http://127.0.0.1:${stub.port}`;
const ENV: Record<string, string> = {
	M365_TENANT_ID: "tenant-t",
	M365_CLIENT_ID: "client-c",
	M365_AUTHORITY: BASE,
	M365_TOKEN_CACHE: CACHE,
	M365_GRAPH_BASE: BASE,
	M365_COMPLETIONS_URL: `${BASE}/v1/messages`,
};

// --- RSA keypair for caller-validation tests ---

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const RSA_JWK = {
	...(publicKey.export({ format: "jwk" }) as Record<string, string>),
	kid: "test-kid",
};

function b64urlJson(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeJwt(claims: Record<string, unknown>, kid = "test-kid"): string {
	const head = b64urlJson({ alg: "RS256", kid });
	const sig = cryptoSign(
		"RSA-SHA256",
		Buffer.from(`${head}.${b64urlJson(claims)}`),
		privateKey,
	);
	return `${head}.${b64urlJson(claims)}.${Buffer.from(sig).toString("base64url")}`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 600;

describe("entra-auth", () => {
	test("config: null without ids, populated with defaults", () => {
		expect(loadEntraConfig({})).toBeNull();
		const cfg = loadEntraConfig(ENV);
		expect(cfg?.tenantId).toBe("tenant-t");
		expect(cfg?.authority).toBe(BASE);
		expect(cfg?.graphScopes.length).toBeGreaterThan(1);
	});

	test("device flow: begin → approve → cache 0600 → token from cache", async () => {
		const cfg = loadEntraConfig(ENV);
		expect(cfg).not.toBeNull();
		if (!cfg) return;
		const begun = await beginDeviceLogin(cfg);
		expect(begun.userCode).toBe("ABCD-1234");
		// two pending polls then the grant (stub counts)
		const tokens = await awaitDeviceApproval(cfg, begun, {
			onPrompt: () => {},
		});
		expect(tokens.accessToken).toBe("at-device");
		writeTokenCache(CACHE, tokens);
		expect(statSync(CACHE).mode & 0o777).toBe(0o600);

		const got = await getDelegatedToken({ env: ENV, cachePath: CACHE });
		expect(got.ok).toBe(true);
		if (got.ok) expect(got.token).toBe("at-device");
	});

	test("expired cache + healthy refresh grant → rotated tokens cached", async () => {
		writeTokenCache(CACHE, {
			accessToken: "at-stale",
			expiresAt: Date.now() - 1000,
			refreshToken: "rt-good",
		});
		const got = await getDelegatedToken({ env: ENV, cachePath: CACHE });
		expect(got.ok).toBe(true);
		if (got.ok) expect(got.token).toBe("at-refreshed");
		expect(readTokenCache(CACHE)?.refreshToken).toBe("rt-rotated");
	});

	test("dead refresh grant → login-needed with hint", async () => {
		writeTokenCache(CACHE, {
			accessToken: "at-stale",
			expiresAt: Date.now() - 1000,
			refreshToken: "rt-dead",
		});
		const got = await getDelegatedToken({ env: ENV, cachePath: CACHE });
		expect(got.ok).toBe(false);
		if (!got.ok) {
			expect(got.reason).toBe("login-needed");
			expect(got.hint).toContain("login.ts");
		}
	});

	test("logout removes the cache", () => {
		writeTokenCache(CACHE, { accessToken: "x", expiresAt: Date.now() + 1000 });
		expect(logout(CACHE)).toBe(true);
		expect(readTokenCache(CACHE)).toBeNull();
	});
});

describe("retrieval", () => {
	test("options default to graph beta / sharePoint", () => {
		const ro = loadRetrievalOptions({});
		expect(ro.graphBase).toBe("https://graph.microsoft.com");
		expect(ro.apiVersion).toBe("beta");
		expect(ro.dataSource).toBe("sharePoint");
	});

	test("normalizeHits accepts canonical + legacy field names", () => {
		const hits = normalizeHits({
			responses: [
				{
					retrievalHits: [
						{
							webUrl: "https://a",
							displayName: "A",
							summary: "s",
							resourceType: "listItem",
						},
						{ url: "https://b", title: "B", snippet: "t" },
					],
				},
			],
		});
		expect(hits).toHaveLength(2);
		expect(hits[0].title).toBe("A");
		expect(hits[1].title).toBe("B");
	});

	test("ground: delegated token → hits; 401 → login-needed; garbage → empty ok", async () => {
		writeTokenCache(CACHE, {
			accessToken: "at-live",
			expiresAt: Date.now() + 600_000,
		});
		graphMode = "ok";
		const ok = await ground("w261 brief", { env: ENV, cachePath: CACHE });
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.hits).toHaveLength(2);
			expect(ok.hits[0].url).toBe(
				"https://contoso.sharepoint.com/w261-brief.docx",
			);
		}
		expect(graphCalls).toBeGreaterThan(0);

		graphMode = "unauth";
		const unauth = await ground("q", { env: ENV, cachePath: CACHE });
		expect(unauth.ok).toBe(false);
		if (!unauth.ok) {
			expect(unauth.reason).toBe("login-needed");
			expect(unauth.status).toBe(401);
		}

		graphMode = "garbage";
		const garbage = await ground("q", { env: ENV, cachePath: CACHE });
		expect(garbage.ok).toBe(true);
	});

	test("not configured → not-configured result", async () => {
		const got = await ground("q", {
			env: { M365_TOKEN_CACHE: CACHE },
			cachePath: CACHE,
		});
		expect(got.ok).toBe(false);
		if (!got.ok) expect(got.reason).toBe("not-configured");
	});
});

describe("agent endpoint", () => {
	const stubDeps: AgentDeps = {
		validate: false,
		ground: async () => ({
			ok: true,
			hits: [
				{
					resourceType: "listItem",
					url: "https://a",
					title: "W261 brief",
					snippet: "Door C spec",
				},
			],
		}),
		complete: async (system) => {
			expect(system).toContain("GROUNDED M365 CONTENT");
			expect(system).toContain("W261 brief");
			return "the answer";
		},
		maxGroundChars: 6000,
	};

	test("parse + non-message + empty text", async () => {
		expect(parseActivity("nope")).toBeNull();
		expect(parseActivity({})).toBeNull();
		const nonMsg = await handleAgentActivity(stubDeps, {
			type: "conversationUpdate",
		});
		expect(nonMsg.text).toBe("");
		const empty = await handleAgentActivity(stubDeps, {
			type: "message",
			text: "   ",
		});
		expect(empty.text).toContain("question");
	});

	test("message → grounded completion reply", async () => {
		const reply = await handleAgentActivity(stubDeps, {
			type: "message",
			text: "what is door C?",
		});
		expect(reply).toEqual({ type: "message", text: "the answer" });
	});

	test("login-needed → hint text", async () => {
		const deps: AgentDeps = {
			...stubDeps,
			ground: async () => ({
				ok: false,
				reason: "login-needed",
				hint: "run login.ts",
			}),
		};
		const reply = await handleAgentActivity(deps, {
			type: "message",
			text: "q",
		});
		expect(reply.text).toContain("login-needed");
		expect(reply.text).toContain("login.ts");
	});

	test("grounding http failure → status in reply", async () => {
		const deps: AgentDeps = {
			...stubDeps,
			ground: async () => ({
				ok: false,
				reason: "http",
				status: 503,
				detail: "down",
			}),
		};
		const reply = await handleAgentActivity(deps, {
			type: "message",
			text: "q",
		});
		expect(reply.text).toContain("503");
	});

	test("completion throw → honest failure text, no 500", async () => {
		const deps: AgentDeps = {
			...stubDeps,
			complete: async () => {
				throw new Error("upstream dead");
			},
		};
		const reply = await handleAgentActivity(deps, {
			type: "message",
			text: "q",
		});
		expect(reply.text).toContain("completion failed");
		expect(reply.text).toContain("upstream dead");
	});
});

describe("http skin", () => {
	const fetchDeps: AgentDeps = {
		...defaultDeps(ENV),
		validate: false,
		ground: async () => ({ ok: true, hits: [] }),
		complete: async () => "skin answer",
	};

	test("health + method guard + bad body", async () => {
		const handler = m365AgentFetch(fetchDeps);
		const health = await handler(new Request(`${BASE}/api/m365/agent/health`));
		expect(health.status).toBe(200);
		const badMethod = await handler(
			new Request(`${BASE}/api/m365/agent`, { method: "GET" }),
		);
		expect(badMethod.status).toBe(405);
		const badBody = await handler(
			new Request(`${BASE}/api/m365/agent`, {
				method: "POST",
				body: "{oops",
				headers: { "content-type": "application/json" },
			}),
		);
		expect(badBody.status).toBe(400);
	});

	test("POST activity → reply JSON", async () => {
		const handler = m365AgentFetch(fetchDeps);
		const res = await handler(
			new Request(`${BASE}/api/m365/agent`, {
				method: "POST",
				body: JSON.stringify({ type: "message", text: "q" }),
			}),
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { text: string }).text).toBe("skin answer");
	});

	test("validate=1: missing/expired token 401, signed token passes", async () => {
		clearKeyCache();
		const cfg = loadEntraConfig(ENV);
		expect(cfg).not.toBeNull();
		if (!cfg) return;
		const deps: AgentDeps = { ...fetchDeps, validate: true, cfg };
		const handler = m365AgentFetch(deps);

		const noAuth = await handler(
			new Request(`${BASE}/api/m365/agent`, {
				method: "POST",
				body: JSON.stringify({ type: "message", text: "q" }),
			}),
		);
		expect(noAuth.status).toBe(401);

		const expired = makeJwt({
			exp: Math.floor(Date.now() / 1000) - 3600,
			aud: "client-c",
			iss: `${BASE}/tenant-t/v2.0`,
		});
		clearKeyCache();
		const expiredRes = await handler(
			new Request(`${BASE}/api/m365/agent`, {
				method: "POST",
				headers: { authorization: `Bearer ${expired}` },
				body: JSON.stringify({ type: "message", text: "q" }),
			}),
		);
		expect(expiredRes.status).toBe(401);

		const good = makeJwt({
			exp: FUTURE_EXP,
			aud: "client-c",
			iss: `${BASE}/tenant-t/v2.0`,
		});
		clearKeyCache();
		const goodRes = await handler(
			new Request(`${BASE}/api/m365/agent`, {
				method: "POST",
				headers: { authorization: `Bearer ${good}` },
				body: JSON.stringify({ type: "message", text: "q" }),
			}),
		);
		expect(goodRes.status).toBe(200);
		expect(((await goodRes.json()) as { text: string }).text).toBe(
			"skin answer",
		);
	});
});

describe("shimCompletion", () => {
	test("joins text blocks from the anthropic-shaped upstream", async () => {
		const text = await shimCompletion("sys", "user q", ENV);
		expect(text).toBe("grounded answer");
	});

	test("non-ok upstream throws", async () => {
		const dead = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("x", { status: 500 }),
		});
		try {
			await expect(
				shimCompletion("sys", "q", {
					...ENV,
					M365_COMPLETIONS_URL: `http://127.0.0.1:${dead.port}/v1/messages`,
				}),
			).rejects.toThrow("HTTP 500");
		} finally {
			dead.stop(true);
		}
	});
});
