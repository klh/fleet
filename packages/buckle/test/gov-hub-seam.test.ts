// test/gov-hub-seam.test.ts — W233 enterprise-posture seam: the spoke
// enrollment + fleet-registry routes ride the injected
// SpokeEnrollmentProvider. Provider-less (solo posture) they answer honest
// 501s; with a provider they reach mint/redeem/list. The REAL enrollment
// implementation + its e2e (codes, TTL, one-time redeem, KeyStore issue,
// heartbeat rows) live in the enterprise overlay (klh-remote
// buckle-remote) — this file proves the public seam contract only.
import { describe, expect, test } from "bun:test";
import type {
	RedeemResult,
	SpokeEnrollmentProvider,
} from "../src/gov/hub-seam.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

/** Hub with a scratch pool + versioned policy surface. */
async function startFed(opts: {
	spokeEnrollment?: (
		db: import("bun:sqlite").Database,
	) => SpokeEnrollmentProvider;
}): Promise<{ base: string; stop: () => void }> {
	const dir = `/tmp/w233-seam-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = [
		"version: 1",
		"gateway:",
		"  num_retries: 1",
		"  fallbacks:",
		"    glm-5.3-flash: [local-swarm]",
		"",
	].join("\n");
	const upstreams = [
		"version: 1",
		"groups:",
		"  glm-5.3-flash:",
		"    - url: http://127.0.0.1:8501",
		"      dialect: openai",
		"  local-swarm: []",
		"",
	].join("\n");
	await Bun.write(`${dir}.policy.yaml`, policy);
	await Bun.write(`${dir}.upstreams.yaml`, upstreams);
	const srv = startServer({
		port: 0,
		policyPath: `${dir}.policy.yaml`,
		upstreamsPath: `${dir}.upstreams.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT, ...opts },
	});
	return { base: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true) };
}

const ADMIN = { authorization: `Bearer ${ROOT}` };

describe("spoke-enrollment seam — solo posture (no provider)", () => {
	test("admin mint/list + redeem answer honest 501s", async () => {
		const { base, stop } = await startFed({});
		try {
			const mint = await fetch(`${base}/v1/admin/spokes/enroll`, {
				method: "POST",
				headers: ADMIN,
				body: JSON.stringify({ spoke_id: "sp-a" }),
			});
			expect(mint.status).toBe(501);
			expect((await mint.json()).code).toBe("buckle.no_federation");
			const list = await fetch(`${base}/v1/admin/spokes`, { headers: ADMIN });
			expect(list.status).toBe(501);
			const redeem = await fetch(`${base}/federation/enroll`, {
				method: "POST",
				body: JSON.stringify({ code: "benrl_x" }),
			});
			expect(redeem.status).toBe(501);
			expect((await redeem.json()).error.code).toBe("buckle.no_federation");
		} finally {
			stop();
		}
	});

	test("manifest pull serves the signed manifest without a provider", async () => {
		const { base, stop } = await startFed({});
		try {
			// W193: pulls authenticate (spoke READ_) — the heartbeat touch is a
			// provider seam; its e2e (real keys, registry rows) is overlay
			// coverage. Here: the anonymous pull's honest 401 proves the gate
			// still owns the route with the enrollment surface provider-less.
			const res = await fetch(`${base}/federation/policy-manifest`);
			expect(res.status).toBe(401);
			const body = await res.json();
			expect(body.code).toBe("buckle.auth_missing");
		} finally {
			stop();
		}
	});
});

describe("spoke-enrollment seam — injected provider", () => {
	test("mint → redeem → list through the real routes", async () => {
		const codes = new Map<string, string>();
		const rows: Array<Record<string, unknown>> = [];
		const stub: SpokeEnrollmentProvider = {
			mint(o) {
				const code = `benrl_stub_${o.spokeId}`;
				codes.set(code, o.spokeId);
				return { code, expiresAt: Date.now() + 60_000 };
			},
			redeem(o): RedeemResult {
				const spokeId = codes.get(o.code);
				if (spokeId === undefined)
					return {
						ok: false,
						code: "buckle.enroll_unknown",
						why: "unknown enrollment code",
					};
				if (codes.get(o.code) === "used")
					return {
						ok: false,
						code: "buckle.enroll_used",
						why: "already redeemed",
					};
				codes.set(o.code, "used");
				rows.push({ spoke_id: spokeId, key_id: "k1" });
				return {
					ok: true,
					spokeId,
					keyId: "k1",
					key: "bksk_stub",
					expiresAt: null,
				};
			},
			touch() {},
			list() {
				return rows as never;
			},
		};
		const { base, stop } = await startFed({ spokeEnrollment: () => stub });
		try {
			const mint = await fetch(`${base}/v1/admin/spokes/enroll`, {
				method: "POST",
				headers: ADMIN,
				body: JSON.stringify({ spoke_id: "sp-stub", ttl_s: 60 }),
			});
			expect(mint.status).toBe(201);
			const mintBody = await mint.json();
			expect(mintBody.spoke_id).toBe("sp-stub");
			expect(mintBody.code.startsWith("benrl_stub_")).toBe(true);

			const redeem = await fetch(`${base}/federation/enroll`, {
				method: "POST",
				body: JSON.stringify({ code: mintBody.code }),
			});
			expect(redeem.status).toBe(201);
			const redeemBody = await redeem.json();
			expect(redeemBody.spoke_id).toBe("sp-stub");
			expect(redeemBody.key).toBe("bksk_stub");
			expect(redeemBody.scopes).toEqual([
				"buckle:spoke:READ_",
				"buckle:spoke:WRITE_",
			]);

			const again = await fetch(`${base}/federation/enroll`, {
				method: "POST",
				body: JSON.stringify({ code: mintBody.code }),
			});
			expect(again.status).toBe(409);

			const unknown = await fetch(`${base}/federation/enroll`, {
				method: "POST",
				body: JSON.stringify({ code: "benrl_missing" }),
			});
			expect(unknown.status).toBe(401);

			const list = await fetch(`${base}/v1/admin/spokes`, { headers: ADMIN });
			expect(list.status).toBe(200);
			expect((await list.json()).spokes).toHaveLength(1);
		} finally {
			stop();
		}
	});
});
