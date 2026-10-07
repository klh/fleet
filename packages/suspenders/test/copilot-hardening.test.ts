// test/copilot-hardening.test.ts — W223.2: dual-harness brief verification
// + copilot credit metering. Covered: the brief verifier's three checks
// (structure anchors, size cap, control/ANSI chars) against composed briefs,
// the meter's worktree-prefix attribution (longest prefix, newest-lane
// tiebreak), store reads against a scratch sqlite fixture carrying copilot's
// real session-store schema, the CLI face end-to-end, and the dispatch
// dry-run wiring printing the verification verdict.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { composeBrief } from "../scripts/dispatch-next.ts";
import {
	BRIEF_MAX_BYTES,
	briefVerdictLine,
	verifyBrief,
} from "../scripts/lib/brief-verify.ts";
import {
	laneOfSession,
	meterCopilotLanes,
	readLaneUsage,
	flushLaneUsageFacts,
	usageFactKey,
} from "../scripts/lib/copilot-meter.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w2232-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-w2232-repo-"));
const FLEET = join(REPO, ".fleet");
mkdirSync(FLEET, { recursive: true });
mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
try {
	symlinkSync(
		join(import.meta.dir, "..", "hooks", "bin"),
		join(HOME, ".claude", "hooks", "suspenders", "bin"),
		"dir",
	);
} catch {} // already linked by a sibling suite in the same run

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const baseBrief = (extra = ""): string =>
	composeBrief({
		item: "W900",
		showOut: "W900 READY  sample item\n  why_parallel: test",
		sid: "autow900",
		branch: "suspenders/W900",
		worktree: "/tmp/nowhere/.worktrees/W900",
		capsule: null,
		extra: extra ? [extra] : undefined,
	});

// scratch copilot session-store with the REAL schema columns the meter reads
const STORE = join(HOME, "session-store.db");
const seedStore = (): void => {
	const db = new Database(STORE);
	db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT);
		CREATE TABLE assistant_usage_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			model TEXT NOT NULL,
			input_tokens INTEGER, output_tokens INTEGER,
			cache_read_tokens INTEGER, cache_write_tokens INTEGER,
			total_nano_aiu INTEGER, request_multiplier REAL,
			created_at TEXT DEFAULT (datetime('now')));`);
	db.query("INSERT INTO sessions VALUES (?, ?)").run(
		"sess-lane",
		join(REPO, ".worktrees", "W900"),
	);
	db.query("INSERT INTO sessions VALUES (?, ?)").run(
		"sess-other",
		"/elsewhere/not-a-lane",
	);
	const ins = db.query(
		"INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_nano_aiu, request_multiplier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	// two opus rows (15x) + one sonnet row (1x) in the lane session
	ins.run(
		"sess-lane",
		"claude-opus-5.5",
		100,
		10,
		5,
		2,
		1000,
		15,
		"2026-10-04T09:00:00.000Z",
	);
	ins.run(
		"sess-lane",
		"claude-opus-5.5",
		50,
		5,
		0,
		0,
		500,
		15,
		"2026-10-04T09:05:00.000Z",
	);
	ins.run(
		"sess-lane",
		"claude-sonnet-5",
		20,
		2,
		0,
		0,
		100,
		1,
		"2026-10-04T09:07:00.000Z",
	);
	// one row in a non-lane session — must not attribute anywhere
	ins.run(
		"sess-other",
		"claude-sonnet-5",
		999,
		999,
		0,
		0,
		9999,
		1,
		"2026-10-04T09:07:00.000Z",
	);
	db.close();
};

const lanesJson = (entries: unknown[]): void => {
	const { writeFileSync } = require("node:fs") as {
		writeFileSync: (p: string, s: string) => void;
	};
	writeFileSync(join(FLEET, "lanes.json"), JSON.stringify(entries));
};

describe("W223.2 brief verification (dual-harness)", () => {
	test("a composed brief passes for both harnesses", () => {
		for (const harness of ["claude", "copilot"] as const) {
			const v = verifyBrief(baseBrief(), { harness });
			expect(v.ok).toBe(true);
			expect(v.failures).toEqual([]);
		}
		expect(BRIEF_MAX_BYTES).toBe(32 * 1024);
	});

	// W417.2: the inbox contract is brief-carried for the hookless executors —
	// it must ride (and verify clean) no matter which harness the lane spawns.
	test("inbox contract rides the brief for both harnesses", () => {
		const brief = baseBrief();
		expect(brief).toContain("INBOX CONTRACT (WS-first)");
		expect(brief).toContain("coord-subscribe-autow900.log");
		expect(brief).toContain("inbox --as autow900");
		for (const harness of ["claude", "copilot"] as const) {
			const v = verifyBrief(brief, { harness });
			expect(v.ok).toBe(true);
		}
	});

	test("structure: a stripped section is rejected by name", () => {
		const stripped = baseBrief()
			.split("\n")
			.filter((l) => !l.startsWith("LANDING"))
			.join("\n");
		const v = verifyBrief(stripped, { harness: "copilot" });
		expect(v.ok).toBe(false);
		expect(v.failures.some((f) => f.check === "structure")).toBe(true);
		const f = v.failures.find((f) => f.check === "structure");
		expect(f?.detail).toContain("LANDING");
		// claude sees the same failures (shared checks, different enforcement)
		expect(verifyBrief(stripped, { harness: "claude" }).ok).toBe(false);
	});

	test("size: over-cap briefs are rejected with the byte count", () => {
		const big = baseBrief(`PADDING ${"x".repeat(40_000)}`);
		expect(big.length > BRIEF_MAX_BYTES).toBe(true);
		const v = verifyBrief(big, { harness: "copilot" });
		expect(v.ok).toBe(false);
		const f = v.failures.find((f) => f.check === "size");
		expect(f?.detail).toMatch(new RegExp(String(BRIEF_MAX_BYTES)));
		expect(verifyBrief(baseBrief(), { maxBytes: 10 }).ok).toBe(false);
	});

	test("control chars: ANSI remnant and CR are rejected, named at offset", () => {
		const ansi = `${baseBrief()}\nPS1 line with \x1b[31mred\x1b[0m remnant`;
		const v = verifyBrief(ansi, { harness: "copilot" });
		expect(v.ok).toBe(false);
		const f = v.failures.find((f) => f.check === "control-chars");
		expect(f?.detail).toContain("U+1b");
		expect(f?.detail).toContain("ANSI/ESC remnant");
		expect(
			verifyBrief(`${baseBrief()}\r\nCRLF tail`, { harness: "copilot" }).ok,
		).toBe(false);
		expect(
			verifyBrief(`${baseBrief()}\n\x00NUL byte`, { harness: "copilot" }).ok,
		).toBe(false);
		// \\n and \\t stay legal
		expect(verifyBrief(baseBrief(), { harness: "copilot" }).ok).toBe(true);
	});

	test("verdict line renders ok and failed shapes", () => {
		expect(briefVerdictLine(verifyBrief(baseBrief()), 1234)).toContain(
			"VERIFY ok",
		);
		const bad = verifyBrief("no sections at all", { harness: "copilot" });
		expect(briefVerdictLine(bad, 17)).toContain("VERIFY FAILED");
		expect(briefVerdictLine(bad, 17)).toContain("structure");
	});
});

describe("W223.2 credit metering", () => {
	test("attribution: longest worktree prefix wins, newest lane breaks ties", () => {
		const lanes = [
			{ sid: "a", item: "W1", worktree: "/r/.worktrees/W1", launchedAt: 5 },
			{ sid: "b", item: "W2", worktree: "/r/.worktrees/W1/sub", launchedAt: 1 },
			{ sid: "c", item: "W3", worktree: "/r/.worktrees/W1", launchedAt: 9 },
		];
		expect(laneOfSession("/r/.worktrees/W1/sub/file.ts", lanes)?.sid).toBe("b");
		// exact tie on prefix length: the newer lane (c, launchedAt 9)
		expect(laneOfSession("/r/.worktrees/W1/x", lanes)?.sid).toBe("c");
		expect(laneOfSession("/no/match", lanes)).toBeNull();
	});

	test("store read: sums premium credits per lane, skips non-lane sessions", () => {
		seedStore();
		lanesJson([
			{
				sid: "autow900",
				item: "W900",
				worktree: join(REPO, ".worktrees", "W900"),
				launchedAt: Date.now(),
			},
		]);
		const report = meterCopilotLanes(FLEET, { storeDb: STORE });
		expect(report.ok).toBe(true);
		const lane = report.lanes.find((l) => l.sid === "autow900");
		expect(lane).toBeTruthy();
		// 15 + 15 + 1 premium credits; 1 attributed copilot session (3 events)
		expect(lane?.credits).toBe(31);
		expect(lane?.sessions).toBe(1);
		expect(lane?.inTok).toBe(170);
		expect(lane?.outTok).toBe(17);
		expect(lane?.nanoAiu).toBe(1600);
		expect(lane?.lastAt).toBe(Date.parse("2026-10-04T09:07:00.000Z"));
		expect(lane?.models).toContain("claude-opus-5.5");
	});

	test("missing store is an honest empty, never fabricated data", () => {
		const r = meterCopilotLanes(FLEET, {
			storeDb: join(HOME, "no-such-store.db"),
		});
		expect(r.ok).toBe(false);
		expect(r.lanes).toEqual([]);
	});
});

describe("W223.2 govdb surface (coord CLI verb only)", () => {
	test("flush stamps lane.<sid>.usage; read parses it back", () => {
		const report = meterCopilotLanes(FLEET, { storeDb: STORE });
		const bin = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
		const stamped = flushLaneUsageFacts(report, { bin });
		expect(stamped).toEqual(["autow900"]);
		const back = readLaneUsage("autow900", { bin });
		expect(back?.credits).toBe(31);
		expect(back?.sessions).toBe(1);
		expect(readLaneUsage("nobody", { bin })).toBeNull();
		expect(usageFactKey("autow900")).toBe("lane.autow900.usage");
	});
});

describe("W223.2 wiring through the real CLIs", () => {
	test("copilot-usage.ts CLI reports the metered lane", () => {
		const p = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "..", "hooks", "bin", "copilot-usage.ts"),
				"--fleet",
				FLEET,
				"--store",
				STORE,
				"--json",
			],
			{ env: { ...process.env, HOME }, stdout: "pipe", stderr: "pipe" },
		);
		const out = JSON.parse(p.stdout.toString()) as {
			ok: boolean;
			lanes: Array<{ sid: string; credits: number }>;
		};
		expect(out.ok).toBe(true);
		expect(out.lanes[0]?.sid).toBe("autow900");
		expect(out.lanes[0]?.credits).toBe(31);
	});

	test("dispatch-next dry-run prints the brief verification verdict", () => {
		const { writeFileSync } = require("node:fs") as {
			writeFileSync: (p: string, s: string) => void;
		};
		writeFileSync(join(REPO, ".prefer"), "must=copilot\n");
		const { spawnSync } = require("node:child_process") as {
			spawnSync: typeof import("node:child_process").spawnSync;
		};
		const added = spawnSync(
			process.execPath,
			[
				join(import.meta.dir, "..", "hooks", "bin", "work.ts"),
				"add",
				"w2232 dry item",
			],
			{ cwd: REPO, env: { ...process.env, HOME }, encoding: "utf8" },
		);
		const id = (added.stdout.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const d = spawnSync(
			process.execPath,
			[
				join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
				"--repo",
				REPO,
				"--dry-run",
				"--item",
				id,
			],
			{ cwd: REPO, env: { ...process.env, HOME }, encoding: "utf8" },
		);
		expect(d.stdout).toContain(`DRY dispatch ${id}`);
		expect(d.stdout).toContain("VERIFY ok — copilot brief");
		rmSync(join(REPO, ".prefer"));
	});
});
