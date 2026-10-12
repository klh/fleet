// test/gov-replica-budgets.test.ts — W468 acceptance: concurrent requests
// through two processes cannot multiply a team's quota (the DB row is the
// single authority and admission is one BEGIN IMMEDIATE transaction), and
// the slot pools bound simultaneous generations, with lease reclaim so a
// dead holder cannot leak the pool.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Budgets } from "../src/gov/budgets.ts";
import { Slots, slotsFromEnv } from "../src/gov/slots.ts";
import { applyGovernanceSchema } from "../src/gov/schema.ts";

function fileDb(): { db: Database; path: string } {
	const path = `/tmp/w468-replica-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}.db`;
	const db = new Database(path, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	applyGovernanceSchema(db);
	return { db, path };
}

/** Spawn a worker process and read its accept count. */
async function runWorker(args: string[]): Promise<{ ok: number }> {
	const worker = new URL("replica-worker.ts", import.meta.url).pathname;
	const proc = Bun.spawn({
		cmd: ["bun", worker, ...args],
		stdout: "pipe",
		stderr: "inherit",
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	const line = out.trim().split("\n").pop() ?? "";
	return JSON.parse(line) as { ok: number };
}

describe("W468 replica-safe budgets", () => {
	test("two processes, one authority: 10 attempts against rpm=6 accept exactly 6", async () => {
		const { path } = fileDb();
		const [a, b] = await Promise.all([
			runWorker([path, "5", "k1", "ops", "6", "null"]),
			runWorker([path, "5", "k1", "ops", "6", "null"]),
		]);
		expect(a.ok + b.ok).toBe(6);
		const row = new Database(path)
			.query("SELECT used_rpm FROM budget_state WHERE key_id = 'k1'")
			.get() as { used_rpm: number };
		expect(row.used_rpm).toBe(6);
	});

	test("two processes, one team: the team ceiling binds across keys", async () => {
		const { path } = fileDb();
		const [a, b] = await Promise.all([
			runWorker([path, "3", "kA", "ops", "null", "3"]),
			runWorker([path, "3", "kB", "ops", "null", "3"]),
		]);
		expect(a.ok + b.ok).toBe(3);
		const row = new Database(path)
			.query("SELECT used_rpm FROM team_budget_state WHERE team_id = 'ops'")
			.get() as { used_rpm: number };
		expect(row.used_rpm).toBe(3);
	});

	test("denial leaves no residue: a rolled-back reservation never lands", () => {
		const { db } = fileDb();
		const b = new Budgets(db);
		expect(b.check("k1", { rpm: 1, tpm: null }, 0).ok).toBe(true);
		expect(b.check("k1", { rpm: 1, tpm: null }, 0).ok).toBe(false);
		const row = db
			.query("SELECT used_rpm FROM budget_state WHERE key_id = 'k1'")
			.get() as { used_rpm: number };
		expect(row.used_rpm).toBe(1);
	});
});

describe("W468 admission-control slots", () => {
	test("two replicas cannot both take the last global slot", () => {
		const { db } = fileDb();
		const limits = { global: 1, perTeam: 0 };
		const a = new Slots(db, limits);
		const b = new Slots(db, limits);
		expect(a.acquire(null)).toBe(true);
		expect(b.acquire(null)).toBe(false);
		a.release(null);
		expect(b.acquire(null)).toBe(true);
	});

	test("per-team cap isolates the noisy team", () => {
		const { db } = fileDb();
		const s = new Slots(db, { global: 0, perTeam: 1 });
		expect(s.acquire("noisy")).toBe(true);
		expect(s.acquire("noisy")).toBe(false);
		expect(s.acquire("quiet")).toBe(true);
		expect(s.held().teams).toEqual({ noisy: 1, quiet: 1 });
	});

	test("lease reclaim returns a dead holder's slot to the pool", () => {
		let t = 1_000_000;
		const { db } = fileDb();
		const limits = { global: 1, perTeam: 0 };
		const holder = new Slots(db, limits, () => t, 60_000);
		expect(holder.acquire(null)).toBe(true);
		t += 61_000;
		const next = new Slots(db, limits, () => t, 60_000);
		expect(next.acquire(null)).toBe(true);
		expect(next.held().global).toBe(1);
	});

	test("slotsFromEnv: defaults shape a bare install, 0 disables", () => {
		expect(slotsFromEnv({})).toEqual({ global: 64, perTeam: 16 });
		expect(slotsFromEnv({ BUCKLE_SLOTS_GLOBAL: "0" })).toEqual({
			global: 0,
			perTeam: 16,
		});
		expect(slotsFromEnv({ BUCKLE_SLOTS_PER_TEAM: "garbage" })).toEqual({
			global: 64,
			perTeam: 16,
		});
	});
});
