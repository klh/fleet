// test/oidc-env.test.ts — W372: env → JwtOpts contract + fail-closed partials.
import { describe, expect, test } from "bun:test";
import { claimSatisfiesScope, createJwtValidator } from "../src/gov/jwt.ts";
import { oidcGateOptsFromEnv } from "../src/gov/oidc-env.ts";

const FULL = {
	BUCKLE_OIDC_ISSUER: "https://login.microsoftonline.com/t372/v2.0",
	BUCKLE_OIDC_JWKS_URI:
		"https://login.microsoftonline.com/t372/discovery/v2.0/keys",
	BUCKLE_OIDC_AUDIENCE: "app-372",
};

const genKeyPair = async (): Promise<CryptoKeyPair> =>
	crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);

const stubJwks = (pub: Record<string, unknown>): (() => void) => {
	const prev = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ keys: [pub] }), {
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
	return () => {
		globalThis.fetch = prev;
	};
};

const signToken = async (
	priv: CryptoKey,
	scp?: string,
): Promise<string> => {
	const b64u = (s: string): string => Buffer.from(s).toString("base64url");
	const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const c = {
		iss: FULL.BUCKLE_OIDC_ISSUER,
		aud: "app-372",
		exp: Math.floor(Date.now() / 1000) + 600,
		...(scp ? { scp } : {}),
	};
	const p = b64u(JSON.stringify(c));
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		priv,
		new TextEncoder().encode(`${h}.${p}`),
	);
	return `${h}.${p}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
};

describe("requiredScope enforcement (signed token)", () => {
	test("scp present → ok; missing → buckle.jwt_scope", async () => {
		const kp = await genKeyPair();
		const pub = {
			kid: "k372",
			...(await crypto.subtle.exportKey("jwk", kp.publicKey)),
		};
		const restore = stubJwks(pub);
		const v = createJwtValidator({
			issuers: [
				{
					issuer: FULL.BUCKLE_OIDC_ISSUER,
					jwksUri: "http://127.0.0.1:1/jwks",
				},
			],
			audience: "app-372",
			requiredScope: "api://app-372/access_as_user",
		});
		try {
			const good = await v.validate(await signToken(kp.privateKey, "api://app-372/access_as_user"));
			expect(good.ok).toBe(true);
			const bad = await v.validate(await signToken(kp.privateKey));
			expect(bad.ok).toBe(false);
			expect(bad.code).toBe("buckle.jwt_scope");
		} finally {
			restore();
		}
	});
});

describe("oidcGateOptsFromEnv", () => {
	test("no OIDC env = null (base posture)", () => {
		expect(oidcGateOptsFromEnv({})).toBeNull();
	});
	test("full trio → JwtOpts (+ scope passthrough)", () => {
		expect(
			oidcGateOptsFromEnv({
				...FULL,
				BUCKLE_OIDC_REQUIRED_SCOPE: "api://app-372/access_as_user",
			}),
		).toEqual({
			issuers: [
				{
					issuer: "https://login.microsoftonline.com/t372/v2.0",
					jwksUri: FULL.BUCKLE_OIDC_JWKS_URI,
				},
			],
			audience: "app-372",
			requiredScope: "api://app-372/access_as_user",
		});
	});
	test("partial env throws, naming the missing var", () => {
		for (const drop of ["issuer", "jwks", "audience"]) {
			const env = { ...FULL };
			for (const k of Object.keys(env)) {
				if (k.toLowerCase().includes(drop.toLowerCase())) delete env[k];
			}
			expect(() => oidcGateOptsFromEnv(env)).toThrow(/OIDC gate env incomplete/);
		}
	});
});

describe("claimSatisfiesScope", () => {
	test("scp string / array / roles / neither", () => {
		expect(
			claimSatisfiesScope({ scp: "api://app/x api://app/y" }, "api://app/y"),
		).toBe(true);
		expect(claimSatisfiesScope({ scp: ["api://app/x"] }, "api://app/y")).toBe(
			false,
		);
		expect(claimSatisfiesScope({ roles: ["api://app/x"] }, "api://app/x")).toBe(
			true,
		);
		expect(claimSatisfiesScope({}, "api://app/x")).toBe(false);
	});
});
