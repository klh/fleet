// session-heartbeat.test.ts — W294: the shared stop gate doubles as the
// plane heartbeat. Every dialect's Stop (claude gate.ts stop, codex/copilot
// stop modes) refreshes the sessions row's hb and fills an empty
// transcript_path; CLOSED rows are never resurrected; a missing row
// fail-opens. Isolated temp HOME + repo, spawns the REAL gate.ts stop path.
import { expect, test } from "./pw";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-hb-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-hb-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const GATE = join(import.meta.dir, "..", "hooks", "gate.ts");
const TS = Date.now();

// env for the gate subprocess: temp HOME; SUSPENDERS_SID stripped so the
// dialect resolvers fall through to the payload's own session id (this
// lane's real env carries the dispatched sid — never leak it into a child)
const env = { ...process.env, HOME, SUSPENDERS_SID: "" };

// one coord pass migrates the db so seeds can run (sweep.test.ts recipe)
Bun.spawnSync(
	[
		"bun",
		join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
		"kb",
		"stats",
	],
	{ cwd: REPO, env, stdout: "ignore", stderr: "ignore" },
);

type Seed = { hb?: number; state?: string; transcript_path?: string | null };
type Row = { hb: number; state: string; transcript_path: string | null };

function rowOf(sid: string): Row | undefined {
	const db = new Database(DB, { readonly: true });
	const r = db
		.query("SELECT hb, state, transcript_path FROM sessions WHERE sid = ?")
		.get(sid) as Row | undefined;
	db.close();
	return r;
}

function seed(sid: string, s: Seed = {}) {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state, transcript_path) VALUES (?, 'proj', ?, ?, ?, ?)",
	).run(
		sid,
		s.hb ?? TS,
		s.hb ?? TS,
		s.state ?? "RUNNING",
		s.transcript_path === undefined ? null : s.transcript_path,
	);
	db.close();
}

function stop(dialect: string[], payload: Record<string, unknown>) {
	// Bun.spawnSync drops `input` — stdin rides a temp file (the gates.test.ts
	// lesson, session-bridge payloadFile recipe); without it the gate reads an
	// empty payload and the heartbeat no-ops
	const pf = `${REPO}/payload-${Math.random().toString(36).slice(2)}.json`;
	writeFileSync(pf, JSON.stringify(payload));
	const p = Bun.spawnSync(["bun", GATE, ...dialect], {
		stdin: Bun.file(pf),
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	rmSync(pf, { force: true });
	return { out: p.stdout.toString(), code: p.exitCode };
}

test.afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

test.describe("session heartbeat (W294)", () => {
	test("stop refreshes hb + fills an empty transcript_path", () => {
		const sid = "hb-fill-aaaa0001";
		seed(sid);
		const before = rowOf(sid)?.hb ?? 0;
		const t = join(REPO, "real-transcript.jsonl");
		writeFileSync(t, "{}\n");
		const r = stop(["stop"], {
			session_id: sid,
			cwd: REPO,
			hook_event_name: "Stop",
			transcript_path: t,
		});
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("{}"); // allowed
		const after = rowOf(sid) as Row;
		expect(after.hb).toBeGreaterThan(before);
		expect(after.transcript_path).toBe(t);
	});

	test("existing transcript_path is never clobbered", () => {
		const sid = "hb-keep-bbbb0002";
		const laneLog = join(REPO, "lane-hb-keep-bbbb0002.log");
		seed(sid, { transcript_path: laneLog });
		const before = rowOf(sid)?.hb ?? 0;
		const t = join(REPO, "other-transcript.jsonl");
		writeFileSync(t, "{}\n");
		const r = stop(["stop"], {
			session_id: sid,
			cwd: REPO,
			hook_event_name: "Stop",
			transcript_path: t,
		});
		expect(r.code).toBe(0);
		const after = rowOf(sid) as Row;
		expect(after.hb).toBeGreaterThan(before);
		expect(after.transcript_path).toBe(laneLog);
	});

	test("CLOSED rows are never resurrected", () => {
		const sid = "hb-closed-cccc0003";
		seed(sid, { state: "CLOSED", hb: TS - 3_600_000 });
		const r = stop(["stop"], {
			session_id: sid,
			cwd: REPO,
			hook_event_name: "Stop",
		});
		expect(r.code).toBe(0);
		const after = rowOf(sid) as Row;
		expect(after.state).toBe("CLOSED");
		expect(after.hb).toBe(TS - 3_600_000);
	});

	test("codex stop passthrough: hb touch lands on the payload sid", () => {
		const sid = "hb-codex-eeee0005";
		seed(sid);
		const before = rowOf(sid)?.hb ?? 0;
		const r = stop(["codex", "stop"], {
			session_id: sid,
			cwd: REPO,
			hook_event_name: "Stop",
			stop_hook_active: false,
			transcript_path: join(REPO, "codex-tr.jsonl"),
		});
		expect(r.code).toBe(0);
		const after = rowOf(sid) as Row;
		expect(after.hb).toBeGreaterThan(before);
	});

	test("copilot stop passthrough: hb touch lands on the payload sid", () => {
		const sid = "hb-copilot-ffff0006";
		seed(sid);
		const before = rowOf(sid)?.hb ?? 0;
		const r = stop(["copilot", "stop"], {
			session_id: sid,
			cwd: REPO,
			hook_event_name: "Stop",
			stop_hook_active: false,
			transcript_path: join(REPO, "copilot-tr.jsonl"),
		});
		expect(r.code).toBe(0);
		const after = rowOf(sid) as Row;
		expect(after.hb).toBeGreaterThan(before);
	});

	test("unknown sid fail-opens: the stop still allows", () => {
		const r = stop(["stop"], {
			session_id: "hb-ghost-dddd0004",
			cwd: REPO,
			hook_event_name: "Stop",
		});
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("{}");
	});
});
