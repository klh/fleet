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
	const path = `/tmp/w468-replica-${Date.now()}-${process.pid}-${Math.random()
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
		const la = a.acquire(null);
		expect(la).not.toBeNull();
		expect(b.acquire(null)).toBeNull();
		la?.release();
		expect(b.acquire(null)).not.toBeNull();
	});

	test("per-team cap isolates the noisy team", () => {
		const { db } = fileDb();
		const s = new Slots(db, { global: 0, perTeam: 1 });
		const ln = s.acquire("noisy");
		expect(ln).not.toBeNull();
		expect(s.acquire("noisy")).toBeNull();
		expect(s.acquire("quiet")).not.toBeNull();
		expect(s.held().teams).toEqual({ noisy: 1, quiet: 1 });
	});

	test("lease reclaim returns a dead holder's slot to the pool", () => {
		let t = 1_000_000;
		const { db } = fileDb();
		const limits = { global: 1, perTeam: 0 };
		const holder = new Slots(db, limits, () => t, 60_000);
		expect(holder.acquire(null)).not.toBeNull();
		t += 61_000;
		const next = new Slots(db, limits, () => t, 60_000);
		expect(next.acquire(null)).not.toBeNull();
		expect(next.held().global).toBe(1);
	});

	test("W1118: a live stream that renews is NEVER swept (per-holder rows)", () => {
		let t = 1_000_000;
		const { db } = fileDb();
		const limits = { global: 1, perTeam: 0 };
		const s = new Slots(db, limits, () => t, 60_000);
		const live = s.acquire(null);
		expect(live).not.toBeNull();
		// the aggregate repro: a live stream left untouched while the sweep
		// ran used to free its slot; per-holder rows + renew keep it exact
		t += 61_000;
		live?.renew();
		t += 1_000;
		expect(s.acquire(null)).toBeNull(); // global=1, the live stream holds it
		expect(s.held().global).toBe(1);
		live?.release();
		expect(s.acquire(null)).not.toBeNull();
	});

	test("W1118: a non-renewing holder ages out as a whole row", () => {
		let t = 2_000_000;
		const { db } = fileDb();
		const limits = { global: 1, perTeam: 0 };
		const s = new Slots(db, limits, () => t, 60_000);
		const stale = s.acquire(null);
		expect(stale).not.toBeNull();
		t += 61_000; // no renew — the holder is dead
		expect(s.acquire(null)).not.toBeNull(); // sweep freed the slot
		expect(s.held().global).toBe(1);
		stale?.release(); // late release is a no-op on swept rows
		expect(s.held().global).toBe(1);
	});

	test("W1118: a quiet stream holds past leaseMs via hold() — bounded when holds stop", () => {
		let t = 3_000_000;
		const { db } = fileDb();
		const limits = { global: 1, perTeam: 0 };
		const s = new Slots(db, limits, () => t, 60_000);
		const quiet = s.acquire(null);
		expect(quiet).not.toBeNull();
		t += 61_000; // past the base lease with ZERO chunks (the W1106 canary)
		quiet?.hold(60_000); // the middleware heartbeat move: deadline re-arms
		t += 5_000;
		expect(s.acquire(null)).toBeNull(); // quiet stream still holds the slot
		expect(s.held().global).toBe(1);
		t += 120_000; // holds stop (crash) — the deadline ages out
		expect(s.acquire(null)).not.toBeNull(); // sweep reclaimed it
		expect(s.held().global).toBe(1);
	});

	test("W1118 #55606: one sweep reclaims the stale holder, never the renewing one", () => {
		let t = 4_000_000;
		const { db } = fileDb();
		const limits = { global: 3, perTeam: 0 };
		const s = new Slots(db, limits, () => t, 60_000);
		const live = s.acquire(null);
		const stale = s.acquire(null);
		expect(live).not.toBeNull();
		expect(stale).not.toBeNull();
		t += 30_000; // the live heartbeat fires mid-flight (every leaseMs/2)
		live?.renew(); // deadline 4_090_000 — stale stays at 4_060_000
		t += 31_000; // past the stale row's deadline, inside live's renewed one
		const fresh = s.acquire(null); // the ONE sweep: stale dies, live survives
		expect(fresh).not.toBeNull();
		expect(s.held().global).toBe(2);
		expect(s.acquire(null)).not.toBeNull(); // global=3 admits the third
		expect(s.held().global).toBe(3);
	});

	test("W1118 #55798: a failed release DELETE is retried at the next release call", () => {
		const t = 5_000_000;
		const { db } = fileDb();
		const s = new Slots(db, { global: 1, perTeam: 0 }, () => t, 60_000);
		const lease = s.acquire(null);
		expect(lease).not.toBeNull();
		// fault injection: close the db so BEGIN IMMEDIATE throws
		db.close();
		expect(() => lease?.release()).not.toThrow(); // surfaced, not thrown
		expect(() => lease?.release()).not.toThrow(); // retry path also safe
	});
	test("W1118: separate WAL connections cannot both take the last slot", () => {
		const { path } = fileDb();
		const limits = { global: 1, perTeam: 0 };
		const open = (): Database => {
			const d = new Database(path);
			d.exec("PRAGMA busy_timeout = 5000");
			return d;
		};
		const a = new Slots(open(), limits);
		const b = new Slots(open(), limits);
		const la = a.acquire(null);
		expect(la).not.toBeNull();
		expect(b.acquire(null)).toBeNull();
		la?.release();
		expect(b.acquire(null)).not.toBeNull();
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
