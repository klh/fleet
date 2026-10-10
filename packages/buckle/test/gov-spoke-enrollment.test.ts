// test/gov-spoke-enrollment.test.ts — W173 spoke enrollment + fleet registry
// e2e: admin-minted one-time enrollment code → hub-issued spoke token; the
// registry (id, version, policy version applied, last-seen); heartbeat on
// the pull; the CR reported-up lifecycle walked by an enrolled, named spoke.
import { describe, expect, test } from "bun:test";
import { declareCR } from "../src/gov/federation-manifest.ts";
import { startServer } from "../src/server.ts";

const ROOT = "buckle-test-root";

/** Hub with a scratch pool + versioned policy surface (the verification
 *  probe reads doc version 1 — the CR chain walks to reported-up for real). */
async function startFed(): Promise<{
	base: string;
	srv: ReturnType<typeof startServer>;
	stop: () => void;
}> {
	const dir = `/tmp/w173-enroll-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
		auth: { rootKey: ROOT },
	});
	return {
		base: `http://127.0.0.1:${srv.port}`,
		srv,
		stop: () => srv.stop(true),
	};
}

const ADMIN = { authorization: `Bearer ${ROOT}` };

async function mintCode(
	base: string,
	body: Record<string, unknown>,
): Promise<{
	status: number;
	spoke_id?: string;
	code?: string;
	error?: { code: string };
}> {
	const res = await fetch(`${base}/v1/admin/spokes/enroll`, {
		method: "POST",
		headers: ADMIN,
		body: JSON.stringify(body),
	});
	return { status: res.status, ...(await res.json()) };
}

interface EnrollOut {
	spoke_id: string;
	key_id: string;
	key: string;
	scopes: string[];
	expires_at: number | null;
}

async function redeem(
	base: string,
	code: string,
): Promise<{ status: number; body: EnrollOut | { error: { code: string } } }> {
	const res = await fetch(`${base}/federation/enroll`, {
		method: "POST",
		body: JSON.stringify({ code }),
	});
	return { status: res.status, body: await res.json() };
}

describe("W173 enrollment: mint + redeem", () => {
	test("spoke-class key cannot mint codes (admin-only at the gate)", async () => {
		const fed = await startFed();
		const spoke = await fetch(`${fed.base}/v1/admin/keys`, {
			method: "POST",
			headers: ADMIN,
			body: JSON.stringify({
				name: "plain-spoke",
				scopes: ["buckle:spoke:READ_"],
			}),
		}).then((r) => r.json() as Promise<{ key: string }>);
		const res = await fetch(`${fed.base}/v1/admin/spokes/enroll`, {
			method: "POST",
			headers: { authorization: `Bearer ${spoke.key}` },
			body: JSON.stringify({ spoke_id: "nas" }),
		});
		expect(res.status).toBe(403);
		fed.stop();
	});

	test("code → hub-issued spoke token → authenticated pull; one-time; unknown 401", async () => {
		const fed = await startFed();
		const m = await mintCode(fed.base, { spoke_id: "nas" });
		expect(m.status).toBe(201);
		expect(m.code?.startsWith("benrl_")).toBe(true);
		const r = await redeem(fed.base, m.code ?? "");
		expect(r.status).toBe(201);
		const out = r.body as EnrollOut;
		expect(out.spoke_id).toBe("nas");
		expect(out.scopes).toContain("buckle:spoke:WRITE_");
		fed.stop();
	});

	test("one-time: redeem twice → 409 enroll_used; unknown → 401 enroll_unknown", async () => {
		const fed = await startFed();
		const m = await mintCode(fed.base, { spoke_id: "nas" });
		await redeem(fed.base, m.code ?? "");
		const again = await redeem(fed.base, m.code ?? "");
		expect(again.status).toBe(409);
		expect((again.body as { error: { code: string } }).error.code).toBe(
			"buckle.enroll_used",
		);
		const nope = await redeem(fed.base, "benrl_nope");
		expect(nope.status).toBe(401);
		fed.stop();
	});

	test("expired code → 401 buckle.enroll_expired", async () => {
		const fed = await startFed();
		const m = await mintCode(fed.base, { spoke_id: "nas", ttl_s: 0 });
		const r = await redeem(fed.base, m.code ?? "");
		expect(r.status).toBe(401);
		expect((r.body as { error: { code: string } }).error.code).toBe(
			"buckle.enroll_expired",
		);
		fed.stop();
	});
});

describe("W173 registry: heartbeat on the pull", () => {
	test("enrolled pull updates last_seen + policy_version; admin reads the inventory", async () => {
		const fed = await startFed();
		const m = await mintCode(fed.base, { spoke_id: "nas" });
		const r = await redeem(fed.base, m.code ?? "");
		const out = r.body as EnrollOut;
		const pull = await fetch(`${fed.base}/federation/policy-manifest`, {
			headers: {
				authorization: `Bearer ${out.key}`,
				"x-buckle-spoke-version": "buckle@w173",
			},
		});
		expect(pull.status).toBe(200);
		const inv = await fetch(`${fed.base}/v1/admin/spokes`, {
			headers: ADMIN,
		});
		expect(inv.status).toBe(200);
		const list = (await inv.json()) as {
			spokes: Array<{
				spoke_id: string;
				version: string | null;
				policy_version: string | null;
				last_seen: number | null;
			}>;
		};
		expect(list.spokes).toHaveLength(1);
		const row = list.spokes[0] ?? {};
		expect(row.spoke_id).toBe("nas");
		expect(row.version).toBe("buckle@w173");
		expect(row.policy_version?.startsWith("fed-")).toBe(true);
		expect(row.last_seen === null).toBe(false);
		fed.stop();
	});

	test("unenrolled spoke key pull self-registers under its key id", async () => {
		const fed = await startFed();
		const key = await fetch(`${fed.base}/v1/admin/keys`, {
			method: "POST",
			headers: ADMIN,
			body: JSON.stringify({
				name: "legacy-spoke",
				scopes: ["buckle:spoke:READ_"],
			}),
		}).then((r) => r.json() as Promise<{ key: string; key_id: string }>);
		const pull = await fetch(`${fed.base}/federation/policy-manifest`, {
			headers: { authorization: `Bearer ${key.key}` },
		});
		expect(pull.status).toBe(200);
		const inv = await fetch(`${fed.base}/v1/admin/spokes`, {
			headers: ADMIN,
		});
		const list = (await inv.json()) as { spokes: Array<{ spoke_id: string }> };
		expect(list.spokes.map((s) => s.spoke_id)).toContain(key.key_id);
		fed.stop();
	});
});

describe("W173: CR reported-up lifecycle, for real", () => {
	test("enrolled spoke walks declared→delivered→applied→verified→reported-up", async () => {
		const fed = await startFed();
		const fedDb = fed.srv.gov.federation?.db;
		if (fedDb === undefined)
			throw new Error("federation surface missing on gov");
		declareCR(fedDb, {
			id: "cr-w173",
			action: "adopt-policy",
			target: "policy@1",
			origin: { system: "belt", actor: "w173-test" },
		});
		const m = await mintCode(fed.base, { spoke_id: "w173-spoke" });
		const r = await redeem(fed.base, m.code ?? "");
		const out = r.body as EnrollOut;
		const post = (state: string) =>
			fetch(`${fed.base}/federation/cr/cr-w173/status`, {
				method: "POST",
				headers: { authorization: `Bearer ${out.key}` },
				body: JSON.stringify({ state }),
			});
		const d = await post("delivered");
		expect(d.status).toBe(200);
		const a = await post("applied");
		expect(a.status).toBe(200);
		const v = await post("verified");
		expect(v.status).toBe(200);
		const rep = await post("reported-up");
		expect(rep.status).toBe(200);
		fed.stop();
	});
});
