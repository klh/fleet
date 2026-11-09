// test/lane-key-cli.e2e.ts — W2885: `coord lane-key mint-file/revoke/list`
// against a fake hub (serveStub standing in for buckle's /v1/admin/keys).
// Covers the acceptance bar: 0600 atomic write, TTL + scope honored, the
// revocation receipt, no key material on stdout/stderr, and fail-closed
// behavior (unknown hub, missing credential, local-write failure).
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCliAsync, scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

const COORD_BIN = join(import.meta.dir, "../hooks/bin/coord.ts");
const HUB = "fixturehub";
const ADMIN_TOKEN = "admin-fixture-token";

type FakeKeyRow = {
	name: string;
	scopes: string[];
	expires_at: number;
	revoked_at: number | null;
};

test.describe("@unit W2885 — coord lane-key against a fake hub", () => {
	const world = scratchWorld({ prefix: "fleet-lane-key-" });
	const keys = new Map<string, FakeKeyRow>();
	const hub = serveStub((req, body) => {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/v1/admin/keys") {
			const id = randomBytes(6).toString("hex");
			const scopes = Array.isArray(body?.scopes)
				? (body?.scopes as string[])
				: [];
			const ttlS =
				typeof body?.expires_in_s === "number" ? body.expires_in_s : 86400;
			const row: FakeKeyRow = {
				name: String(body?.name ?? ""),
				scopes,
				expires_at: Date.now() + ttlS * 1000,
				revoked_at: null,
			};
			keys.set(id, row);
			return Response.json({
				key_id: id,
				key: `bksk_fixture_${id}`,
				name: row.name,
				scopes: row.scopes,
				expires_at: row.expires_at,
			});
		}
		if (req.method === "GET" && url.pathname === "/v1/admin/keys") {
			return Response.json({
				keys: [...keys.entries()].map(([key_id, k]) => ({
					key_id,
					name: k.name,
					scopes: k.scopes.join(" "),
					expires_at: k.expires_at,
					revoked_at: k.revoked_at,
				})),
			});
		}
		const revoke = /^\/v1\/admin\/keys\/([0-9a-f]+)\/revoke$/.exec(
			url.pathname,
		);
		if (req.method === "POST" && revoke?.[1]) {
			const row = keys.get(revoke[1]);
			if (!row || row.revoked_at !== null)
				return new Response("conflict", { status: 409 });
			row.revoked_at = Date.now();
			return Response.json({ revoked: true });
		}
		return new Response("not found", { status: 404 });
	});
	const stackPath = join(world.home, "stack.json");
	Bun.write(
		stackPath,
		JSON.stringify({
			version: "v-fixture-w2885",
			hubs: { [HUB]: { host: "127.0.0.1", url: hub.url } },
		}),
	);
	// world.env pins HOME to the scratch dir — a real ~/.config/klh/settings.json
	// on the host machine fires unrelated env-knob deprecation warnings
	// (inherited from this very test process's own env) onto the child's
	// stderr, poisoning the "no stray output" assertions below.
	const env = {
		...world.env,
		KLH_STACK: stackPath,
		SUSPENDERS_HUB_FIXTUREHUB_TOKEN: ADMIN_TOKEN,
	};

	test.afterAll(() => {
		hub.close();
		world.clean();
	});

	test("mint-file: 0600 atomic write, TTL + scope honored, only the id on stdout", async () => {
		const path = join(world.home, "lane-key.json");
		const p = await runCliAsync(
			COORD_BIN,
			[
				"lane-key",
				"mint-file",
				"w2885-mint-test",
				path,
				"--hub",
				HUB,
				"--ttl",
				"300",
				"--scope",
				"buckle:proxy:WRITE_,buckle:store:READ_",
			],
			{ env },
		);
		expect(p.err, p.err).toBe("");
		expect(p.code).toBe(0);
		const id = p.out.trim();
		expect(id).toMatch(/^[0-9a-f]+$/);
		expect(p.out).not.toContain("bksk_");
		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);
		const file = JSON.parse(readFileSync(path, "utf8"));
		expect(file.key_id).toBe(id);
		expect(file.key).toContain("bksk_");
		expect(file.scopes).toEqual(["buckle:proxy:WRITE_", "buckle:store:READ_"]);
		expect(file.expires_at - file.minted_at).toBeGreaterThanOrEqual(299_000);
		expect(file.expires_at - file.minted_at).toBeLessThanOrEqual(301_000);
	});

	test("list: id/name/scopes/expiry only, never the key material", async () => {
		const p = await runCliAsync(
			COORD_BIN,
			["lane-key", "list", "--hub", HUB, "--json"],
			{ env },
		);
		expect(p.err, p.err).toBe("");
		expect(p.code).toBe(0);
		expect(p.out).not.toContain("bksk_");
		const rows = JSON.parse(p.out) as Array<{
			keyId: string;
			name: string;
			scopes: string[];
		}>;
		const mine = rows.find((r) => r.name === "w2885-mint-test");
		expect(mine?.scopes).toEqual(["buckle:proxy:WRITE_", "buckle:store:READ_"]);
	});

	test("revoke: receipt captured, idempotent re-revoke fails closed (never a crash)", async () => {
		const key = [...keys.keys()].find(
			(k) => keys.get(k)?.name === "w2885-mint-test",
		);
		expect(key, "fixture row must exist").toBeTruthy();
		const once = await runCliAsync(
			COORD_BIN,
			["lane-key", "revoke", key as string, "--hub", HUB],
			{ env },
		);
		expect(once.code).toBe(0);
		expect(JSON.parse(once.out)).toEqual({ key_id: key, revoked: true });
		const twice = await runCliAsync(
			COORD_BIN,
			["lane-key", "revoke", key as string, "--hub", HUB],
			{ env },
		);
		expect(twice.code).toBe(1);
		expect(JSON.parse(twice.out)).toEqual({ key_id: key, revoked: false });
	});

	test("fail closed: unknown hub label refuses before any mint, no key material anywhere", async () => {
		const p = await runCliAsync(
			COORD_BIN,
			[
				"lane-key",
				"mint-file",
				"w2885-no-hub",
				join(world.home, "unused.json"),
				"--hub",
				"does-not-exist-w2885",
			],
			{ env },
		);
		expect(p.code).toBe(1);
		expect(p.err).toContain("no buckle front for hub");
		expect(p.out).toBe("");
	});

	test("fail closed: hub resolves but no credential configured", async () => {
		const p = await runCliAsync(
			COORD_BIN,
			[
				"lane-key",
				"mint-file",
				"w2885-no-cred",
				join(world.home, "unused2.json"),
				"--hub",
				HUB,
			],
			{ env: { KLH_STACK: stackPath } },
		);
		expect(p.code).toBe(1);
		expect(p.err).toContain("no credential for hub");
	});

	test("fail closed: a local-write failure revokes the just-minted key (no orphan)", async () => {
		const before = keys.size;
		const p = await runCliAsync(
			COORD_BIN,
			["lane-key", "mint-file", "w2885-write-fail", world.home, "--hub", HUB],
			{ env },
		);
		expect(p.code).toBe(1);
		expect(keys.size).toBe(before + 1);
		const row = [...keys.values()].find((k) => k.name === "w2885-write-fail");
		expect(row?.revoked_at).not.toBeNull();
	});
});
