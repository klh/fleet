// W1072.3 behavioral reclaim-liveness contract — every liveness anchor ages
// out. Pins: the pid identity anchor is start-time bound (a process observed
// on the recorded pid that began after the lane launched is a RECYCLED pid —
// absent evidence, never liveness); orphaned coord subscribe sidecar args are
// never lane evidence; transcript existence is freshness-floored (a stale
// transcript is not liveness); a dead claim converges to release through
// aging alone (recycled pid + cold heartbeat + open session row → 3 dead
// strikes → release), while a fresh transcript still outranks a recycled pid.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	laneProcessIdentity,
	laneVerdict,
	type ProcessInspector,
	transcriptAlive,
	transcriptsAliveBatch,
} from "../hooks/lib/lanes/lane-liveness.ts";
import { observeReclaim, probeClaim } from "../hooks/lib/lanes/reclaim-liveness.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
test.describe("@unit", () => {

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

test.afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const roster =
	(stdout: string, exitCode = 0): ProcessInspector =>
	() => ({ stdout, exitCode });

test("W1072.3 recycled pid: a process started after the lane launched is not liveness evidence", () => {
	const launchedAt = Date.now() - 60_000;
	const lane = { sid: "autow562", item: "W562", pid: 562, launchedAt };
	// the recorded process: up since launch, sid in args → alive
	expect(
		laneProcessIdentity(lane, roster("562 00:01:00 claude -p autow562")),
	).toBe(true);
	// started 9s after launch — inside the grace → still the lane
	expect(
		laneProcessIdentity(lane, roster("562 00:00:51 claude -p autow562")),
	).toBe(true);
	// started 11s after launch → recycled → absent evidence
	expect(
		laneProcessIdentity(lane, roster("562 00:00:49 claude -p autow562")),
	).toBe(false);
	// long-form etime parses the same way; a process started BEFORE the launch
	// stamp stays legacy ambiguity (re-stamped rows must not read dead — W51)
	expect(
		laneProcessIdentity(lane, roster("562 1-02:03:04 claude -p autow562")),
	).toBe(true);
	// no launchedAt anchor → no recycle bound (legacy registry rows)
	expect(
		laneProcessIdentity(
			{ sid: "autow562", item: "W562", pid: 562 },
			roster("562 00:00:05 claude -p autow562"),
		),
	).toBe(true);
	// legacy roster (no etime column) reads unchanged
	expect(laneProcessIdentity(lane, roster("562 claude -p autow562"))).toBe(
		true,
	);
});

test("W1072.3 orphaned coord subscribe sidecar args are not lane evidence", () => {
	const lane = { sid: "autow562", item: "W562", pid: 562 };
	// bun + coord.ts is not a harness executable: the sid in a subscribe
	// sidecar's argv vouches for the sidecar, never for the lane harness
	expect(
		laneProcessIdentity(
			lane,
			roster("562 bun /opt/hs/bin/coord.ts subscribe --as autow562"),
		),
	).toBe(false);
});

test("W1072.3 stale transcript existence is not liveness — the 15-min floor bounds it", () => {
	const home = `${import.meta.dir}/.tmp-rlc-${Date.now()}`;
	directories.push(home);
	mkdirSync(`${home}/.claude/projects/p`, { recursive: true });
	const realHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const path = `${home}/.claude/projects/p/session-autold-777.jsonl`;
		writeFileSync(path, "{}");
		const stale = (Date.now() - 3_600_000) / 1000;
		utimesSync(path, stale, stale); // 1h old — existence without freshness
		expect(transcriptAlive("autold-777")).toBe(false);
		// the batch form agrees: existence alone is not liveness
		expect(transcriptsAliveBatch(["autold-777"]).get("autold-777")).toBe(false);
		// a foreign-host lane's ONLY term is transcript freshness → unknown
		expect(
			laneVerdict({
				sid: "autold-777",
				item: "W1",
				pid: 999999999,
				host: "elsewhere",
			}),
		).toBe("unknown");
	} finally {
		process.env.HOME = realHome;
	}
});

test("W1072.3 wedge ages out: recycled pid + cold hb + open session row → dead ×3 → release", () => {
	const s = fixture();
	const now = Date.now();
	s.run(
		"INSERT INTO sessions (sid, project, role, parent_sid, started_at, hb, state) VALUES ('autowed-99', 'p', 'lane', NULL, ?, ?, 'RUNNING')",
		now,
		now - 50 * 60_000,
	);
	// the W1072 shape: registry row on a pid whose current process started
	// days after the lane launched (recycled), heartbeat cold for 50 minutes,
	// session row still open, no fresh transcript — the claim must converge
	const lane = {
		sid: "autowed-99",
		item: "W1",
		pid: 42424242,
		host: HOST,
		launchedAt: now - 72 * 3_600_000,
	};
	const recycled: ProcessInspector = roster(
		"  42424242 00:00:02 claude -p autowed-99",
	);
	const obs = {
		id: "W1",
		owner: "autowed-99",
		revision: 1,
		lane,
		inspect: recycled,
	};
	const first = observeReclaim(s, "p", obs);
	expect(first.verdict).toBe("dead");
	expect(first.why).toContain("strike 1/3");
	expect(observeReclaim(s, "p", obs).why).toContain("strike 2/3");
	const third = observeReclaim(s, "p", obs);
	expect(third.action).toBe("release");
	expect(third.why).toContain("dead ×3 consecutive passes");
});

test("W1072.3 fresh transcript outranks a recycled pid — alive, never over-reaped", () => {
	const home = `${import.meta.dir}/.tmp-rlc-${Date.now()}`;
	directories.push(home);
	mkdirSync(`${home}/.claude/projects/p`, { recursive: true });
	const realHome = process.env.HOME;
	process.env.HOME = home;
	try {
		writeFileSync(`${home}/.claude/projects/p/session-autowed-98.jsonl`, "{}");
		const s = fixture();
		const lane = {
			sid: "autowed-98",
			item: "W1",
			pid: 42424241,
			host: HOST,
			launchedAt: Date.now() - 72 * 3_600_000,
		};
		const recycled = roster("  42424241 00:00:02 claude -p autowed-98");
		expect(
			probeClaim(s, "p", {
				id: "W1",
				owner: "autowed-98",
				revision: 1,
				lane,
				inspect: recycled,
			}).verdict,
		).toBe("alive");
	} finally {
		process.env.HOME = realHome;
	}
});

test("W1072.3 contract rides the CLI shape: take → recycled-pid lane file → reclaim all converges", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-rlc-"));
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
	const id = call("add", "wedge").stdout.toString().match(/W\d+/)?.[0] ?? "";
	expect(id).toBe("W1");
	expect(call("take", id, "--as", "autowed-97").exitCode).toBe(0);
	// registry row on a recycled pid: the recorded process started days before
	// the current process on that pid; no session row, no transcript
	mkdirSync(join(root, ".fleet"), { recursive: true });
	writeFileSync(
		join(root, ".fleet", "lanes.json"),
		JSON.stringify([
			{
				sid: "autowed-97",
				item: "W1",
				pid: 999999999,
				host: hostname(),
				launchedAt: Date.now() - 72 * 3_600_000,
			},
		]),
	);
	expect(call("reclaim", "all").stdout.toString()).toContain("strike 1/3");
	expect(call("reclaim", "all").stdout.toString()).toContain("strike 2/3");
	const final = call("reclaim", "all").stdout.toString();
	expect(final).toContain("reclaimed → READY");
	expect(final).toContain("dead ×3");
	expect(JSON.parse(call("show", id, "--json").stdout.toString()).state).toBe(
		"READY",
	);
});

});
