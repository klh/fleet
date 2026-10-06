// test/lane-auth.test.ts — the per-lane buckle key surface: belt.env parsing,
// admin-key resolution (env wins over file), and the mint contract (name=sid,
// scope buckle:proxy:WRITE_, bearer admin) against a stubbed fetch.

import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adminKey,
	laneKeyMetaPath,
	laneSettingsPath,
	LANE_KEY_TTL_S,
	mintLaneKey,
	parseEnvFile,
	revokeLaneKey,
	retireLaneKey,
} from "../scripts/lib/lane-auth.ts";

describe("parseEnvFile", () => {
	test("parses KEY=VALUE lines, ignores comments and blanks", () => {
		const env = parseEnvFile(
			["# comment", "", "A=1", 'B="quoted"', "C=1 # trailing", ""].join("\n"),
		);
		expect(env.A).toBe("1");
		expect(env.B).toBe('"quoted"'); // belt.env is ours — quotes stay literal
		expect(env.C).toBe("1 # trailing");
		expect(Object.keys(env).length).toBe(3);
	});
});

describe("adminKey", () => {
	test("process env wins over belt.env", () => {
		const k = adminKey(
			{ BUCKLE_ADMIN_KEY: "bksk_env" } as NodeJS.ProcessEnv,
			"/nonexistent/belt.env",
		);
		expect(k).toBe("bksk_env");
	});
	test("falls back to belt.env, null when neither", () => {
		expect(adminKey({}, "/nonexistent/belt.env")).toBeNull();
	});
});

describe("mintLaneKey", () => {
	test("posts name=sid + proxy scope + TTL with bearer admin, returns key + key_id", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		const stub = (async (url: string | URL, init?: RequestInit) => {
			captured = { url: String(url), init: init ?? {} };
			return new Response(
				JSON.stringify({ key: "bksk_minted", key_id: "abc123def456" }),
				{ status: 201 },
			);
		}) as unknown as typeof fetch;
		const minted = await mintLaneKey("autow123", "bksk_admin", stub);
		expect(minted).toEqual({ key: "bksk_minted", keyId: "abc123def456" });
		const c = captured as { url: string; init: RequestInit } | null;
		expect(c?.url).toBe("http://127.0.0.1:4101/v1/admin/keys");
		const headers = c?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer bksk_admin");
		const body = JSON.parse(String(c?.init.body)) as {
			name: string;
			scopes: string[];
			expires_in_s: number;
		};
		expect(body.name).toBe("autow123");
		expect(body.scopes).toEqual(["buckle:proxy:WRITE_"]);
		expect(body.expires_in_s).toBe(LANE_KEY_TTL_S);
	});

	test("returns null on non-201, missing key shape, or missing key_id", async () => {
		const mk = (status: number, body: unknown) =>
			(async () =>
				new Response(JSON.stringify(body), {
					status,
				})) as unknown as typeof fetch;
		expect(
			await mintLaneKey("autow123", "bksk_admin", mk(403, { error: "no" })),
		).toBeNull();
		expect(
			await mintLaneKey("autow123", "bksk_admin", mk(201, { key: "bksk_x" })),
		).toBeNull();
		expect(
			await mintLaneKey(
				"autow123",
				"bksk_admin",
				mk(201, { key_id: "abc123def456" }),
			),
		).toBeNull();
	});
});

describe("revokeLaneKey", () => {
	test("POSTs the revoke route with bearer admin; true on ok", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		const stub = (async (url: string | URL, init?: RequestInit) => {
			captured = { url: String(url), init: init ?? {} };
			return new Response(JSON.stringify({ revoked: "abc123def456" }));
		}) as unknown as typeof fetch;
		const ok = await revokeLaneKey("abc123def456", "bksk_admin", stub);
		expect(ok).toBe(true);
		const c = captured as { url: string; init: RequestInit } | null;
		expect(c?.url).toBe(
			"http://127.0.0.1:4101/v1/admin/keys/abc123def456/revoke",
		);
		expect(c?.init.method).toBe("POST");
		const headers = c?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer bksk_admin");
	});

	test("false on rejection", async () => {
		const stub = (async () =>
			new Response(JSON.stringify({ error: "no such key" }), {
				status: 404,
			})) as unknown as typeof fetch;
		expect(await revokeLaneKey("abc123def456", "bksk_admin", stub)).toBe(false);
	});
});

describe("retireLaneKey", () => {
	const newFleet = (): string => {
		const fleet = mkdtempSync(join(tmpdir(), "w463-fleet-"));
		return fleet;
	};

	test("revokes by meta key_id and deletes lane key meta + settings files", async () => {
		const fleet = newFleet();
		const metaPath = laneKeyMetaPath(fleet, "autow123");
		const settingsPath = laneSettingsPath(fleet, "autow123");
		writeFileSync(metaPath, JSON.stringify({ key_id: "abc123def456" }));
		chmodSync(metaPath, 0o600);
		writeFileSync(settingsPath, "{}");
		const stub = (async () =>
			new Response(
				JSON.stringify({ revoked: "abc123def456" }),
			)) as unknown as typeof fetch;
		const rk = await retireLaneKey({
			fleet,
			sid: "autow123",
			admin: "bksk_admin",
			fetchFn: stub,
			front: "http://stub",
		});
		expect(rk).toEqual({
			sid: "autow123",
			keyId: "abc123def456",
			revoked: true,
			removed: [metaPath, settingsPath],
		});
		expect(existsSync(metaPath)).toBe(false);
		expect(existsSync(settingsPath)).toBe(false);
		rmSync(fleet, { recursive: true, force: true });
	});

	test("revoke failure keeps the audit keyId, still cleans local files", async () => {
		const fleet = newFleet();
		writeFileSync(
			laneKeyMetaPath(fleet, "autow123"),
			JSON.stringify({ key_id: "abc123def456" }),
		);
		writeFileSync(laneSettingsPath(fleet, "autow123"), "{}");
		const stub = (async () =>
			new Response("boom", { status: 500 })) as unknown as typeof fetch;
		const rk = await retireLaneKey({
			fleet,
			sid: "autow123",
			admin: "bksk_admin",
			fetchFn: stub,
			front: "http://stub",
		});
		expect(rk.keyId).toBe("abc123def456");
		expect(rk.revoked).toBe(false);
		expect(rk.removed).toHaveLength(2);
		rmSync(fleet, { recursive: true, force: true });
	});

	test("no meta file: no revoke call, settings cleanup still happens", async () => {
		const fleet = newFleet();
		const settingsPath = laneSettingsPath(fleet, "autow123");
		writeFileSync(settingsPath, "{}");
		const stub = (async () => {
			throw new Error("revoke must not be called without a meta key id");
		}) as unknown as typeof fetch;
		const rk = await retireLaneKey({
			fleet,
			sid: "autow123",
			admin: "bksk_admin",
			fetchFn: stub,
			front: "http://stub",
		});
		expect(rk.keyId).toBeNull();
		expect(rk.revoked).toBe(false);
		expect(rk.removed).toEqual([settingsPath]);
		rmSync(fleet, { recursive: true, force: true });
	});
});
