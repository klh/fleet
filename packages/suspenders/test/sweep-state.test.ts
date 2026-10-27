// test/sweep-state.test.ts — W1201 doctrine kit: per-source cursor
// (maybe-ran → confirm), bounded failure-notice ring, named budget pause.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSweepNotice,
	confirmCursor,
	confirmedMs,
	NOTICE_KEEP,
	markMaybeRan,
	pauseTask,
	readCursor,
	readPause,
	readPending,
	readSweepNotices,
} from "../hooks/lib/fleet-loop/sweep-state.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "sweep-"));

describe("W1201 sweep cursor", () => {
	test("pending stamp is separate evidence; confirmed advance clears it", () => {
		const dir = tmp();
		const c = join(dir, "cursor.json");
		expect(readCursor(c)).toBeNull();
		expect(readPending(c)).toBeNull();
		// fallback before first confirmed run
		expect(confirmedMs(readCursor(c), 1000)).toBe(1000);
		expect(markMaybeRan(c, "run-1", 500)).toBe(true);
		// B1: the pending stamp NEVER touches the confirmed bookmark
		expect(readCursor(c)).toBeNull();
		expect(confirmedMs(readCursor(c), 1000)).toBe(1000);
		expect(readPending(c)).toEqual({
			state: "maybe-ran",
			runId: "run-1",
			at: 500,
		});
		expect(confirmCursor(c, 5000, "run-1")).toBe(true);
		expect(readCursor(c)).toEqual({
			state: "ok",
			lastMs: 5000,
			runId: "run-1",
		});
		expect(readPending(c)).toBeNull();
		expect(confirmedMs(readCursor(c), 1000)).toBe(5000);
	});

	test("bookmark survives a pending/crash between stamp and confirm", () => {
		const dir = tmp();
		const c = join(dir, "cursor.json");
		expect(confirmCursor(c, 5000, "run-1")).toBe(true);
		// a crashed run: pending stamped, never confirmed
		expect(markMaybeRan(c, "run-2", 6000)).toBe(true);
		// the recovery run still reads the confirmed position
		expect(readCursor(c)).toEqual({
			state: "ok",
			lastMs: 5000,
			runId: "run-1",
		});
		expect(confirmedMs(readCursor(c), 1000)).toBe(5000);
		expect(readPending(c)?.runId).toBe("run-2");
		// the recovery confirm advances AND clears the stale evidence
		expect(confirmCursor(c, 9000, "run-3")).toBe(true);
		expect(readCursor(c)?.lastMs).toBe(9000);
		expect(readPending(c)).toBeNull();
	});

	test("corrupt or invalid cursor reads as absent; legacy maybe-ran row too", () => {
		const dir = tmp();
		const c = join(dir, "cursor.json");
		writeFileSync(c, "not-json{");
		expect(readCursor(c)).toBeNull();
		writeFileSync(c, JSON.stringify({ state: "ok", lastMs: -5, runId: "x" }));
		expect(readCursor(c)).toBeNull();
		// legacy single-file maybe-ran format: no confirmed position inside
		writeFileSync(c, JSON.stringify({ state: "maybe-ran", runId: "x" }));
		expect(readCursor(c)).toBeNull();
	});
});

describe("W1201 failure-notice ring", () => {
	test("append returns the line; ring bounded at NOTICE_KEEP; freshness read", () => {
		const dir = tmp();
		const l1 = appendSweepNotice("task-a", "fail(1) source down", dir);
		expect(l1).toContain("task-a fail(1) source down");
		for (let i = 0; i < NOTICE_KEEP + 5; i++)
			appendSweepNotice("task-b", `overflow ${i}`, dir);
		const all = readSweepNotices(dir, Number.MAX_SAFE_INTEGER);
		expect(all.length).toBe(NOTICE_KEEP);
		// oldest lines evicted, newest retained
		expect(all.join("\n")).not.toContain("task-a fail(1)");
		expect(all.at(-1)).toContain("overflow");
		// default 24h freshness window keeps today's lines
		expect(readSweepNotices(dir).length).toBe(NOTICE_KEEP);
	});
});

describe("W1201 budget pause", () => {
	test("named stop-reason roundtrip; absent reads null", () => {
		const dir = tmp();
		expect(readPause("harvest", dir)).toBeNull();
		expect(pauseTask("harvest", "spend-cap: quota wall", dir)).toBe(true);
		const p = readPause("harvest", dir);
		expect(p?.reason).toBe("spend-cap: quota wall");
		expect(p?.at).toBeGreaterThan(0);
	});
});

describe("W1201 usage-mining cursor run (spawned bin, isolated HOME)", () => {
	test("run advances the confirmed cursor; ledger gap writes a notice", async () => {
		const home = tmp();
		mkdirSync(join(home, ".cache", "claude-governor"), { recursive: true });
		const ledger = join(home, "ledger.db");
		const db = new Database(ledger);
		db.run(
			"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT NOT NULL, lane TEXT DEFAULT '', dialect TEXT DEFAULT '', target_model TEXT, status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT, cache_r INTEGER, cache_c INTEGER, decision TEXT DEFAULT '', hop TEXT)",
		);
		for (let i = 0; i < 25; i++)
			db.run(
				"INSERT INTO route_audit (rid, ts, lane, dialect, target_model, status, duration_ms, ok, cache_r, cache_c, decision) VALUES (?, ?, 'laneX', 'anthropic', 'm1', 200, 500, 1, NULL, 0, 'complexity-v3')",
				[`r${i}`, new Date(Date.now() - 3_600_000).toISOString()],
			);
		db.close();
		const env = {
			...process.env,
			HOME: home,
			SUSPENDERS_BUCKLE_DB: ledger,
			SUSPENDERS_MAINTENANCE_STATE: join(home, "maintenance"),
		};
		const run = (): { code: number | null } => {
			const p = Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "..", "hooks", "bin", "usage-mining.ts"),
					"--no-emit",
				],
				{ env, stdout: "pipe", stderr: "pipe" },
			);
			return { code: p.exitCode };
		};
		const first = run();
		expect(first.code).toBe(0);
		const c = JSON.parse(
			readFileSync(
				join(home, "maintenance", "usage-mining-cursor.json"),
				"utf8",
			),
		) as { state: string; lastMs: number; runId: string };
		expect(c.state).toBe("ok");
		const ms1 = c.lastMs;
		// second run re-confirms and moves the window forward
		const second = run();
		expect(second.code).toBe(0);
		const c2 = JSON.parse(
			readFileSync(
				join(home, "maintenance", "usage-mining-cursor.json"),
				"utf8",
			),
		) as { state: string; lastMs: number };
		expect(c2.state).toBe("ok");
		expect(c2.lastMs).toBeGreaterThanOrEqual(ms1);
		// the artifact landed where the pulse reads it
		expect(
			existsSync(join(home, ".cache", "claude-governor", "usage-mining.json")),
		).toBe(true);
		// failed-source surface: an unreadable ledger writes a notice, no crash
		rmSync(ledger);
		const third = run();
		expect(third.code).toBe(0);
		const notices = readSweepNotices(join(home, "maintenance"));
		expect(notices.join("\n")).toContain("fail(ledger-unavailable)");
	});
});

describe("W1201.1 cursor regressions (spawned bin, isolated HOME)", () => {
	const DAY = 86_400_000;
	const bin = (): string =>
		join(import.meta.dir, "..", "hooks", "bin", "usage-mining.ts");
	const seedLedger = (ledger: string, tsMs: number): void => {
		const db = new Database(ledger);
		db.run(
			"CREATE TABLE route_audit (rid TEXT PRIMARY KEY, ts TEXT NOT NULL, lane TEXT DEFAULT '', dialect TEXT DEFAULT '', target_model TEXT, status INTEGER, duration_ms INTEGER, ok INTEGER, err TEXT, cache_r INTEGER, cache_c INTEGER, decision TEXT DEFAULT '', hop TEXT)",
		);
		for (let i = 0; i < 25; i++)
			db.run(
				"INSERT INTO route_audit (rid, ts, lane, dialect, target_model, status, duration_ms, ok, cache_r, cache_c, decision) VALUES (?, ?, 'laneX', 'anthropic', 'm1', 200, 500, 1, NULL, 0, 'complexity-v3')",
				[`r${i}`, new Date(tsMs).toISOString()],
			);
		db.close();
	};
	const runMining = (home: string, ledger: string): number | null =>
		Bun.spawnSync([process.execPath, bin(), "--no-emit"], {
			env: {
				...process.env,
				HOME: home,
				SUSPENDERS_BUCKLE_DB: ledger,
				SUSPENDERS_MAINTENANCE_STATE: join(home, "maintenance"),
			},
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode;
	const cursorOf = (home: string): { state: string; lastMs: number } =>
		JSON.parse(
			readFileSync(
				join(home, "maintenance", "usage-mining-cursor.json"),
				"utf8",
			),
		);
	const artifactOf = (home: string): { days: number; offenders: unknown[] } =>
		JSON.parse(
			readFileSync(
				join(home, ".cache", "claude-governor", "usage-mining.json"),
				"utf8",
			),
		);

	test("late 30d gap: a 30d-old confirmed bookmark re-mines the whole gap", () => {
		const home = tmp();
		const ledger = join(home, "ledger.db");
		seedLedger(ledger, Date.now() - 20 * DAY); // in the gap, outside 7d
		mkdirSync(join(home, "maintenance"), { recursive: true });
		const cur = join(home, "maintenance", "usage-mining-cursor.json");
		writeFileSync(
			cur,
			`${JSON.stringify({ state: "ok", lastMs: Date.now() - 30 * DAY, runId: "old" })}\n`,
		);
		expect(runMining(home, ledger)).toBe(0);
		const art = artifactOf(home);
		// the window rode the CONFIRMED bookmark (~30d), not the 7d fallback
		expect(art.days).toBeGreaterThanOrEqual(29);
		expect(art.offenders.length).toBeGreaterThan(0);
		expect(cursorOf(home).state).toBe("ok");
	});

	test("repeated early run: window starts at the confirmed cursor, no re-mine", () => {
		const home = tmp();
		const ledger = join(home, "ledger.db");
		seedLedger(ledger, Date.now() - 3_600_000);
		expect(runMining(home, ledger)).toBe(0);
		// first run rode the 7d fallback window
		expect(artifactOf(home).days).toBeGreaterThan(6);
		const ms1 = cursorOf(home).lastMs;
		expect(runMining(home, ledger)).toBe(0);
		const art2 = artifactOf(home);
		// the early run mines only the new slice; confirmed rows never repeat
		expect(art2.days).toBeLessThan(0.001);
		expect(art2.offenders).toEqual([]);
		expect(cursorOf(home).lastMs).toBeGreaterThanOrEqual(ms1);
	});

	test("failed source: notice lands; artifact and confirmed cursor untouched", () => {
		const home = tmp();
		const ledger = join(home, "ledger.db");
		seedLedger(ledger, Date.now() - 3_600_000);
		expect(runMining(home, ledger)).toBe(0);
		const artPath = join(
			home,
			".cache",
			"claude-governor",
			"usage-mining.json",
		);
		const curPath = join(home, "maintenance", "usage-mining-cursor.json");
		const art1 = readFileSync(artPath, "utf8");
		const cur1 = readFileSync(curPath, "utf8");
		rmSync(ledger);
		expect(runMining(home, ledger)).toBe(0);
		expect(readSweepNotices(join(home, "maintenance")).join("\n")).toContain(
			"fail(ledger-unavailable)",
		);
		// B2: the failed source wrote NOTHING — no empty artifact, no advance
		expect(readFileSync(artPath, "utf8")).toBe(art1);
		expect(readFileSync(curPath, "utf8")).toBe(cur1);
	});

	test("interrupted run recovery: surviving pending never widens the window", () => {
		const home = tmp();
		const ledger = join(home, "ledger.db");
		seedLedger(ledger, Date.now() - 3_600_000);
		const curPath = join(home, "maintenance", "usage-mining-cursor.json");
		expect(runMining(home, ledger)).toBe(0);
		const ms1 = cursorOf(home).lastMs;
		// crash simulation: a pending stamp that never confirmed
		expect(markMaybeRan(curPath, "crashed", Date.now())).toBe(true);
		expect(runMining(home, ledger)).toBe(0);
		// recovery rode the SURVIVING bookmark (no fallback widening) and the
		// new confirm cleared the stale evidence
		expect(artifactOf(home).days).toBeLessThan(0.001);
		expect(cursorOf(home).lastMs).toBeGreaterThanOrEqual(ms1);
		expect(readPending(curPath)).toBeNull();
	});
});
