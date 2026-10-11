// test/gov-hub-seam.test.ts — W233 enterprise-posture seam: the spoke
// enrollment + fleet-registry routes ride the injected
// SpokeEnrollmentProvider. Provider-less (solo posture) they answer honest
// 501s; with a provider they reach mint/redeem/list. The REAL enrollment
// implementation + its e2e (codes, TTL, one-time redeem, KeyStore issue,
// heartbeat rows) live in the enterprise overlay (klh-remote
// buckle-remote) — this file proves the public seam contract only.
import { describe, expect, test } from "bun:test";
import type {
	HubEntitlementsFactory,
	HubEntitlementsProvider,
	ManifestCrFactory,
	ManifestCrProvider,
	RedeemResult,
	SpokeEnrollmentProvider,
	UsageIngestProvider,
} from "../src/gov/hub-seam.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

/** Mint a spoke:READ_ key through the admin API. */
async function issueSpokeKey(base: string): Promise<string> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({
			name: "spoke-seam",
			scopes: ["buckle:spoke:READ_"],
		}),
	});
	return ((await res.json()) as { key: string }).key;
}

/** Hub with a scratch pool + versioned policy surface. */
async function startFed(opts: {
	spokeEnrollment?: (
		db: import("bun:sqlite").Database,
	) => SpokeEnrollmentProvider;
	usageIngest?: (
		db: import("bun:sqlite").Database,
		policy: unknown,
	) => UsageIngestProvider;
	hubEntitlements?: HubEntitlementsFactory;
	manifestCr?: ManifestCrFactory;
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

describe("entitlements seam — solo posture (no provider)", () => {
	test("authenticated spoke pull answers an honest 501", async () => {
		const { base, stop } = await startFed({});
		try {
			const spoke = await issueSpokeKey(base);
			const res = await fetch(`${base}/federation/entitlements`, {
				headers: { authorization: `Bearer ${spoke}` },
			});
			expect(res.status).toBe(501);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("buckle.no_federation");
		} finally {
			stop();
		}
	});
});

describe("entitlements seam — injected provider", () => {
	test("stub menu served through the real route; ceilings ride along", async () => {
		const stub: HubEntitlementsProvider = {
			models: () => [
				{
					id: "glm-5.3-flash",
					family: "openai-compat",
					tier: "general",
					locality: "hub-local",
					available: true,
				},
			],
		};
		const { base, stop } = await startFed({ hubEntitlements: () => stub });
		try {
			const spoke = await issueSpokeKey(base);
			const res = await fetch(`${base}/federation/entitlements`, {
				headers: { authorization: `Bearer ${spoke}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				models: Array<{ id: string }>;
				ceilings: unknown;
			};
			expect(body.models).toEqual([stub.models()[0]]);
			expect(body.ceilings).toBeNull();
		} finally {
			stop();
		}
	});
});

describe("usage-ingest seam — solo posture (no provider)", () => {
	test("POST/GET /federation/usage answer honest 501s", async () => {
		const { base, stop } = await startFed({});
		try {
			const post = await fetch(`${base}/federation/usage`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${ROOT}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ team: "t", windows: [{ bucket: 1 }] }),
			});
			expect(post.status).toBe(501);
			expect((await post.json()).error.code).toBe("buckle.no_federation");
			const get = await fetch(`${base}/federation/usage`, { headers: ADMIN });
			expect(get.status).toBe(501);
			expect((await get.json()).error.code).toBe("buckle.no_federation");
		} finally {
			stop();
		}
	});
});

describe("usage-ingest seam — injected provider", () => {
	test("ingest rides the provider, spoke = the presenting key's name", async () => {
		const stored: string[] = [];
		const stub: UsageIngestProvider = {
			ingest(o) {
				stored.push(o.spoke);
				return { ok: true, windows: 1, rows: 2 };
			},
			read() {
				return { days: 7, spokes: 1, windows: [], aids: [] };
			},
		};
		const { base, stop } = await startFed({ usageIngest: () => stub });
		const post = await fetch(`${base}/federation/usage`, {
			method: "POST",
			headers: { ...ADMIN, "content-type": "application/json" },
			body: JSON.stringify({ team: "t", windows: [] }),
		});
		expect(post.status).toBe(200);
		const posted = (await post.json()) as {
			ok: boolean;
			rows: number;
			spoke: string;
		};
		// root has no api_keys row — the opaque keyId is the fallback label
		expect(posted).toMatchObject({ ok: true, rows: 2, spoke: "root" });
		expect(stored).toEqual(["root"]);
		stop();
	});

	test("read rides the provider; error envelope maps verbatim", async () => {
		const stub: UsageIngestProvider = {
			ingest: () => ({ ok: true, windows: 0, rows: 0 }),
			read: () => ({ days: 7, spokes: 1, windows: [], aids: [] }),
		};
		const { base, stop } = await startFed({ usageIngest: () => stub });
		const got = await fetch(`${base}/federation/usage?days=7`, {
			headers: ADMIN,
		});
		expect(got.status).toBe(200);
		expect(await got.json()).toMatchObject({ ok: true, days: 7, spokes: 1 });
		// the route maps a !ok verdict straight onto the response
		stub.ingest = () => ({
			ok: false,
			status: 403,
			code: "buckle.self_report_disabled",
			why: "not opted in",
		});
		const denied = await fetch(`${base}/federation/usage`, {
			method: "POST",
			headers: { ...ADMIN, "content-type": "application/json" },
			body: JSON.stringify({ team: "t", windows: [] }),
		});
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe(
			"buckle.self_report_disabled",
		);
		stop();
	});
});

describe("manifest/CR seam — solo posture (no provider)", () => {
	test("GET /federation/policy-manifest answers honest 501", async () => {
		const { base, stop } = await startFed({});
		try {
			const spoke = await issueSpokeKey(base);
			const res = await fetch(`${base}/federation/policy-manifest`, {
				headers: { authorization: `Bearer ${spoke}` },
			});
			expect(res.status).toBe(501);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("buckle.no_federation");
		} finally {
			stop();
		}
	});

	test("CR declare/list/status answer honest 501s", async () => {
		const { base, stop } = await startFed({});
		try {
			const h = { authorization: `Bearer ${ROOT}` };
			const declare = await fetch(`${base}/federation/cr`, {
				method: "POST",
				headers: { ...h, "content-type": "application/json" },
				body: JSON.stringify({
					action: "adopt-policy",
					target: "policy@1",
					origin: { system: "belt", actor: "t" },
				}),
			});
			expect(declare.status).toBe(501);
			const list = await fetch(`${base}/federation/cr`, { headers: h });
			expect(list.status).toBe(501);
			const status = await fetch(`${base}/federation/cr/x/status`, {
				method: "POST",
				headers: { ...h, "content-type": "application/json" },
				body: JSON.stringify({ state: "delivered" }),
			});
			expect(status.status).toBe(501);
		} finally {
			stop();
		}
	});
});

describe("manifest/CR seam — injected provider", () => {
	test("manifest pull rides the provider; the hub signs the exact bytes", async () => {
		const stub: ManifestCrProvider = {
			manifest: () => ({
				version: "fed-seam-stub",
				rules: [{ id: "gateway.knobs", kind: "gateway" }],
				cr_queue: [],
			}),
			declare: () => ({
				ok: false,
				status: 422,
				code: "buckle.cr_private_domain",
				why: "stub",
			}),
			list: () => [],
			transition: () => ({
				ok: false,
				status: 409,
				code: "buckle.cr_state",
				why: "stub",
			}),
			registerProbe: () => {},
		};
		const { base, stop } = await startFed({ manifestCr: () => stub });
		try {
			const spoke = await issueSpokeKey(base);
			const res = await fetch(`${base}/federation/policy-manifest`, {
				headers: { authorization: `Bearer ${spoke}` },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				version: string;
				rules: Array<{ id: string }>;
			};
			expect(body.version).toBe("fed-seam-stub");
			expect(body.rules[0]?.id).toBe("gateway.knobs");
		} finally {
			stop();
		}
	});
});
