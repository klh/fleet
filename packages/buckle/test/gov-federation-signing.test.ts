// test/gov-federation-signing.test.ts — W193 manifest signatures: the hub
// signs the exact manifest bytes with an RS256 identity that never leaves
// BUCKLE_SECRETS_HOME; JWKS serves the public half; tamper fails; restart
// keeps the kid; GETs demand spoke:READ_ (no anonymous pulls).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ManifestSigner,
	verifyJwsDetached,
} from "../src/gov/federation-signing.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

function scratchHome(): string {
	return mkdtempSync(join(tmpdir(), "w193-signing-"));
}

/** Scratch hub with the W193 signing home wired: policy + upstreams yaml,
 *  :memory: db, root key. */
async function testHub(secretsHome: string): Promise<{
	base: string;
	stop: () => void;
}> {
	const dir = scratchHome();
	const policy = JSON.stringify({
		version: 1,
		gateway: {
			num_retries: 1,
			allowed_fails: 3,
			cooldown_time: 30,
			fallbacks: { "glm-5.3-flash": ["gpt-5.2"] },
		},
		tags: { "glm-5.3-flash": ["fast", "general"] },
	});
	const upstreams = JSON.stringify({
		version: 1,
		groups: {
			"glm-5.3-flash": [{ url: "http://127.0.0.1:8501", dialect: "openai" }],
			"gpt-5.2": [],
		},
	});
	const wp = `${dir}/policy.json`;
	const wu = `${dir}/upstreams.json`;
	await Bun.write(wp, policy);
	await Bun.write(wu, upstreams);
	const srv = startServer({
		port: 0,
		policyPath: wp,
		upstreamsPath: wu,
		dbPath: ":memory:",
		auth: {
			rootKey: ROOT,
			// W233.3: the manifest content is overlay-owned — a stub provider
			// proves the PUBLIC signing wrapper (W193 exact-bytes signature)
			// rides whatever the seam serves; the real serving e2e lives in
			// the enterprise overlay.
			manifestCr: () => ({
				manifest: () => ({
					version: "fed-stub-w2333",
					rules: [{ id: "gateway.knobs", kind: "gateway", target: null }],
					cr_queue: [],
				}),
				declare: () => ({
					ok: false as const,
					status: 501,
					code: "buckle.no_federation",
					why: "stub",
				}),
				list: () => [],
				transition: () => ({
					ok: false as const,
					status: 501,
					code: "buckle.no_federation",
					why: "stub",
				}),
				registerProbe: () => {},
			}),
		},
		secretsHome,
	});
	return {
		base: `http://127.0.0.1:${String(srv.port)}`,
		stop: () => srv.stop(true),
	};
}

describe("signer unit", () => {
	test("generate → sign → verify ok; tampered body fails", () => {
		const s = ManifestSigner.create(scratchHome());
		const body = new TextEncoder().encode('{"version":"fed-x"}');
		const jws = s.sign(body);
		expect(s.verify(body, jws)).toBe(true);
		const tampered = Uint8Array.from(body);
		tampered[0] = (tampered[0] ?? 0) ^ 1;
		expect(s.verify(tampered, jws)).toBe(false);
	});
	test("kid stable across reload; JWKS carries kid+use=sig+alg", () => {
		const home = scratchHome();
		const a = ManifestSigner.create(home);
		const b = ManifestSigner.create(home);
		expect(b.kid).toBe(a.kid);
		const jw = a.jwks();
		expect(jw.keys).toHaveLength(1);
		expect(jw.keys[0]?.kid).toBe(a.kid);
		expect(jw.keys[0]?.use).toBe("sig");
		expect(jw.keys[0]?.alg).toBe("RS256");
		expect(jw.keys[0]?.kty).toBe("RSA");
	});
});

describe("hub e2e: JWKS + signed manifest + spoke authz", () => {
	test("JWKS public 200; signed manifest verifies; tamper fails; anon 401", async () => {
		const hub = await testHub(scratchHome());
		const jwRes = await fetch(`${hub.base}/.well-known/jwks.json`);
		expect(jwRes.status).toBe(200);
		const jw = (await jwRes.json()) as {
			keys: Array<{ kid: string; use: string }>;
		};
		expect(jw.keys).toHaveLength(1);
		expect(jw.keys[0]?.use).toBe("sig");
		const anon = await fetch(`${hub.base}/federation/policy-manifest`);
		expect(anon.status).toBe(401);
		const keyRes = await fetch(`${hub.base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({
				name: "spoke-pull",
				scopes: ["buckle:spoke:READ_"],
			}),
		});
		const { key } = (await keyRes.json()) as { key: string };
		const res = await fetch(`${hub.base}/federation/policy-manifest`, {
			headers: { authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(200);
		const sig = res.headers.get("x-buckle-manifest-signature");
		expect(sig).not.toBeNull();
		const bodyBytes = new Uint8Array(await res.arrayBuffer());
		const verdict = await verifyJwsDetached(bodyBytes, sig as string, jw);
		expect(verdict.ok).toBe(true);
		const tampered = Uint8Array.from(bodyBytes);
		tampered[3] = (tampered[3] ?? 0) ^ 1;
		const bad = await verifyJwsDetached(tampered, sig as string, jw);
		expect(bad.ok).toBe(false);
		hub.stop();
	});

	test("entitlements GET demands auth (401 anon; 501 with spoke key — solo posture)", async () => {
		const hub = await testHub(scratchHome());
		// W233.1: the gate still owns the route (401 anon); with a valid spoke
		// key the provider-less solo posture answers the honest 501.
		const anon = await fetch(`${hub.base}/federation/entitlements`);
		expect(anon.status).toBe(401);
		const keyRes = await fetch(`${hub.base}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({
				name: "spoke-menu",
				scopes: ["buckle:spoke:READ_"],
			}),
		});
		const { key } = (await keyRes.json()) as { key: string };
		const res = await fetch(`${hub.base}/federation/entitlements`, {
			headers: { authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(501);
		hub.stop();
	});
});
