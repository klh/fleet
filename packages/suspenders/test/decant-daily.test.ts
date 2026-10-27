// test/decant-daily.test.ts — W1212: key CAS shape, the distillers, the
// decision table (create/reclaim/tombstone/dedupe + human-protect), state
// handling, fact-set argv, the registry entry and a stubbed end-to-end
// runner pass proving same-day idempotency (zero duplicate claims).

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAIM_PREFIX,
	claimKey,
	DAILY_CLAIM_STAMP,
	decantCoordBin,
	decide,
	distillSessionClaims,
	distillWorkClaims,
	type ExistingClaim,
	factSetArgs,
	readState,
	runDaily,
	writeState,
} from "../hooks/lib/fleet-loop/decant-daily.ts";
import {
	MAINTENANCE_TASKS,
	missingRunners,
} from "../hooks/lib/fleet-loop/maintenance.ts";
import type { SessionMetrics } from "../hooks/lib/knowledge/knowledge-sync-policy.ts";

const tmp = mkdtempSync(join(tmpdir(), "decant-daily-"));
const NOW = Date.now();
const SETTER = "mechanical:decant-daily";

function cleanup(): void {
	rmSync(tmp, { recursive: true, force: true });
}

describe("distillers (W1212)", () => {
	test("work rows: window filter, secret gate skips, result sha rides the claim", () => {
		const rows = [
			{
				id: "W1",
				title: "land the thing",
				result_sha: "abc123",
				updated_at: NOW - 60_000,
			},
			{
				id: "W2",
				title: "old",
				result_sha: "def456",
				updated_at: NOW - 48 * 3600_000,
			},
			{
				id: "W3",
				title: "key AKIAIOSFODNN7EXAMPLE leaked", // scrub:allow (fake example key fixture)
				result_sha: null,
				updated_at: NOW - 30_000,
			},
		];
		const { claims, skipped } = distillWorkClaims(rows, NOW - 24 * 3600_000);
		expect(claims.map((c) => c.evidenceId)).toEqual(["work:W1"]);
		expect(claims[0].value).toContain("abc123");
		expect(skipped[0]).toContain("work:W3");
	});
	test("session rows: structural summary only, missing id/endedAt never claims", () => {
		const { claims } = distillSessionClaims(
			[
				sess({
					sessionId: "abc",
					tool: "claude",
					model: "glm",
					endedAt: new Date(NOW - 30_000).toISOString(),
					durationMs: 30_000,
					messageCount: 4,
				}),
				sess({ sessionId: "" }),
			],
			NOW - 3600_000,
		);
		expect(claims.length).toBe(1);
		expect(claims[0].evidenceId).toBe("session:abc");
		expect(claims[0].value).toContain("30s");
		expect(claims[0].value).toContain("4 msgs");
	});
});

function sess(
	o: Partial<SessionMetrics> & { sessionId: string },
): SessionMetrics {
	return {
		tool: null,
		model: null,
		reasoningEffort: null,
		startedAt: null,
		endedAt: null,
		durationMs: null,
		messageCount: null,
		inputTokens: null,
		outputTokens: null,
		reasoningTokens: null,
		peakContextTokens: null,
		contextWindowTokens: null,
		costUsd: null,
		...o,
	};
}

describe("claim key (W1212)", () => {
	test("deterministic; restatement hashes to a NEW key (versions, never collides)", () => {
		const k = claimKey("work:W1", "done work item W1");
		expect(k.startsWith(CLAIM_PREFIX)).toBe(true);
		expect(claimKey("work:W1", "done work item W1")).toBe(k);
		expect(claimKey("work:W1", "done work item W1 v2")).not.toBe(k);
		expect(claimKey("work:W2", "done work item W1")).not.toBe(k);
	});
});
describe("decision table (W1212)", () => {
	const ex = (
		verdict: string | null,
		setter: string | null,
	): ExistingClaim => ({
		verdict,
		setter,
		value: "stored value",
	});
	const claimOf = (id: string) => ({
		key: claimKey(`work:${id}`, `done work item ${id}`),
		evidenceId: `work:${id}`,
		value: `done work item ${id}`,
	});
	test("create on absent; dedupe on present (fresh or human-set verdict)", () => {
		const c = claimOf("W1");
		const st = { lastRunMs: 0, inventory: {} };
		const fresh = decide(
			[c],
			{ [c.key]: ex("fresh", SETTER) },
			st,
			new Set(),
			true,
		);
		expect(fresh.writes).toEqual([]);
		expect(fresh.deduped).toEqual([c.key]);
		const human = decide(
			[c],
			{ [c.key]: ex("retracted", "human:klaus") },
			st,
			new Set(),
			true,
		);
		expect(human.writes).toEqual([]);
		expect(human.deduped).toEqual([c.key]);
		const absent = decide([c], {}, st, new Set(), true);
		expect(absent.writes).toEqual([{ claim: c, mode: "create" }]);
	});
	test("reclaim own retraction when evidence returns; inventory merged", () => {
		const c = claimOf("W1");
		const st = {
			lastRunMs: 0,
			inventory: { [c.key]: { evidenceId: c.evidenceId, ts: 1 } },
		};
		const r = decide(
			[c],
			{ [c.key]: ex("retracted", SETTER) },
			st,
			new Set([c.evidenceId]),
			true,
			42,
		);
		expect(r.writes).toEqual([{ claim: c, mode: "reclaim" }]);
		expect(r.inventory[c.key]).toEqual({ evidenceId: c.evidenceId, ts: 42 });
	});
	test("vanished work evidence tombstones; session defers on inexact presence", () => {
		const c = claimOf("W1");
		const s = claimKey("session:s1", "x");
		const st = {
			lastRunMs: 0,
			inventory: {
				[c.key]: { evidenceId: c.evidenceId, ts: 1 },
				[s]: { evidenceId: "session:s1", ts: 1 },
			},
		};
		const existing = { [c.key]: ex("fresh", SETTER), [s]: ex("fresh", SETTER) };
		const r1 = decide([], existing, st, new Set(), false);
		expect(r1.tombstones.map((t) => t.key)).toEqual([c.key]);
		const r2 = decide([], existing, st, new Set(), true);
		expect(r2.tombstones.map((t) => t.key).sort()).toEqual([c.key, s].sort());
	});
	test("present evidence never tombstones; foreign-setter rows skipped", () => {
		const c = claimOf("W1");
		const st = {
			lastRunMs: 0,
			inventory: { [c.key]: { evidenceId: c.evidenceId, ts: 1 } },
		};
		const present = decide(
			[],
			{ [c.key]: ex("fresh", SETTER) },
			st,
			new Set([c.evidenceId]),
			true,
		);
		expect(present.tombstones).toEqual([]);
		const foreign = decide(
			[],
			{ [c.key]: ex("fresh", "human:x") },
			st,
			new Set(),
			true,
		);
		expect(foreign.tombstones).toEqual([]);
	});
});

describe("state (W1212)", () => {
	test("roundtrip; corrupt reads as never-ran; file stamped 0600", () => {
		const p = join(tmp, "state.json");
		writeState(p, {
			lastRunMs: 7,
			inventory: { k: { evidenceId: "work:W1", ts: 7 } },
		});
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(readState(p)).toEqual({
			lastRunMs: 7,
			inventory: { k: { evidenceId: "work:W1", ts: 7 } },
		});
		writeFileSync(p, "{not json");
		expect(readState(p)).toEqual({ lastRunMs: 0, inventory: {} });
	});
});
describe("fact-set argv (W1212)", () => {
	test("create rides CAS --if-version 0; reclaim fresh; tombstone retracted+ref", () => {
		const create = factSetArgs("k", "v", "work:W1", "create");
		expect(create.slice(0, 4)).toEqual(["fact", "set", "k", "--text"]);
		expect(create).toContain("--if-version");
		expect(create[create.indexOf("--if-version") + 1]).toBe("0");
		expect(create).toContain("--confidence");
		expect(create[create.indexOf("--confidence") + 1]).toBe(
			String(DAILY_CLAIM_STAMP.value),
		);
		const reclaim = factSetArgs("k", "v", "work:W1", "reclaim");
		expect(reclaim).not.toContain("--if-version");
		expect(reclaim[reclaim.indexOf("--verdict") + 1]).toBe("fresh");
		const tomb = factSetArgs("k", "v", "work:W1", "tombstone");
		expect(tomb[tomb.indexOf("--verdict") + 1]).toBe("retracted");
		expect(tomb[tomb.indexOf("--ref") + 1]).toBe("work:W1");
		expect(tomb[tomb.indexOf("--setter") + 1]).toBe(SETTER);
	});
});

describe("registry (W1212)", () => {
	test("decant-daily entry: daily calendar, runner resolves at the root", () => {
		const t = MAINTENANCE_TASKS.find((x) => x.name === "decant-daily");
		expect(t?.calendar).toEqual({ hour: 4, minute: 30 });
		expect(t?.argv("/r", "/repo")[0]).toContain("decant-daily.ts");
		expect(missingRunners()).toEqual([]);
	});
});

// ─── runner e2e fixtures ────────────────────────────────────────────────────

function seedDb(path: string, doneIds: string[]): void {
	const db = new Database(path);
	db.exec(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, result_sha TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id));" +
			"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER, ts INTEGER, confidence REAL, confidence_stamp TEXT);",
	);
	for (const id of doneIds) {
		db.query(
			"INSERT INTO work_items (project, id, title, state, result_sha, updated_at) VALUES ('p', ?, ?, 'DONE', ?, ?)",
		).run(id, `done work item ${id}`, `sha-${id}`, NOW - 3600_000);
	}
	db.close();
}

/** fixture decant CLI whose sync always fails — the degrade leg. */
function writeDeadDecantStub(dir: string): string {
	const bin = join(dir, "decant-dead.ts");
	writeFileSync(
		bin,
		`#!/usr/bin/env bun
process.stderr.write("disk I/O error\\n");
process.exit(1);
`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

/** fixture decant CLI: `sync -q` ok; `ls --json` returns one fresh session. */
function writeDecantStub(dir: string): string {
	const bin = join(dir, "decant-stub.ts");
	writeFileSync(
		bin,
		`#!/usr/bin/env bun
const a = process.argv.slice(2);
if (a[0] === "sync") process.exit(0);
if (a[0] === "ls") {
  const rows = [{ source_session_id: "s1", tool: "claude", model: "glm",
    started_at: new Date(Date.now() - 60000).toISOString(),
    ended_at: new Date(Date.now() - 30000).toISOString(),
    message_count: 4, total_input_tokens: 10, total_output_tokens: 20 }];
  process.stdout.write(JSON.stringify(rows));
}
`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

/** lands what a coord child WOULD have written: one facts row per recorded
 *  create argv, version 1, fresh mechanical stamp — the simulate-the-store
 *  step between two runner passes. */
function landFacts(path: string, calls: string[][]): void {
	const db = new Database(path);
	for (const cmd of calls) {
		if (!cmd.includes("--if-version")) continue;
		const key = cmd[cmd.indexOf("set") + 1];
		const value = cmd[cmd.indexOf("--text") + 1];
		const evidence = cmd[cmd.indexOf("--evidence") + 1];
		db.query(
			"INSERT INTO facts (key, value, source, version, ts, confidence, confidence_stamp) VALUES (?, ?, 'decant-daily', 1, ?, 0.4, ?)",
		).run(
			key,
			value,
			Date.now(),
			JSON.stringify({
				value: 0.4,
				setter: SETTER,
				verdict: "fresh",
				evidence,
				ts: Date.now(),
			}),
		);
	}
	db.close();
}

describe("runner e2e (W1212)", () => {
	const calls: string[][] = [];
	const cursorOf = (p: string): number => readState(p).lastRunMs;
	function opts(dir: string, over: Record<string, unknown> = {}) {
		return {
			dbPath: join(dir, "gov.db"),
			statePath: join(dir, "state.json"),
			decantBin: writeDecantStub(dir),
			cwd: dir,
			coordBin: "coord-unused",
			windowMs: 24 * 3600_000,
			now: () => NOW,
			spawn: (cmd: string[], _t: number) => {
				calls.push(cmd);
				return { code: 0, out: "fact k = v" };
			},
			...over,
		};
	}
	test("run 1 creates CAS children; run 2 over the same evidence is all dedupe", async () => {
		const dir = join(tmp, "e2e-idem");
		mkdirSync(dir);
		seedDb(join(dir, "gov.db"), ["W1"]);
		calls.length = 0;
		const o = opts(dir);
		const r1 = await runDaily(o);
		expect(r1.ok).toBe(true);
		expect(r1.created.length).toBe(2); // work:W1 + session:s1
		expect(r1.errors).toEqual([]);
		for (const c of calls) {
			expect(c[c.indexOf("--if-version") + 1]).toBe("0");
			expect(c[c.indexOf("--setter") + 1]).toBe(SETTER);
			expect(c).toContain("--evidence");
		}
		landFacts(join(dir, "gov.db"), calls);
		calls.length = 0;
		const r2 = await runDaily(o);
		expect(r2.ok).toBe(true);
		expect(r2.created).toEqual([]);
		expect(r2.deduped.length).toBe(2);
		expect(calls.length).toBe(0); // zero duplicate claims
		expect(Object.keys(readState(o.statePath).inventory).length).toBe(2);
	});
	test("collect error: no children fire, cursor never advances, ok=false", async () => {
		const dir = join(tmp, "e2e-fail");
		mkdirSync(dir);
		calls.length = 0;
		const o = opts(dir, { dbPath: join(dir, "missing.db") });
		const r = await runDaily(o);
		expect(r.ok).toBe(false);
		expect(r.errors[0]).toContain("work store");
		expect(calls.length).toBe(0);
		expect(cursorOf(o.statePath)).toBe(0);
	});
	test("decant outage degrades: work children fire, session tombstones defer", async () => {
		const dir = join(tmp, "e2e-degrade");
		mkdirSync(dir);
		seedDb(join(dir, "gov.db"), ["W1"]);
		calls.length = 0;
		const o = opts(dir, { decantBin: writeDeadDecantStub(dir) });
		const r = await runDaily(o);
		expect(r.ok).toBe(false);
		expect(r.errors[0]).toContain("decant sync failed");
		expect(r.created.length).toBe(1); // work:W1 only
		expect(calls.some((c) => c.includes("session:"))).toBe(false);
		expect(cursorOf(o.statePath)).toBe(0); // window re-collects next fire
	});
	test("vanished work evidence tombstones on the next pass (never deletes)", async () => {
		const dir = join(tmp, "e2e-tomb");
		mkdirSync(dir);
		const dbPath = join(dir, "gov.db");
		seedDb(dbPath, ["W1"]);
		calls.length = 0;
		const o = opts(dir);
		const r1 = await runDaily(o);
		expect(r1.created.length).toBe(2);
		landFacts(dbPath, calls);
		const db = new Database(dbPath);
		db.query("DELETE FROM work_items WHERE id = 'W1'").run();
		db.close();
		calls.length = 0;
		const r2 = await runDaily(o);
		expect(r2.ok).toBe(true);
		expect(r2.tombstoned.length).toBe(1);
		const tomb = calls.find((c) => c.includes("--verdict"));
		expect(tomb?.[tomb.indexOf("--verdict") + 1]).toBe("retracted");
		expect(tomb?.[tomb.indexOf("--ref") + 1]).toBe("work:W1");
		// the retracted key stays inventoried — evidence returning reclaims it
		expect(Object.keys(readState(o.statePath).inventory).length).toBe(2);
	});
});

// W1292: the reorg moved this lib into fleet-loop/ — the coord child spawn
// path must still land on the shipped hooks/bin/coord.ts.
test("decantCoordBin resolves the shipped hooks/bin/coord.ts", () => {
	expect(existsSync(decantCoordBin())).toBe(true);
});

afterAll(cleanup);
