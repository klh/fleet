// test/hub-admin.test.ts — W231 hub admin plane: masked token inventory +
// GUI-driven issue/revoke with the admin_audit trail, masked provider-key
// inventory, federation status lens, and the /console/hub route module
// (store injected — the route module itself never opens the live db).
// HOME is a temp dir set BEFORE the dynamic imports — govdb binds REG at
// module load (the auth.test.ts pattern).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_HOME = process.env.HOME;
const HOME = mkdtempSync(join(tmpdir(), "suspenders-hub-admin-home-"));
process.env.HOME = HOME;
process.env.BUCKLE_SECRETS_HOME = join(HOME, "secrets");
// the board's write perimeter: tests present the header (writeToken()
// materializes the token file on first ensure)
process.env.SUSPENDERS_WRITE_TOKEN_FILE = join(HOME, "write-token");

afterAll(() => {
	process.env.HOME = REAL_HOME;
	delete process.env.BUCKLE_SECRETS_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

const govdb = await import("../hooks/lib/govdb.ts");
const { writeToken } = await import("../hooks/lib/host-guard.ts");
const hubTokens = await import("../hooks/lib/hub-tokens.ts");
const pkeys = await import("../hooks/lib/hub-provider-keys.ts");
const fed = await import("../hooks/lib/hub-federation-status.ts");
const routes = await import("../hooks/board/routes-hub-admin.ts");

const store = govdb.openStore();

const req = (path: string, method = "GET", body?: unknown): Request =>
	new Request(`http://127.0.0.1:7799${path}`, {
		method,
		...(body === undefined
			? { headers: { host: "127.0.0.1:7799" } }
			: {
					headers: {
						host: "127.0.0.1:7799",
						"content-type": "application/json",
						"x-klh-write-token": writeToken() ?? "",
					},
					body: JSON.stringify(body),
				}),
	});

const call = async (
	path: string,
	method = "GET",
	body?: unknown,
): Promise<Response> => {
	const url = new URL(`http://127.0.0.1:7799${path}`);
	const r = await routes.handleHubAdmin(req(path, method, body), url, store);
	expect(r).not.toBeNull();
	return r as Response;
};

describe("hub-tokens (masked inventory + audited issue/revoke)", () => {
	test("issue mints raw material once + lands audit rows", async () => {
		const pair = hubTokens.issueHubToken(
			store,
			{
				actor: "lane-w231",
				team: "fleet",
				token_class: "app-role",
				scopes: ["buckle:admin"],
				label: "w231 test",
				accessTtlMs: 86_400_000,
			},
			"tester",
		);
		expect(pair.access.startsWith("")).toBe(true);
		expect(pair.access.length).toBeGreaterThan(40);
		// raw material never lands in the masked listing
		const rows = hubTokens.listTokens(store);
		const mine = rows.find((r) => r.actor === "lane-w231");
		expect(mine).toBeDefined();
		expect(mine?.state).toBe("active");
		expect(mine?.key_id.length).toBeLessThanOrEqual(8);
		expect(JSON.stringify(rows)).not.toContain(pair.access);
		// admin_audit carries the issue (the who/when trail)
		const audit = store
			.query(
				"SELECT actor, action, target, detail FROM admin_audit ORDER BY id DESC LIMIT 2",
			)
			.all() as {
			actor: string;
			action: string;
			target: string;
			detail: string;
		}[];
		expect(audit.some((a) => a.action === "hub.token.issue")).toBe(true);
		// auth_events carry the identity-plane trail
		const events = store
			.query(
				"SELECT event FROM auth_events WHERE actor = 'lane-w231' ORDER BY ts DESC",
			)
			.all() as { event: string }[];
		expect(events.some((e) => e.event === "issued")).toBe(true);
	});

	test("list decodes class from the name JSON and masks ids", () => {
		const rows = hubTokens.listTokens(store, { actor: "lane-w231" });
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.class).toBe("app-role");
		expect(rows[0]?.label).toBe("w231 test");
		expect(rows[0]?.scopes).toEqual(["buckle:admin"]);
	});

	test("revoke by actor kills the pair + audits twice", async () => {
		const _pair = hubTokens.issueHubToken(
			store,
			{
				actor: "lane-revoke",
				token_class: "delegated",
				scopes: ["buckle:proxy:WRITE_"],
			},
			"tester",
		);
		const out = hubTokens.revokeHubToken(
			store,
			{ actor: "lane-revoke" },
			"tester",
		);
		// ≥: bun:sqlite changes over-counts under the transaction (the auth
		// suite's own convention is GreaterThanOrEqual for this reason)
		expect(out.changes).toBeGreaterThanOrEqual(2); // access + refresh rows
		const rows = hubTokens.listTokens(store, { actor: "lane-revoke" });
		expect(rows.every((r) => r.state === "revoked")).toBe(true);
		const audit = store
			.query("SELECT action FROM admin_audit ORDER BY id DESC LIMIT 3")
			.all() as { action: string }[];
		expect(audit.map((a) => a.action)).toContain("keys.revoke");
		expect(audit.map((a) => a.action)).toContain("hub.token.revoke");
	});

	test("list includes expired + revoked in the trail", () => {
		const rows = hubTokens.listTokens(store);
		const states = new Set(rows.map((r) => r.state));
		expect(states.has("revoked")).toBe(true);
		expect(hubTokens.listTokens(store, { limit: 1 })).toHaveLength(1);
	});
});

describe("hub-provider-keys (masked inventory)", () => {
	test("maskSecret never shows more than a 4-char tail", () => {
		expect(pkeys.maskSecret("sk-ant-0123456789abcdef")).toBe("••••cdef"); // scrub:allow
		expect(pkeys.maskSecret("short")).toBe("••••");
	});

	test("parseEnvBody skips comments, quotes, malformed lines", () => {
		const rows = pkeys.parseEnvBody(
			'# comment\nANTHROPIC_API_KEY="sk-value"\nBAD LINE\nEMPTY=\nZ_AI_API_KEY=plain123456\n',
		);
		expect(rows).toEqual([
			{ name: "ANTHROPIC_API_KEY", value: "sk-value" },
			{ name: "Z_AI_API_KEY", value: "plain123456" },
		]);
	});

	test("inventory reads the fixture home + process env, masked", () => {
		const home = join(HOME, ".claude", "local-llm");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "belt.env"),
			"ANTHROPIC_API_KEY=sk-ant-0123456789abcdef\nBUCKLE_ADMIN_KEY=bksk_admin_material\n", // scrub:allow
		);
		const rows = pkeys.providerKeyInventory({
			home,
			files: ["belt.env"],
			processEnv: { Z_AI_API_KEY: "example-cdef" },
		});
		const flat = JSON.stringify(rows);
		// only *_API_KEY names — the admin plane's own keys stay out
		expect(flat).not.toContain("BUCKLE_ADMIN_KEY");
		expect(flat).not.toContain("sk-ant-0123456789abcdef"); // scrub:allow
		expect(flat).not.toContain("example-cdef");
		expect(rows).toEqual([
			{
				name: "ANTHROPIC_API_KEY",
				source: "belt.env",
				set: true,
				masked: "••••cdef",
			},
			{
				name: "Z_AI_API_KEY",
				source: "process env",
				set: true,
				masked: "••••cdef",
			},
		]);
	});
});

describe("hub-federation-status", () => {
	test("no peer edges = honest idle", () => {
		const s = fed.federationStatus({ labels: [], env: {} });
		expect(s.idle).toBe(true);
		expect(s.peers).toEqual([]);
	});

	test("peer with a last-known store reports version + state", async () => {
		const home = join(HOME, ".claude", "local-llm");
		mkdirSync(home, { recursive: true });
		const peersLib = await import("../hooks/lib/federation-peers.ts");
		const p = peersLib.peerLastKnownPath("nas", { HOME });
		writeFileSync(
			p,
			JSON.stringify({
				pulled_at: "2026-10-11T00:00:00.000Z",
				hub_label: "nas",
				url: "http://nas:4101",
				via: "env",
				manifest: { version: "v9", rules: 3, cr_queue: 1 },
			}),
		);
		const s = fed.federationStatus({ labels: ["nas"], env: { HOME } });
		expect(s.idle).toBe(false);
		expect(s.peers[0]?.label).toBe("nas");
		expect(s.peers[0]?.state).toBe("live"); // mtime is now
		expect(s.peers[0]?.version).toBe("v9");
		expect(s.peers[0]?.rules).toBe(3);
	});
});

describe("routes-hub-admin", () => {
	test("unrelated path returns null (falls through the board chain)", async () => {
		expect(
			await routes.handleHubAdmin(
				req("/api/other"),
				new URL("http://x/api/other"),
				store,
			),
		).toBeNull();
	});

	test("console page serves the Lit mount", async () => {
		const r = await call("/console/hub");
		expect(r.status).toBe(200);
		const html = await r.text();
		expect(html).toContain("klh-hub-admin");
		expect(html).toContain("/vendor/klh-hub-admin.js");
	});

	test("GET tokens → masked rows", async () => {
		const r = await call("/api/hub/tokens");
		const d = (await r.json()) as { ok: boolean; tokens: { key_id: string }[] };
		expect(d.ok).toBe(true);
		expect(Array.isArray(d.tokens)).toBe(true);
		expect(d.tokens.every((t) => t.key_id.length <= 8)).toBe(true);
	});

	test("POST issue → 201 + raw once; revoke kills it", async () => {
		const r = await call("/api/hub/tokens", "POST", {
			actor: "gui-lane",
			token_class: "app-role",
			scopes: "buckle:admin",
			access_ttl_days: 7,
		});
		expect(r.status).toBe(201);
		const d = (await r.json()) as {
			token: { jti: string; access: string };
		};
		expect(d.token.access.length).toBeGreaterThan(40);
		const list = (await (await call("/api/hub/tokens")).json()) as {
			tokens: { key_id: string }[];
		};
		expect(JSON.stringify(list)).not.toContain(d.token.access);
		const rev = await call("/api/hub/tokens/revoke", "POST", {
			actor: "gui-lane",
		});
		const rd = (await rev.json()) as { ok: boolean; changes: number };
		expect(rd.changes).toBeGreaterThanOrEqual(2);
	});

	test("issue without actor → 400", async () => {
		const r = await call("/api/hub/tokens", "POST", {
			token_class: "app-role",
		});
		expect(r.status).toBe(400);
	});

	test("revoke without selector → 400", async () => {
		const r = await call("/api/hub/tokens/revoke", "POST", {});
		expect(r.status).toBe(400);
	});

	test("provider-keys payload is masked + honest about sources", async () => {
		const r = await call("/api/hub/provider-keys");
		const d = (await r.json()) as {
			home: string;
			files: string[];
			keys: { masked: string | null }[];
		};
		expect(d.ok).toBe(true);
		expect(typeof d.home).toBe("string");
		expect(Array.isArray(d.files)).toBe(true);
		for (const k of d.keys) {
			expect(k.masked === null || k.masked.startsWith("••••")).toBe(true);
		}
	});

	test("federation payload rides the status lens", async () => {
		const r = await call("/api/hub/federation");
		const d = (await r.json()) as {
			ok: boolean;
			idle: boolean;
			peers: unknown[];
		};
		expect(d.ok).toBe(true);
		expect(Array.isArray(d.peers)).toBe(true);
	});
});
