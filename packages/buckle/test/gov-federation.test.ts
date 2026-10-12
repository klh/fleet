// test/gov-federation.test.ts — W154 federation surfaces e2e: anonymous
// spoke-pull GETs, credential validation (presented creds never downgraded),
// spoke-class scopes, team ceilings, visibility-law exclusion.
// W193: pulls are authenticated (spoke:READ_) and the manifest is signed.
// W233.3: the manifest pull + CR lifecycle ride the ManifestCrProvider seam
// — solo posture answers honest 501s; the serving e2e re-homes to the
// enterprise overlay (klh-remote buckle-remote).
import { describe, expect, test } from "bun:test";
import type { HubEntitlementsFactory } from "../src/gov/hub-seam.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

/** Hub with a scratch pool: one live loopback group, one dormant cloud tier,
 *  one spoke-private group that must never leak into entitlements. */
async function startFed(
	opts: { hubEntitlements?: HubEntitlementsFactory } = {},
): Promise<{
	base: string;
	srv: ReturnType<typeof startServer>;
	stop: () => void;
}> {
	const dir = `/tmp/w154-fed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const policy = [
		"version: 1",
		"gateway:",
		"  num_retries: 1",
		"  allowed_fails: 3",
		"  cooldown_time: 30",
		"  fallbacks:",
		"    glm-5.3-flash: [local-swarm, gpt-5.2]",
		"tags:",
		"  glm-5.3-flash: [fast, cheap, general]",
		"  local-swarm: [local, general]",
		"  gpt-5.2: [frontier]",
		"",
	].join("\n");
	const upstreams = [
		"version: 1",
		"groups:",
		"  glm-5.3-flash:",
		"    - url: http://127.0.0.1:8501",
		"      dialect: openai",
		"  local-swarm:",
		"    - url: http://127.0.0.1:8502",
		"      dialect: openai",
		"      visibility: spoke-private",
		"  gpt-5.2: []",
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
	return {
		base: `http://127.0.0.1:${srv.port}`,
		srv,
		stop: () => srv.stop(true),
	};
}

async function issueKey(
	base: string,
	body: Record<string, unknown>,
): Promise<string> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify(body),
	});
	const out = (await res.json()) as { key: string };
	return out.key;
}

describe("federation: policy manifest (solo posture)", () => {
	test("GET /federation/policy-manifest → honest 501 provider-less", async () => {
		const fed = await startFed();
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-pull",
			scopes: ["buckle:spoke:READ_"],
		});
		const res = await fetch(`${fed.base}/federation/policy-manifest`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		expect(res.status).toBe(501);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("buckle.no_federation");
		expect(body.error.message).toContain("no manifest serving surface");
		fed.stop();
	});
});

describe("federation: entitlements (echo menu, visibility law)", () => {
	test("solo posture — authenticated spoke pull answers honest 501", async () => {
		const fed = await startFed();
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-menu",
			scopes: ["buckle:spoke:READ_"],
		});
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		expect(res.status).toBe(501);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("buckle.no_federation");
		expect(body.error.message).toContain("no entitlements surface");
		fed.stop();
	});

	test("presented credentials are validated — bad bearer is 401, never anonymous", async () => {
		const fed = await startFed();
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: "Bearer bksk_nope" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("buckle.invalid_key");
		fed.stop();
	});
});

describe("federation: spoke-class scopes + team ceilings", () => {
	test("team key → entitlements carry ceilings", async () => {
		const fed = await startFed({
			// W233.1: the menu is overlay-owned; a stub provider proves the
			// ceilings read-side (shared governance schema) stays public.
			hubEntitlements: () => ({
				models: () => [
					{
						id: "stub",
						family: null,
						tier: "general",
						locality: "cloud",
						available: false,
					},
				],
			}),
		});
		await fetch(`${fed.base}/v1/admin/teams`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify({
				team_id: "ops",
				rpm_ceiling: 100,
				tpm_ceiling: 5000,
			}),
		});
		const spokeKey = await issueKey(fed.base, {
			name: "spoke-1",
			team: "ops",
			scopes: ["buckle:spoke:READ_"],
		});
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: `Bearer ${spokeKey}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ceilings: { rpm: number | null; tpm: number | null } | null;
		};
		expect(body.ceilings).toEqual({ rpm: 100, tpm: 5000 });
		fed.stop();
	});

	test("proxy-class key → 403 insufficient_scope on federation GET", async () => {
		const fed = await startFed();
		const proxyKey = await issueKey(fed.base, {
			name: "proxy-1",
			scopes: ["buckle:proxy:WRITE_"],
		});
		const res = await fetch(`${fed.base}/federation/entitlements`, {
			headers: { authorization: `Bearer ${proxyKey}` },
		});
		expect(res.status).toBe(403);
		fed.stop();
	});
});

// W233.3: the CR lifecycle e2e (declared→delivered walks, 409 illegal,
// 404 unknown, claim binding, probe-gated verified) re-homes to the
// enterprise overlay with the ManifestCrProvider implementation.
