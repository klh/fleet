// test/gov-federation-e2e.test.ts — W775.2 phase 3: the full federation walk
// through REAL routes with the gov seam wired the OVERLAY way (boot() →
// loadOverlay → createGovSeam → startServer auth opts). Proves the routes
// stopped answering honest 501s once the seam rides the loaded overlay:
// enroll redeem → signed manifest pull → entitlements → CR declare →
// list → applied → verified (probe-registered at the factory). The mini
// providers in the fixture are HTTP-walk doubles for the enterprise overlay
// (whose real providers carry the guard/claim laws — see the overlay tests).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/server.ts";

const tmp = mkdtempSync(join(tmpdir(), "fleet-fed-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// env knobs this suite mutates — saved + restored after every walk
const ENV_KEYS = [
	"KLH_OVERLAY_DIR",
	"KLH_OVERLAY_ALLOW",
	"KLH_OVERLAY_SHA256",
	"BUCKLE_PORT",
	"BUCKLE_AUTH",
	"BUCKLE_ROOT_KEY",
	"BUCKLE_SECRETS_HOME",
	"BUCKLE_DB",
] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const));
afterAll(() => {
	for (const [k, v] of saved) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function envFor(dir: string): void {
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.BUCKLE_PORT = "0";
	process.env.BUCKLE_AUTH = "on";
	process.env.BUCKLE_ROOT_KEY = "e2e-root";
	process.env.BUCKLE_DB = join(tmp, "fed-e2e.db");
	process.env.BUCKLE_SECRETS_HOME = join(tmp, "secrets");
	process.env.KLH_OVERLAY_DIR = dir;
	process.env.KLH_OVERLAY_ALLOW = tmp;
}

async function writeOverlay(): Promise<string> {
	const dir = join(tmp, "e2e-overlay");
	mkdirSync(dir, { recursive: true });
	const entryPath = join(dir, "entry.ts");
	await Bun.write(
		entryPath,
		await Bun.file(
			join(import.meta.dir, "fixtures", "w7752-govseam-entry.ts"),
		).text(),
	);
	const digest = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(entryPath).arrayBuffer())
		.digest("hex");
	await Bun.write(
		join(dir, "manifest.json"),
		JSON.stringify({
			name: "fed-e2e-fixture",
			protocol: 1,
			entry: "entry.ts",
			sha256: digest,
		}),
	);
	return dir;
}

interface FedStash {
	spokes: {
		mint(o: { spokeId: string; ttlS: number | null; actor: string }): {
			code: string;
			expiresAt: number;
		};
	};
}

async function bootFixture(): Promise<{
	base: string;
	stop: () => void;
}> {
	const dir = await writeOverlay();
	envFor(dir);
	const server = await boot();
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

const fedOf = (): FedStash => {
	const fed = (globalThis as unknown as { __w7752fed?: FedStash }).__w7752fed;
	if (!fed)
		throw new Error("fixture stash missing — boot never wired the seam");
	return fed;
};

describe("federation e2e — leg 1: enroll (W775.2)", () => {
	test("code redeem → 201 once → 409 on replay", async () => {
		const { base, stop } = await bootFixture();
		try {
			const { code } = fedOf().spokes.mint({
				spokeId: "spoke-1",
				ttlS: 600,
				actor: "e2e",
			});
			const res = await fetch(`${base}/federation/enroll`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code }),
			});
			expect(res.status).toBe(201);
			const enrolled = (await res.json()) as { key_id: string };
			expect(enrolled.key_id).toBe("key-spoke-1");
			const replay = await fetch(`${base}/federation/enroll`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code }),
			});
			expect(replay.status).toBe(409);
		} finally {
			stop();
		}
	});
});

describe("federation e2e — leg 2: signed manifest + entitlements (W775.2)", () => {
	test("pull serves a signed manifest; entitlements serve the menu", async () => {
		const { base, stop } = await bootFixture();
		try {
			const m = await fetch(`${base}/federation/policy-manifest`, {
				headers: { authorization: "Bearer e2e-root" },
			});
			expect(m.status).toBe(200);
			expect(m.headers.get("x-buckle-manifest-signature")).toMatch(/^ey/);
			const manifest = (await m.json()) as {
				version: string;
				rules: Array<{ id: string }>;
				cr_queue: unknown[];
			};
			expect(manifest.version).toMatch(/^fed-/);
			expect(manifest.rules.map((r) => r.id)).toContain("gateway.knobs");
			expect(manifest.cr_queue).toEqual([]);
		} finally {
			stop();
		}
	});
	test("entitlements serve the menu; usage stays honest 501", async () => {
		const { base, stop } = await bootFixture();
		try {
			const e = await fetch(`${base}/federation/entitlements`, {
				headers: { authorization: "Bearer e2e-root" },
			});
			expect(e.status).toBe(200);
			const menu = (await e.json()) as {
				models: Array<{ id: string }>;
			};
			expect(menu.models.map((x) => x.id)).toEqual(["glm-5.3-flash"]);
		} finally {
			stop();
		}
	});
	test("usage stays an honest 501 (usageIngest absent from the seam)", async () => {
		const { base, stop } = await bootFixture();
		try {
			const u = await fetch(`${base}/federation/usage`, {
				headers: { authorization: "Bearer e2e-root" },
			});
			expect(u.status).toBe(501);
			expect(((await u.json()) as { error: { code: string } }).error.code).toBe(
				"buckle.no_federation",
			);
		} finally {
			stop();
		}
	});
});

describe("federation e2e — leg 3: CR lifecycle to verified (W775.2)", () => {
	test("declare → 201, list shows declared", async () => {
		const { base, stop } = await bootFixture();
		try {
			const d = await fetch(`${base}/federation/cr`, {
				method: "POST",
				headers: {
					authorization: "Bearer e2e-root",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					id: "cr-e2e-1",
					action: "route.add",
					target: "model:llama-4-scout",
					payload: { weight: 1 },
					origin: { system: "e2e", actor: "owner" },
				}),
			});
			expect(d.status).toBe(201);
			const declared = (await d.json()) as { state: string };
			expect(declared.state).toBe("declared");
		} finally {
			stop();
		}
	});
	test("list shows the declared rows", async () => {
		const { base, stop } = await bootFixture();
		try {
			await fetch(`${base}/federation/cr`, {
				method: "POST",
				headers: {
					authorization: "Bearer e2e-root",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					id: "cr-e2e-2",
					action: "route.add",
					target: "model:llama-4-scout",
					payload: { weight: 1 },
					origin: { system: "e2e", actor: "owner" },
				}),
			});
			const l = await fetch(`${base}/federation/cr`, {
				headers: { authorization: "Bearer e2e-root" },
			});
			expect(l.status).toBe(200);
			const listing = (await l.json()) as {
				cr_queue: Array<{ id: string; state: string }>;
			};
			expect(listing.cr_queue.map((r) => r.id)).toContain("cr-e2e-1");
			expect(listing.cr_queue.map((r) => r.id)).toContain("cr-e2e-2");
		} finally {
			stop();
		}
	});
	test("applied → verified via the factory probe; unknown id → 404", async () => {
		const { base, stop } = await bootFixture();
		const post = (id: string, state: string) =>
			fetch(`${base}/federation/cr/${id}/status`, {
				method: "POST",
				headers: {
					authorization: "Bearer e2e-root",
					"content-type": "application/json",
				},
				body: JSON.stringify({ state, note: null }),
			});
		try {
			const a = await post("cr-e2e-1", "applied");
			expect(a.status).toBe(200);
			const v = await post("cr-e2e-1", "verified");
			expect(v.status).toBe(200);
			const done = (await v.json()) as { state: string };
			expect(done.state).toBe("verified");
			const nope = await post("cr-e2e-nope", "applied");
			expect(nope.status).toBe(404);
		} finally {
			stop();
		}
	});
});
