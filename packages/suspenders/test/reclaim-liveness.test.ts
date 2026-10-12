// W610 regression pins — reclaim-all liveness parity. The bulk reaper shares
// the lane-liveness tri-state (registry process identity + claimant
// transcript + governor heartbeat) instead of transcript mtime alone;
// unknown never releases, death needs STRIKES_TO_RECLAIM consecutive dead
// passes (fact-counted), and `work extend` pauses the reaper for a
// known-long op.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	observeReclaim,
	parseDuration,
	probeClaim,
	setReclaimHold,
	STRIKES_TO_RECLAIM,
} from "../hooks/lib/reclaim-liveness.ts";
import { laneVerdict } from "../hooks/lib/lane-liveness.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const databases: Database[] = [];
const directories: string[] = [];
const HOST = hostname();

function fixture(): GovernorStore {
	const db = new Database(":memory:");
	databases.push(db);
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	return {
		local: true,
		query: (sql) => db.query(sql),
		run: (sql, ...params) => db.run(sql, ...(params as never[])),
		transaction: <T>(fn: () => T) => db.transaction(fn),
		close: () => db.close(),
	};
}

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("parseDuration: 45m/90s/2h parse; junk and >24h refuse", () => {
	expect(parseDuration("45m")).toBe(2_700_000);
	expect(parseDuration("90s")).toBe(90_000);
	expect(parseDuration("2h")).toBe(7_200_000);
	expect(parseDuration("24h")).toBe(86_400_000);
	expect(parseDuration("25h")).toBe(null);
	expect(parseDuration("45")).toBe(null);
	expect(parseDuration("m5")).toBe(null);
});

test("laneVerdict tri-state: dead pid + empty home = dead; foreign host without transcript = unknown; fresh transcript = alive", () => {
	const home = `${import.meta.dir}/.tmp-rcm-${Date.now()}`;
	directories.push(home);
	mkdirSync(`${home}/.claude/projects/p`, { recursive: true });
	const realHome = process.env.HOME;
	process.env.HOME = home;
	try {
		// recorded pid observed gone (ps roster) + no transcript → dead
		expect(
			laneVerdict({ sid: "autotd", item: "W9", pid: 999999999, host: HOST }),
		).toBe("dead");
		// foreign host carries no process-table trust; no transcript evidence
		// → unknown, never dead
		expect(
			laneVerdict({
				sid: "autofh",
				item: "W9",
				pid: 999999999,
				host: "elsewhere",
			}),
		).toBe("unknown");
		// fresh claimant transcript is positive liveness — even foreign
		writeFileSync(`${home}/.claude/projects/p/session-autofh.jsonl`, "{}");
		expect(
			laneVerdict({
				sid: "autofh",
				item: "W9",
				pid: 999999999,
				host: "elsewhere",
			}),
		).toBe("alive");
	} finally {
		process.env.HOME = realHome;
	}
});

test("unknown never releases — no lane entry, no heartbeat, pass after pass", () => {
	const s = fixture();
	const obs = { id: "W1", owner: "o1", revision: 1 };
	for (let i = 0; i < 5; i++) {
		const d = observeReclaim(s, "p", obs);
		expect(d.verdict).toBe("unknown");
		expect(d.action).toBe("hold");
		expect(d.strikes).toBe(0);
	}
	// unknown passes never seed a strike fact either
	expect(s.query("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 0 });
});

test("dead ×3 consecutive passes release; a heartbeat live pass resets the chain", () => {
	const s = fixture();
	const lane = { sid: "o1", item: "W1", pid: 999999999, host: HOST };
	const obs = { id: "W1", owner: "o1", revision: 1, lane };
	expect(observeReclaim(s, "p", obs).why).toContain("strike 1/3");
	expect(observeReclaim(s, "p", obs).why).toContain("strike 2/3");
	const third = observeReclaim(s, "p", obs);
	expect(third.action).toBe("release");
	expect(third.strikes).toBe(STRIKES_TO_RECLAIM);
	// a governor heartbeat turns the verdict live and clears the counter
	s.run(
		"INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES ('o1', 'p', 'lane', NULL, ?, ?, 'RUNNING')",
		Date.now(),
		Date.now(),
	);
	const live = observeReclaim(s, "p", obs);
	expect(live.verdict).toBe("alive");
	expect(live.strikes).toBe(0);
	// the heartbeat goes stale → death must repeat from strike 1 afterwards
	s.run(
		"UPDATE sessions SET hb = ? WHERE sid = 'o1'",
		Date.now() - 31 * 60_000,
	);
	expect(observeReclaim(s, "p", obs).why).toContain("strike 1/3");
});

test("a claim change resets the strike chain", () => {
	const s = fixture();
	const lane = { sid: "o1", item: "W1", pid: 999999999, host: HOST };
	expect(
		observeReclaim(s, "p", {
			id: "W1",
			owner: "o1",
			revision: 1,
			lane,
		}).strikes,
	).toBe(1);
	// revision bumped → the counter starts over for the new claim
	expect(
		observeReclaim(s, "p", {
			id: "W1",
			owner: "o1",
			revision: 2,
			lane,
		}).strikes,
	).toBe(1);
	// a different owner likewise
	expect(
		observeReclaim(s, "p", { id: "W1", owner: "o2", revision: 2, lane }).strikes,
	).toBe(1);
});

test("extend lease holds the reaper and keeps the counter clear; expiry falls through", () => {
	const s = fixture();
	const lane = { sid: "o1", item: "W1", pid: 999999999, host: HOST };
	setReclaimHold(s, "p", "W1", Date.now() + 60_000, "o1");
	const held = observeReclaim(s, "p", {
		id: "W1",
		owner: "o1",
		revision: 1,
		lane,
	});
	expect(held.action).toBe("hold");
	expect(held.why).toContain("extend lease");
	expect(held.strikes).toBe(0);
	// an expired lease stops vouching — the claim reads dead, strike 1
	setReclaimHold(s, "p", "W2", Date.now() - 1000, "o1");
	const after = observeReclaim(s, "p", {
		id: "W2",
		owner: "o1",
		revision: 1,
		lane,
	});
	expect(after.holdUntil).toBe(null);
	expect(after.why).toContain("strike 1/3");
});

test("probeClaim is read-only — verdicts without counter writes", () => {
	const s = fixture();
	const lane = { sid: "o1", item: "W1", pid: 999999999, host: HOST };
	expect(
		probeClaim(s, "p", { id: "W1", owner: "o1", revision: 1, lane }).verdict,
	).toBe("dead");
	expect(s.query("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 0 });
});

test("CLI: an evidence-less claim survives reclaim all, pass after pass", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-reclaim-"));
	directories.push(root);
	const call = (...args: string[]) =>
		Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../hooks/bin/work.ts"),
				...args,
			],
			{
				cwd: root,
				env: { ...process.env, HOME: root, GOVERNOR_STORE_URL: "local" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	const id = call("add", "ghost").stdout.toString().match(/W\d+/)?.[0] ?? "";
	expect(call("take", id, "--as", "autod").exitCode).toBe(0);
	// no registry row, no transcript, no session row → unknown → held (the
	// old code released it on pass one)
	expect(call("reclaim", "all").exitCode).toBe(0);
	expect(call("reclaim", "all").exitCode).toBe(0);
	const state = JSON.parse(call("show", id, "--json").stdout.toString())
		.state as string;
	expect(state).toBe("CLAIMED");
	// the listing keeps unknown visible for the operator
	const orphaned = JSON.parse(
		call("orphaned", "--item", id, "--json").stdout.toString(),
	).map((row: { id: string }) => row.id);
	expect(orphaned).toEqual([id]);
});

test("CLI: registry dead pid → extend pause, strikes, release on the third dead pass", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-reclaim2-"));
	directories.push(root);
	const call = (...args: string[]) =>
		Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "../hooks/bin/work.ts"), ...args],
			{
				cwd: root,
				env: { ...process.env, HOME: root, GOVERNOR_STORE_URL: "local" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	const id = call("add", "ghost").stdout.toString().match(/W\d+/)?.[0] ?? "";
	expect(id).toBe("W1");
	expect(call("take", id, "--as", "autod").exitCode).toBe(0);
	// registry row whose recorded pid is gone → the claim reads dead
	mkdirSync(join(root, ".fleet"), { recursive: true });
	writeFileSync(
		join(root, ".fleet", "lanes.json"),
		JSON.stringify([
			{ sid: "autod", item: "W1", pid: 999999999, host: hostname() },
		]),
	);
	expect(call("extend", id, "--for", "1s").exitCode).toBe(0);
	expect(call("reclaim", "all").stdout.toString()).toContain("extend lease");
	Bun.sleepSync(1100); // lease expired — death must repeat from strike 1
	expect(call("reclaim", "all").stdout.toString()).toContain("strike 1/3");
	expect(call("reclaim", "all").stdout.toString()).toContain("strike 2/3");
	const final = call("reclaim", "all").stdout.toString();
	expect(final).toContain("reclaimed → READY");
	expect(final).toContain("dead ×3");
	const after = JSON.parse(call("show", id, "--json").stdout.toString())
		.state as string;
	expect(after).toBe("READY");
});
