// test/gov-adaptation.test.ts — W235 adaptation surface v2: the FOUR typed
// hook points (authenticate / authorize / audit / budget) the enterprise
// overlay registers. Proves the public contract: solo posture unchanged,
// SSO identity resolution only on a missing credential (never downgraded),
// hooks may only deny/refine/attribute — never bypass a core floor, the
// audit tap rides the denied-audits-too stream, and registration is
// fail-closed at boot. The REAL SSO/enterprise implementations live in the
// enterprise overlay.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	principalFromSso,
	type SsoIdentity,
	validDeny,
	validSsoIdentity,
	validateAdaptation,
} from "../src/gov/adaptation.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

// W1135.1.7: scratch config dirs go to mkdtemp, cleaned after the suite.
const tmpDirs: string[] = [];
afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

type AdaptCfg = NonNullable<
	NonNullable<Parameters<typeof startServer>[0]["auth"]>["adaptation"]
>;

/** Hub with a scratch pool + an optional adaptation surface. The test
 *  authenticate hook reads claims from the X-Test-Identity header (the real
 *  signature verification lives in gov/identity-headers.ts / the overlay). */
async function startFed(opts: { adaptation?: AdaptCfg }): Promise<{
	base: string;
	stop: () => void;
}> {
	const dir = `/tmp/w235-adapt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = JSON.stringify({
		version: 1,
		gateway: {
			num_retries: 1,
			fallbacks: { "glm-5.3-flash": ["local-swarm"] },
		},
	});
	const upstreams = JSON.stringify({
		version: 1,
		groups: {
			"glm-5.3-flash": [{ url: "http://127.0.0.1:8501", dialect: "openai" }],
			"local-swarm": [],
		},
	});
	await Bun.write(`${dir}.policy.json`, policy);
	await Bun.write(`${dir}.upstreams.json`, upstreams);
	const srv = startServer({
		port: 0,
		policyPath: `${dir}.policy.json`,
		upstreamsPath: `${dir}.upstreams.json`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT, ...opts },
	});
	return { base: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true) };
}

const CLAIMS: SsoIdentity = {
	v: 1,
	subject: "alice@example.com",
	team: "platform",
	roles: ["engineer"],
	iat: Math.floor(Date.now() / 1000),
};

const ROLE_MAP = { engineer: ["buckle:proxy:READ_"] };

/** Claims carried as JSON in a test header (mock of the signed-identity
 *  header the Caddy forward_auth chain would present). */
const identityHook = (_claims: unknown) => (req: Request) => {
	const raw = req.headers.get("x-test-identity");
	if (raw === null) return null;
	return JSON.parse(raw) as unknown;
};

describe("adaptation — registration is fail-closed", () => {
	test("non-function hook throws at registration", () => {
		expect(() =>
			validateAdaptation({
				hooks: { audit: 42 as unknown as () => void },
				ssoRoles: {},
			}),
		).toThrow("must be a function");
	});
	test("role map with a non-scope string throws", () => {
		expect(() =>
			validateAdaptation({
				hooks: {},
				ssoRoles: { engineer: ["not-a-scope"] },
			}),
		).toThrow("non-scope");
	});
	test("role scope outside ALL_SCOPES throws", () => {
		expect(() =>
			validateAdaptation({
				hooks: {},
				ssoRoles: { engineer: ["buckle:nuclear:WRITE_"] },
			}),
		).toThrow("outside ALL_SCOPES");
	});
});

describe("adaptation — verdict validation", () => {
	test("validDeny: malformed verdicts are discarded, well-formed pass", () => {
		expect(validDeny(null)).toBeNull();
		expect(validDeny({ allow: true })).toBeNull();
		expect(
			validDeny({ allow: false, status: 500, code: "buckle.x", why: "w" }),
		).toBeNull();
		expect(
			validDeny({ allow: false, status: 403, code: "nope", why: "w" }),
		).toBeNull();
		const ok = validDeny({
			allow: false,
			status: 403,
			code: "buckle.authz_denied",
			why: "rbac",
		});
		expect(ok?.code).toBe("buckle.authz_denied");
	});
	test("validSsoIdentity: shape-checked, fail-closed", () => {
		expect(validSsoIdentity({ ...CLAIMS, v: 2 })).toBeNull();
		expect(validSsoIdentity({ ...CLAIMS, subject: "" })).toBeNull();
		expect(validSsoIdentity({ ...CLAIMS, roles: "engineer" })).toBeNull();
		expect(validSsoIdentity(CLAIMS)).toEqual(CLAIMS);
	});
	test("principalFromSso: pinned-map scopes only; unknown roles add nothing", () => {
		const p = principalFromSso(CLAIMS, ROLE_MAP);
		expect(p.kind).toBe("sso");
		expect(p.keyId).toBe("sso:alice@example.com");
		expect(p.team).toBe("platform");
		expect(p.scopes).toEqual(["buckle:proxy:READ_"]);
		const unknown = principalFromSso({ ...CLAIMS, roles: ["nope"] }, ROLE_MAP);
		expect(unknown.scopes).toEqual([]);
	});
});

describe("adaptation — gate behavior", () => {
	test("solo posture unchanged: no credential → 401 auth_missing", async () => {
		const { base, stop } = await startFed({});
		try {
			const res = await fetch(`${base}/v1/models`);
			expect(res.status).toBe(401);
			const body = (await res.json()) as { code?: string };
			expect(body.code).toBe("buckle.auth_missing");
		} finally {
			stop();
		}
	});

	test("SSO resolve: proxy read rides the sso principal", async () => {
		const taps: string[] = [];
		const { base, stop } = await startFed({
			adaptation: {
				hooks: {
					authenticate: identityHook(CLAIMS),
					audit: (e) => taps.push(`${e.code}@${e.route}`),
				},
				ssoRoles: ROLE_MAP,
			},
		});
		try {
			const res = await fetch(`${base}/v1/models`, {
				headers: { "x-test-identity": JSON.stringify(CLAIMS) },
			});
			expect(res.status).toBe(200);
			const who = await fetch(`${base}/v1/fleet/whoami`, {
				headers: { "x-test-identity": JSON.stringify(CLAIMS) },
			});
			expect(who.status).toBe(200);
			const w = (await who.json()) as {
				kind?: string;
				actor?: string;
				team?: string | null;
			};
			expect(w.kind).toBe("sso");
			expect(w.actor).toBe("alice@example.com");
			expect(w.team).toBe("platform");
			expect(taps).toEqual([]);
		} finally {
			stop();
		}
	});

	test("presented-but-invalid credential NEVER downgrades to the SSO path", async () => {
		const { base, stop } = await startFed({
			adaptation: {
				hooks: { authenticate: identityHook(CLAIMS) },
				ssoRoles: ROLE_MAP,
			},
		});
		try {
			const res = await fetch(`${base}/v1/models`, {
				headers: {
					authorization: "Bearer bksk_bogus",
					"x-test-identity": JSON.stringify(CLAIMS),
				},
			});
			expect(res.status).toBe(401);
			const body = (await res.json()) as { code?: string };
			expect(body.code).toBe("buckle.invalid_key");
		} finally {
			stop();
		}
	});

	test("hook without opinion (null) keeps the core 401", async () => {
		const { base, stop } = await startFed({
			adaptation: {
				hooks: { authenticate: () => null },
				ssoRoles: ROLE_MAP,
			},
		});
		try {
			const res = await fetch(`${base}/v1/models`);
			expect(res.status).toBe(401);
		} finally {
			stop();
		}
	});

	test("authorize veto: RBAC denial after the scope check — 403 with the hook's code", async () => {
		const taps: string[] = [];
		const { base, stop } = await startFed({
			adaptation: {
				hooks: {
					authenticate: identityHook(CLAIMS),
					authorize: (i) =>
						i.principal.actor === "alice@example.com"
							? {
									allow: false as const,
									status: 403 as const,
									code: "buckle.authz_denied",
									why: "rbac: alice is benched",
								}
							: null,
					audit: (e) => taps.push(e.code),
				},
				ssoRoles: ROLE_MAP,
			},
		});
		try {
			const res = await fetch(`${base}/v1/models`, {
				headers: { "x-test-identity": JSON.stringify(CLAIMS) },
			});
			expect(res.status).toBe(403);
			const body = (await res.json()) as { code?: string };
			expect(body.code).toBe("buckle.authz_denied");
			expect(taps).toEqual(["buckle.authz_denied"]);
		} finally {
			stop();
		}
	});

	test("budget hook deny → 429 with the hook's code", async () => {
		const { base, stop } = await startFed({
			adaptation: {
				hooks: {
					authenticate: identityHook(CLAIMS),
					budget: () =>
						({
							allow: false as const,
							status: 429 as const,
							code: "buckle.billing_paused",
							why: "billing paused",
						}) as const,
				},
				ssoRoles: ROLE_MAP,
			},
		});
		try {
			const res = await fetch(`${base}/v1/models`, {
				headers: { "x-test-identity": JSON.stringify(CLAIMS) },
			});
			expect(res.status).toBe(429);
			const body = (await res.json()) as { code?: string };
			expect(body.code).toBe("buckle.billing_paused");
		} finally {
			stop();
		}
	});

	test("audit tap sees denials; a throwing tap never breaks the gate", async () => {
		const taps: string[] = [];
		const { base, stop } = await startFed({
			adaptation: {
				hooks: {
					audit: (e) => {
						taps.push(`${e.code}@${e.route}`);
						if (e.route === "/v1/models") throw new Error("siem down");
					},
				},
				ssoRoles: {},
			},
		});
		try {
			const res = await fetch(`${base}/v1/models`);
			expect(res.status).toBe(401);
			expect(taps).toEqual(["buckle.auth_missing@/v1/models"]);
		} finally {
			stop();
		}
	});
});
