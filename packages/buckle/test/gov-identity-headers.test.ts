// test/gov-identity-headers.test.ts — W235: the signed identity headers
// (the forward_auth SSO seam): sign → verify round-trip, tamper refusal,
// replay-window refusal, missing headers, and the full gate path — the
// authenticator wired as the adaptation authenticate hook gives an SSO
// principal through the LIVE gate.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SsoIdentity } from "../src/gov/adaptation.ts";
import {
	DEFAULT_IDENTITY_MAX_AGE_S,
	identityHeaderAuthenticator,
	signIdentityHeaders,
	verifyIdentityHeaders,
} from "../src/gov/identity-headers.ts";
import { startServer } from "../src/server.ts";

const KEY = "w235-test-secret";

// W1135.1.7: scratch config dirs go to mkdtemp, cleaned after the suite.
const tmpDirs: string[] = [];
afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const nowS = (): number => Math.floor(Date.now() / 1000);

const CLAIMS = (iat: number = nowS()): SsoIdentity => ({
	v: 1,
	subject: "bob@example.com",
	team: "platform",
	roles: ["engineer"],
	iat,
});

describe("identity headers — sign/verify", () => {
	test("round-trip: sign → verify returns the claims", () => {
		const h = signIdentityHeaders(CLAIMS(), KEY);
		const out = verifyIdentityHeaders(new Headers(h), { key: KEY });
		expect(out).toEqual(CLAIMS());
	});
	test("missing either header → null", () => {
		const h = signIdentityHeaders(CLAIMS(), KEY);
		const one = new Headers();
		one.set("x-klh-identity", h["x-klh-identity"]);
		expect(verifyIdentityHeaders(one, { key: KEY })).toBeNull();
		const two = new Headers();
		two.set("x-klh-identity-sig", h["x-klh-identity-sig"]);
		expect(verifyIdentityHeaders(two, { key: KEY })).toBeNull();
	});
	test("tampered body or wrong key → null", () => {
		const h = signIdentityHeaders(CLAIMS(), KEY);
		const bad = new Headers({
			"x-klh-identity": Buffer.from(
				JSON.stringify({ ...CLAIMS(), subject: "eve@example.com" }),
			).toString("base64url"),
			"x-klh-identity-sig": h["x-klh-identity-sig"],
		});
		expect(verifyIdentityHeaders(bad, { key: KEY })).toBeNull();
		expect(
			verifyIdentityHeaders(new Headers(h), { key: "other-secret" }),
		).toBeNull();
	});
	test("stale or future iat → null (replay window)", () => {
		const stale = signIdentityHeaders(
			CLAIMS(nowS() - DEFAULT_IDENTITY_MAX_AGE_S - 60),
			KEY,
		);
		expect(verifyIdentityHeaders(new Headers(stale), { key: KEY })).toBeNull();
		const future = signIdentityHeaders(CLAIMS(nowS() + 120), KEY);
		expect(verifyIdentityHeaders(new Headers(future), { key: KEY })).toBeNull();
	});
});

describe("identity headers — through the gate", () => {
	test("authenticator as the authenticate hook: SSO principal rides", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w235-ih-"));
		tmpDirs.push(dir);
		await Bun.write(
			`${dir}.policy.json`,
			JSON.stringify({
				version: 1,
				gateway: { fallbacks: { m: ["local"] } },
			}),
		);
		await Bun.write(
			`${dir}.upstreams.json`,
			JSON.stringify({
				version: 1,
				groups: {
					m: [{ url: "http://127.0.0.1:8501", dialect: "openai" }],
				},
			}),
		);
		const srv = startServer({
			port: 0,
			policyPath: `${dir}.policy.json`,
			upstreamsPath: `${dir}.upstreams.json`,
			dbPath: ":memory:",
			auth: {
				rootKey: "rk",
				adaptation: {
					hooks: {
						authenticate: identityHeaderAuthenticator({ key: KEY }),
					},
					ssoRoles: { engineer: ["buckle:proxy:READ_"] },
				},
			},
		});
		try {
			const h = signIdentityHeaders(CLAIMS(), KEY);
			const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
				headers: h,
			});
			expect(res.status).toBe(200);
			const who = await fetch(`http://127.0.0.1:${srv.port}/v1/fleet/whoami`, {
				headers: h,
			});
			expect(who.status).toBe(200);
			const w = (await who.json()) as { kind?: string; actor?: string };
			expect(w.kind).toBe("sso");
			expect(w.actor).toBe("bob@example.com");
		} finally {
			srv.stop(true);
		}
	});
});
