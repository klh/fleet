// test/profile.test.ts — W165 capability split: the shared grammar, the
// installer-written capabilities.json resolution (absent = hub — the
// single-machine dev exemption; present-but-unreadable = fail safe, hub-only
// OFF), the store server's /auth/* capability gate, and the cross-package
// grammar pin against buckle's manifest builder (drift here would strand a
// spoke or re-enable auth code on one).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ALL_CAPABILITIES,
	CAP_AUTH_ISSUANCE,
	HUB_ONLY_CAPABILITIES,
	SHARED_CAPABILITIES,
	hubCapabilities,
	hasCapability,
	readCapabilities,
	resolveCapabilities,
	spokeCapabilities,
	type CapabilityFlags,
} from "../hooks/lib/profile.ts";
import { buildCapabilities } from "../../buckle/src/gov/federation-manifest.ts";

const eqFlags = (a: CapabilityFlags, b: CapabilityFlags): boolean =>
	ALL_CAPABILITIES.every((k) => a[k] === b[k]);

describe("W165 grammar: profile presets", () => {
	test("hub = full (identity, issuance, admin); spoke = shared only", () => {
		const hub = hubCapabilities();
		const spoke = spokeCapabilities();
		expect(eqFlags(hub, spoke)).toBe(false);
		for (const k of ALL_CAPABILITIES) {
			expect(hub[k]).toBe(true);
		}
		for (const k of HUB_ONLY_CAPABILITIES) {
			expect(spoke[k]).toBe(false);
		}
		for (const k of SHARED_CAPABILITIES) {
			expect(spoke[k]).toBe(true);
		}
	});

	test("hasCapability reads the typed flag", () => {
		expect(hasCapability(spokeCapabilities(), CAP_AUTH_ISSUANCE)).toBe(false);
		expect(hasCapability(hubCapabilities(), CAP_AUTH_ISSUANCE)).toBe(true);
	});
});

describe("W165 grammar: resolution rules", () => {
	test("missing payload = no profile chosen = hub (dev exemption)", () => {
		expect(eqFlags(resolveCapabilities(null), hubCapabilities())).toBe(true);
		expect(eqFlags(resolveCapabilities(undefined), hubCapabilities())).toBe(
			true,
		);
	});

	test("present payload defaults hub-only OFF (fail safe)", () => {
		const f = resolveCapabilities({});
		for (const k of HUB_ONLY_CAPABILITIES) {
			expect(f[k]).toBe(false);
		}
		for (const k of SHARED_CAPABILITIES) {
			expect(f[k]).toBe(true);
		}
	});

	test("booleans ride; malformed entries fail safe", () => {
		const f = resolveCapabilities({ auth_issuance: true, routing: false });
		expect(f.auth_issuance).toBe(true);
		expect(f.routing).toBe(false);
		const g = resolveCapabilities({
			auth_issuance: "yes",
			routing: 1,
		} as unknown as Record<string, unknown>);
		expect(g.auth_issuance).toBe(false); // malformed hub-only → never expect
		expect(g.routing).toBe(true); // malformed shared → stays on
	});
});

describe("W165 file: capabilities.json resolution", () => {
	test("absent file = hub (backward compat + dev exemption)", () => {
		const f = readCapabilities("/nonexistent/w165/capabilities.json");
		expect(eqFlags(f, hubCapabilities())).toBe(true);
	});

	test("spoke file → hub-only flags OFF", () => {
		const dir = mkdtempSync(join(process.cwd(), ".profile-test-"));
		const file = join(dir, "capabilities.json");
		writeFileSync(
			file,
			JSON.stringify({
				auth_issuance: false,
				identity_admin: false,
				key_custody: false,
			}),
		);
		const f = readCapabilities(file);
		expect(hasCapability(f, CAP_AUTH_ISSUANCE)).toBe(false);
		expect(eqFlags(f, spokeCapabilities())).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("present-but-corrupt file fails SAFE (hub-only OFF)", () => {
		const dir = mkdtempSync(join(process.cwd(), ".profile-test-"));
		const file = join(dir, "capabilities.json");
		writeFileSync(file, "{not json");
		const f = readCapabilities(file);
		for (const k of HUB_ONLY_CAPABILITIES) {
			expect(f[k]).toBe(false);
		}
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("W165 grammar pin: suspenders ⇔ buckle", () => {
	test("buckle's manifest builder matches the suspenders presets exactly", () => {
		expect(eqFlags(buildCapabilities("hub"), hubCapabilities())).toBe(true);
		expect(eqFlags(buildCapabilities("spoke"), spokeCapabilities())).toBe(true);
	});
});

// ── e2e: the store server's /auth/* gate + loopback trust ───────────────────
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const SERVER = join(BIN, "store-server.ts");
const home = mkdtempSync(join(process.cwd(), ".profile-e2e-"));
const spokeCaps = mkdtempSync(join(process.cwd(), ".profile-caps-"));
const spokeFile = join(spokeCaps, "capabilities.json");
const hubFile = join(spokeCaps, "hub.json");
writeFileSync(spokeFile, JSON.stringify({ auth_issuance: false }));
writeFileSync(hubFile, JSON.stringify({ auth_issuance: true }));

const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
	for (const p of procs) p.kill();
	rmSync(home, { recursive: true, force: true });
	rmSync(spokeCaps, { recursive: true, force: true });
});

const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

const startServer = async (
	port: number,
	env: Record<string, string>,
): Promise<string> => {
	const p = Bun.spawn(["bun", SERVER, "--port", String(port)], {
		env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
		stdout: "ignore",
		stderr: "ignore",
	});
	procs.push(p);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`${url}/health`);
			if (r.ok) return url;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("store server did not come up");
};

describe("W165 store server: /auth/* capability gate (e2e)", () => {
	test("spoke profile: /auth/* 404s, /rpc still trusts the loopback", async () => {
		const url = await startServer(await freePort(), {
			KLH_CAPABILITIES_FILE: spokeFile,
		});
		const who = await fetch(`${url}/auth/whoami`);
		expect(who.status).toBe(404);
		const token = await fetch(`${url}/auth/token`, {
			method: "POST",
			body: JSON.stringify({ actor: "x", token_class: "app-role" }),
		});
		expect(token.status).toBe(404);
		// loopback trust: the shared grammar still serves, no bearer anywhere
		const rpc = await fetch(`${url}/rpc`, {
			method: "POST",
			body: JSON.stringify({ mode: "get", sql: "SELECT 1 AS one", params: [] }),
		});
		expect(rpc.status).toBe(200);
		expect(((await rpc.json()) as { row: { one: number } }).row.one).toBe(1);
	});

	test("hub profile: /auth routes exist (401 without a bearer, never 404)", async () => {
		const url = await startServer(await freePort(), {
			KLH_CAPABILITIES_FILE: hubFile,
		});
		const who = await fetch(`${url}/auth/whoami`);
		expect(who.status).toBe(401);
		const token = await fetch(`${url}/auth/token`, {
			method: "POST",
			body: JSON.stringify({ actor: "x", token_class: "app-role" }),
		});
		expect(token.status).toBe(401);
	});
});
