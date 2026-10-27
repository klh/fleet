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
	readSweepNotices,
} from "../hooks/lib/fleet-loop/sweep-state.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "sweep-"));

describe("W1201 sweep cursor", () => {
	test("maybe-ran marker then confirmed advance; unclear never advances", () => {
		const dir = tmp();
		const c = join(dir, "cursor.json");
		expect(readCursor(c)).toBeNull();
		// fallback before first confirmed run
		expect(confirmedMs(readCursor(c), 1000)).toBe(1000);
		expect(markMaybeRan(c, "run-1")).toBe(true);
		expect(readCursor(c)).toEqual({ state: "maybe-ran", runId: "run-1" });
		// a maybe-ran marker carries NO position — the run stays at fallback
		expect(confirmedMs(readCursor(c), 1000)).toBe(1000);
		expect(confirmCursor(c, 5000, "run-1")).toBe(true);
		expect(readCursor(c)).toEqual({
			state: "ok",
			lastMs: 5000,
			runId: "run-1",
		});
		expect(confirmedMs(readCursor(c), 1000)).toBe(5000);
	});

	test("corrupt or invalid cursor reads as absent", () => {
		const dir = tmp();
		const c = join(dir, "cursor.json");
		writeFileSync(c, "not-json{");
		expect(readCursor(c)).toBeNull();
		writeFileSync(c, JSON.stringify({ state: "ok", lastMs: -5, runId: "x" }));
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
