// test/lane-auth.test.ts — the per-lane buckle key surface: belt.env parsing,
// admin-key resolution (env wins over file), and the mint contract (name=sid,
// scope buckle:proxy:WRITE_, bearer admin) against a stubbed fetch.

import { expect, test } from "@playwright/test";
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
	hubCredential,
	laneKeyMetaPath,
	laneSettingsPath,
	LANE_KEY_TTL_S,
	listLaneKeys,
	mintLaneKey,
	parseEnvFile,
	revokeLaneKey,
	retireLaneKey,
} from "../hooks/lib/lanes/lane-auth.ts";
test.describe("@unit", () => {
	test.describe("parseEnvFile", () => {
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

	test.describe("adminKey", () => {
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

	test.describe("mintLaneKey", () => {
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
			expect(minted).toEqual({
				key: "bksk_minted",
				keyId: "abc123def456",
				scopes: undefined,
				expiresAt: null,
			});
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

		test("opts overrides the default scope + TTL, carries the response's scopes/expiry", async () => {
			let body: {
				name?: string;
				scopes?: string[];
				expires_in_s?: number;
			} | null = null;
			const stub = (async (_url: string | URL, init?: RequestInit) => {
				body = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						key: "bksk_scoped",
						key_id: "feed1234",
						scopes: body?.scopes,
						expires_at: 1_700_000_000_000,
					}),
					{ status: 201 },
				);
			}) as unknown as typeof fetch;
			const minted = await mintLaneKey(
				"autow123",
				"bksk_admin",
				stub,
				undefined,
				{
					scopes: ["buckle:store:READ_"],
					ttlS: 60,
				},
			);
			expect(body).toEqual({
				name: "autow123",
				scopes: ["buckle:store:READ_"],
				expires_in_s: 60,
			});
			expect(minted).toEqual({
				key: "bksk_scoped",
				keyId: "feed1234",
				scopes: ["buckle:store:READ_"],
				expiresAt: 1_700_000_000_000,
			});
		});
	});

	// W615: the per-hub credential channel — env override, then the hubs.json
	// registry token (the same surfaces federation-peers pulls manifests with).
	test.describe("hubCredential (W615)", () => {
		test("per-label env token wins, label normalized (dashes → underscores)", () => {
			const env = {
				SUSPENDERS_HUB_MY_HUB_TOKEN: "bksk_hubenv",
			} as NodeJS.ProcessEnv;
			expect(hubCredential("my-hub", env)).toBe("bksk_hubenv");
		});

		test("falls back to the hubs.json registry token for the label", () => {
			const reg = mkdtempSync(join(tmpdir(), "w615-hubs-"));
			const regFile = join(reg, "hubs.json");
			writeFileSync(regFile, JSON.stringify({ REGHUB: { token: "bksk_reg" } }));
			const saved = process.env.SUSPENDERS_HUBS_FILE;
			process.env.SUSPENDERS_HUBS_FILE = regFile;
			try {
				expect(hubCredential("reghub")).toBe("bksk_reg");
			} finally {
				if (saved === undefined) delete process.env.SUSPENDERS_HUBS_FILE;
				else process.env.SUSPENDERS_HUBS_FILE = saved;
				rmSync(reg, { recursive: true, force: true });
			}
		});

		test("null when neither surface has a token", () => {
			const env = {} as NodeJS.ProcessEnv;
			expect(hubCredential("ghosthub", env)).toBeNull();
		});

		// W2566: the exact tredebanken C213 shape — hubs.json 'ikea' (lowercase)
		// behind a .prefer hub=IKEA pin. The URL side folds (resolveHub); the
		// credential side must fold with it or the mint fails "no credential".
		test("registry lookup folds case (W2566: lowercase 'ikea' key, 'IKEA' pin)", () => {
			const reg = mkdtempSync(join(tmpdir(), "w2566-hubs-"));
			const regFile = join(reg, "hubs.json");
			writeFileSync(regFile, JSON.stringify({ ikea: { token: "bksk_ikea" } }));
			const saved = process.env.SUSPENDERS_HUBS_FILE;
			process.env.SUSPENDERS_HUBS_FILE = regFile;
			try {
				expect(hubCredential("IKEA")).toBe("bksk_ikea");
				expect(hubCredential("ikea")).toBe("bksk_ikea");
				expect(hubCredential("Ikea")).toBe("bksk_ikea");
			} finally {
				if (saved === undefined) delete process.env.SUSPENDERS_HUBS_FILE;
				else process.env.SUSPENDERS_HUBS_FILE = saved;
				rmSync(reg, { recursive: true, force: true });
			}
		});

		// W2566: the stack-profile rung — a migrated settings/stack hubs entry
		// carries its token where resolveHub's profile stage reads it; the
		// credential walk reaches it after a registry miss (label folded).
		test("falls through to the stack-profile token after a registry miss (W2566)", () => {
			const dir = mkdtempSync(join(tmpdir(), "w2566-stack-"));
			const regFile = join(dir, "hubs.json");
			const stackFile = join(dir, "stack.json");
			writeFileSync(regFile, JSON.stringify({}));
			writeFileSync(
				stackFile,
				JSON.stringify({
					version: "2.0.0",
					hubs: { TREDE: { url: "http://127.0.0.1:9", token: "bksk_stack" } },
				}),
			);
			const savedReg = process.env.SUSPENDERS_HUBS_FILE;
			const savedStack = process.env.KLH_STACK;
			process.env.SUSPENDERS_HUBS_FILE = regFile;
			process.env.KLH_STACK = stackFile;
			try {
				expect(hubCredential("trede")).toBe("bksk_stack");
				expect(hubCredential("TREDE")).toBe("bksk_stack");
			} finally {
				if (savedReg === undefined) delete process.env.SUSPENDERS_HUBS_FILE;
				else process.env.SUSPENDERS_HUBS_FILE = savedReg;
				if (savedStack === undefined) delete process.env.KLH_STACK;
				else process.env.KLH_STACK = savedStack;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		// W2566: token_file variant — profileToken reads the first line of the
		// 0600 file the profile names (settings never holds the value itself).
		test("stack-profile token_file feeds the credential after a registry miss (W2566)", () => {
			const dir = mkdtempSync(join(tmpdir(), "w2566-stackfile-"));
			const regFile = join(dir, "hubs.json");
			const stackFile = join(dir, "stack.json");
			const tokFile = join(dir, "hub.token");
			writeFileSync(tokFile, "bksk_filetok\n");
			writeFileSync(regFile, JSON.stringify({}));
			writeFileSync(
				stackFile,
				JSON.stringify({
					version: "2.0.0",
					hubs: { NAS: { token_file: tokFile } },
				}),
			);
			const savedReg = process.env.SUSPENDERS_HUBS_FILE;
			const savedStack = process.env.KLH_STACK;
			process.env.SUSPENDERS_HUBS_FILE = regFile;
			process.env.KLH_STACK = stackFile;
			try {
				expect(hubCredential("nas")).toBe("bksk_filetok");
			} finally {
				if (savedReg === undefined) delete process.env.SUSPENDERS_HUBS_FILE;
				else process.env.SUSPENDERS_HUBS_FILE = savedReg;
				if (savedStack === undefined) delete process.env.KLH_STACK;
				else process.env.KLH_STACK = savedStack;
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	test.describe("revokeLaneKey", () => {
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
			expect(await revokeLaneKey("abc123def456", "bksk_admin", stub)).toBe(
				false,
			);
		});
	});

	test.describe("listLaneKeys", () => {
		test("maps storage-form (space-separated) scopes to a list, no key material", async () => {
			const stub = (async () =>
				new Response(
					JSON.stringify({
						keys: [
							{
								key_id: "a1",
								name: "lane-a",
								scopes: "buckle:proxy:WRITE_ buckle:store:READ_",
								expires_at: 123,
								revoked_at: null,
							},
							{ key_id: "a2", name: "lane-b", scopes: null },
						],
					}),
				)) as unknown as typeof fetch;
			const rows = await listLaneKeys("bksk_admin", stub);
			expect(rows).toEqual([
				{
					keyId: "a1",
					name: "lane-a",
					scopes: ["buckle:proxy:WRITE_", "buckle:store:READ_"],
					expiresAt: 123,
					revokedAt: null,
				},
				{
					keyId: "a2",
					name: "lane-b",
					scopes: [],
					expiresAt: null,
					revokedAt: null,
				},
			]);
		});

		test("null on rejection or a malformed body (fail-closed, same posture as mint/revoke)", async () => {
			const rejected = (async () =>
				new Response("nope", { status: 403 })) as unknown as typeof fetch;
			expect(await listLaneKeys("bksk_admin", rejected)).toBeNull();
			const malformed = (async () =>
				new Response(
					JSON.stringify({ oops: true }),
				)) as unknown as typeof fetch;
			expect(await listLaneKeys("bksk_admin", malformed)).toBeNull();
		});
	});

	// W615 helper: pin a hub credential via env (registry file absent) and get
	// a restore thunk — keeps each hub-minted test to one env surface.
	const withHubTokenEnv = (): {
		hubs: string | undefined;
		desktop: string | undefined;
	} => {
		const snap = {
			hubs: process.env.SUSPENDERS_HUBS_FILE,
			desktop: process.env.SUSPENDERS_HUB_DESKTOP_TOKEN,
		};
		process.env.SUSPENDERS_HUBS_FILE = "/nonexistent/w615.json";
		process.env.SUSPENDERS_HUB_DESKTOP_TOKEN = "bksk_hubtok";
		return snap;
	};
	const restoreHubTokenEnv = (snap: {
		hubs: string | undefined;
		desktop: string | undefined;
	}): void => {
		if (snap.hubs === undefined) delete process.env.SUSPENDERS_HUBS_FILE;
		else process.env.SUSPENDERS_HUBS_FILE = snap.hubs;
		if (snap.desktop === undefined)
			delete process.env.SUSPENDERS_HUB_DESKTOP_TOKEN;
		else process.env.SUSPENDERS_HUB_DESKTOP_TOKEN = snap.desktop;
	};

	test.describe("retireLaneKey", () => {
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

		test("W615: hub-minted meta revokes at the meta front with the hub credential", async () => {
			const fleet = newFleet();
			writeFileSync(
				laneKeyMetaPath(fleet, "autow123"),
				JSON.stringify({
					key_id: "hubkey123456",
					front: "http://hub:4101",
					hub: "DESKTOP",
				}),
			);
			writeFileSync(laneSettingsPath(fleet, "autow123"), "{}");
			let captured: { url: string; init: RequestInit } | null = null;
			const stub = (async (url: string | URL, init?: RequestInit) => {
				captured = { url: String(url), init: init ?? {} };
				return new Response(JSON.stringify({ revoked: "hubkey123456" }));
			}) as unknown as typeof fetch;
			const env = withHubTokenEnv();
			const rk = await retireLaneKey({
				fleet,
				sid: "autow123",
				admin: "bksk_local_admin",
				fetchFn: stub,
			});
			restoreHubTokenEnv(env);
			expect(rk.revoked).toBe(true);
			const c = captured as { url: string; init: RequestInit } | null;
			expect(c?.url).toBe("http://hub:4101/v1/admin/keys/hubkey123456/revoke");
			const headers = c?.init.headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer bksk_hubtok");
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
});
