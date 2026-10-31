// test/identity-federation.test.ts — W262: the authentik-first claims mapper
// and the federation gates. Mapper unit tests, the verifyJwt resource-server
// integration (RS256 via injected fetch — no network), and the W149
// delegated-plane refusals under federation at the lib (rotateRefresh) and
// route (handleAuthRoutes) level. HOME is a temp dir set BEFORE the dynamic
// imports (the auth-rotation.test.ts pattern).
import { expect, test } from "./pw";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const REAL_SECRETS = process.env.BUCKLE_SECRETS_HOME;
const REAL_STORE = process.env.GOVERNOR_STORE_URL;
const REAL_AUTHCFG = process.env.BUCKLE_AUTH_CONFIG;
const HOME = mkdtempSync(join(process.cwd(), ".idfed-test-home-"));
process.env.HOME = HOME;
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");
process.env.GOVERNOR_STORE_URL = "local";

const auth = await import("../hooks/lib/auth/auth.ts");
const govdb = await import("../hooks/lib/govdb/govdb.ts");
const fed = await import("../hooks/lib/govdb/identity-federation.ts");

void govdb.openStore(); // the governor open runs the ladder — v17 mints the idb tables
// W156/W359: the token plane rides identity.db — issueTokens/rotateRefresh
// and verifyJwt's denylist all take the identity binding
const idb = govdb.openIdentity();

test.afterAll(() => {
	auth.resetAuthCache();
	// restore EVERYTHING this file pinned — test files share one process and
	// later files must not inherit this sandbox
	process.env.HOME = REAL_HOME;
	if (REAL_SECRETS === undefined) delete process.env.BUCKLE_SECRETS_HOME;
	else process.env.BUCKLE_SECRETS_HOME = REAL_SECRETS;
	if (REAL_STORE === undefined) delete process.env.GOVERNOR_STORE_URL;
	else process.env.GOVERNOR_STORE_URL = REAL_STORE;
	if (REAL_AUTHCFG === undefined) delete process.env.BUCKLE_AUTH_CONFIG;
	else process.env.BUCKLE_AUTH_CONFIG = REAL_AUTHCFG;
	rmSync(HOME, { recursive: true, force: true });
});

// ─── test material: authentik-shaped RS256 tokens via injected fetch ────────

const signRs256 = (
	payload: Record<string, unknown>,
	privateKey: string,
	kid: string,
): string => {
	const head = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid }),
	).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signer = createSign("RSA-SHA256");
	signer.update(`${head}.${body}`);
	return `${head}.${body}.${signer.sign(privateKey, "base64url")}`;
};

const RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB_JWK = RSA.publicKey.export({ format: "jwk" }) as Record<
	string,
	unknown
>;
const ISS = "https://idp.example.invalid/application/o/klh/";
const STUB_FETCH = (async (url: string | URL | Request): Promise<Response> => {
	const u = String(url);
	if (u.includes("openid-configuration"))
		return Response.json({
			jwks_uri: "https://example.invalid/jwks",
			issuer: ISS,
		});
	return Response.json({ keys: [PUB_JWK] });
}) as typeof fetch;

const MAP: fed.ClaimsMapConfig = {
	groups_claim: "groups",
	group_scope_map: {
		"klh-admins": ["buckle:admin"],
		"klh-lanes": ["read_coord", "write_coord", "write_auth"],
	},
	team_claim: "klh_team",
};
const FED_CFG: auth.AuthConfig = {
	issuers: [
		{
			type: "oidc" as const,
			iss: ISS,
			discovery: "https://example.invalid/.well-known/openid-configuration",
			audience: "buckle",
			...MAP,
		},
	],
};
const ROLES_CFG: auth.AuthConfig = {
	// legacy shape: no group map — roles-only trust, scope checks skipped
	issuers: [
		{
			type: "oidc" as const,
			iss: ISS,
			discovery: "https://example.invalid/.well-known/openid-configuration",
			audience: "buckle",
			roles: ["buckle.admin"],
		},
	],
};

const req = (tok: string) => ({
	headers: {
		get: (n: string) =>
			n.toLowerCase() === "authorization" ? `Bearer ${tok}` : null,
	},
});
const idpToken = (over: Record<string, unknown> = {}): string => {
	const now = Math.floor(Date.now() / 1000);
	return signRs256(
		{
			iss: ISS,
			aud: "buckle",
			sub: "9f1c-uuid",
			groups: ["klh-lanes"],
			klh_team: "team-nas",
			exp: now + 600,
			iat: now,
			...over,
		},
		RSA.privateKey,
		"kid-1",
	);
};

// ─── mapper units ────────────────────────────────────────────────────────────

test.describe("mapIdpClaims (authentik-first mapper)", () => {
	test("groups → union of mapped scopes, deduped; team from team_claim", () => {
		const m = fed.mapIdpClaims(MAP, {
			sub: "u1",
			groups: ["klh-admins", "klh-lanes", "unknown-group"],
			klh_team: "team-nas",
		});
		expect(m.actor).toBe("u1");
		expect(m.team).toBe("team-nas");
		expect(m.scopes.sort()).toEqual([
			"buckle:admin",
			"read_coord",
			"write_auth",
			"write_coord",
		]);
	});
	test("no groups claim → empty scopes, team null", () => {
		const m = fed.mapIdpClaims(MAP, { sub: "u2" });
		expect(m.scopes).toEqual([]);
		expect(m.team).toBeNull();
	});
	test("groups_claim override; non-string members filtered; bad team claim → null", () => {
		const m = fed.mapIdpClaims(
			{ groups_claim: "my-groups", team_claim: "t" },
			{ sub: "u3", "my-groups": ["g", 42], t: 7 },
		);
		expect(m.scopes).toEqual([]);
		expect(m.team).toBeNull();
	});
});

// ─── verifyJwt resource-server integration ──────────────────────────────────

test.describe("verifyJwt federation (RS256 via injected fetch)", () => {
	test("federated token: scopes mapped, team derived, scope-checked", async () => {
		const r = await auth.verifyJwt(req(idpToken()), "write_auth", {
			config: FED_CFG,
			fetchImpl: STUB_FETCH,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.claims.sub).toBe("9f1c-uuid");
			expect(r.claims.team).toBe("team-nas");
			expect(r.claims.scopes).toContain("write_auth");
		}
	});
	test("map present, token without required scope → 403 insufficient_scope", async () => {
		const r = await auth.verifyJwt(req(idpToken()), "buckle:admin", {
			config: FED_CFG,
			fetchImpl: STUB_FETCH,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("insufficient_scope");
	});
	test("no group map → roles-only trust (scope checks skipped, legacy)", async () => {
		const r = await auth.verifyJwt(
			req(idpToken({ roles: ["buckle.admin"] })),
			"write_auth",
			{ config: ROLES_CFG, fetchImpl: STUB_FETCH },
		);
		expect(r.ok).toBe(true);
	});
	test("roles still enforced alongside a group map (missing_role)", async () => {
		const cfg: auth.AuthConfig = {
			issuers: [{ ...FED_CFG.issuers[0], roles: ["buckle.admin"] }],
		};
		const r = await auth.verifyJwt(req(idpToken()), "write_auth", {
			config: cfg,
			fetchImpl: STUB_FETCH,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("missing_role");
	});
});

// ─── W149 delegated-plane refusals under federation ─────────────────────────

test.describe("rotateRefresh denyClasses (lib gate)", () => {
	const issue = (actor: string, cls: auth.TokenClass) =>
		auth.issueTokens(idb, {
			actor,
			token_class: cls,
			scopes: ["buckle:admin"],
			accessTtlMs: 3600_000,
		});

	test("delegated pair + federation gate → rejected delegated_federated", () => {
		const p = issue("fed-user", "delegated");
		const r = auth.rotateRefresh(idb, p.refresh, "test", {
			denyClasses: ["delegated"],
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("delegated_federated");
	});
	test("app-role pair rotates fine under the same gate", () => {
		const p = issue("fed-machine", "app-role");
		const r = auth.rotateRefresh(idb, p.refresh, "test", {
			denyClasses: ["delegated"],
		});
		expect(r.ok).toBe(true);
	});
	test("no gate (default) → delegated rotates fine (legacy deployments)", () => {
		const p = issue("legacy-user", "delegated");
		const r = auth.rotateRefresh(idb, p.refresh, "test");
		expect(r.ok).toBe(true);
	});
});

// ─── route-level gates: /auth/token + /auth/refresh under federation ────────

const authServer = await import("../hooks/lib/auth/auth-server.ts");
const CFG_FILE = join(HOME, "auth-config.json");
writeFileSync(
	CFG_FILE,
	JSON.stringify({
		issuers: [{ type: "local", iss: "buckle" }, FED_CFG.issuers[0]],
	}),
);

test.describe("/auth/* federation gates (routes)", () => {
	const route = async (
		method: string,
		path: string,
		body: Record<string, unknown>,
		bearer: string,
	): Promise<Response> =>
		authServer.handleAuthRoutes(
			new Request(`http://127.0.0.1:7794${path}`, {
				method,
				headers: { authorization: `Bearer ${bearer}` },
				body: JSON.stringify(body),
			}),
			new URL(`http://127.0.0.1:7794${path}`),
			{ store: idb },
		);

	test("federated /auth/token refuses delegated, admits app-role", async () => {
		process.env.BUCKLE_AUTH_CONFIG = CFG_FILE;
		const admin = auth.issueTokens(idb, {
			actor: "route-admin",
			token_class: "app-role",
			scopes: ["write_auth"],
			accessTtlMs: 3600_000,
		});
		const denied = await route(
			"POST",
			"/auth/token",
			{
				actor: "some-user",
				token_class: "delegated",
				scopes: ["read_coord"],
			},
			admin.access,
		);
		expect(denied.status).toBe(403);
		const deniedBody = (await denied.json()) as { error?: string };
		expect(deniedBody.error).toBe("delegated_federated");

		const admitted = await route(
			"POST",
			"/auth/token",
			{
				actor: "lane-bot",
				token_class: "app-role",
				scopes: ["read_coord"],
			},
			admin.access,
		);
		expect(admitted.status).toBe(201);
	});
	test("without federation the delegated path stays open (legacy)", async () => {
		writeFileSync(
			CFG_FILE,
			JSON.stringify({ issuers: [{ type: "local", iss: "buckle" }] }),
		);
		const admin = auth.issueTokens(idb, {
			actor: "route-admin-2",
			token_class: "app-role",
			scopes: ["write_auth"],
			accessTtlMs: 3600_000,
		});
		const r = await route(
			"POST",
			"/auth/token",
			{
				actor: "still-human",
				token_class: "delegated",
				scopes: ["read_coord"],
			},
			admin.access,
		);
		expect(r.status).toBe(201);
	});
});
