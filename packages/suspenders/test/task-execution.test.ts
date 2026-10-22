import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskExecutionSnapshot } from "../hooks/board/task-execution.ts";
import { TASKS } from "../hooks/board-html/tasks.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

test("actual registry/process/store snapshot binds item ownership, pause incarnation and exact artifact events", () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "execution-projection-")),
	);
	const db = new Database(":memory:");
	try {
		expect(
			Bun.spawnSync(["git", "init", root], { stdout: "pipe", stderr: "pipe" })
				.exitCode,
		).toBe(0);
		mkdirSync(join(root, ".fleet"));
		const sid = `missing-${crypto.randomUUID()}`;
		writeFileSync(
			join(root, ".fleet/lanes.json"),
			JSON.stringify([
				{ sid, item: "W1", pid: 2147483647, launchedAt: 200, attempt: 3 },
			]),
		);
		db.exec(
			"CREATE TABLE facts(key TEXT,value TEXT,ts INTEGER); CREATE TABLE events(id INTEGER PRIMARY KEY,ts INTEGER,kind TEXT,project TEXT,work TEXT,payload TEXT)",
		);
		db.run("INSERT INTO facts VALUES (?, 'PAUSED', 100)", `lane.${sid}.state`);
		const claim = {
			project: join(root, ".git"),
			id: "W1",
			state: "CLAIMED",
			owner_sid: sid,
			result_sha: null,
		};
		let snapshot = taskExecutionSnapshot(
			db as unknown as GovernorStore,
			[claim],
			300,
		);
		expect(snapshot(claim)).toMatchObject({
			state: "dead",
			attempt: 3,
			lifecycle: null,
			observed_at: 300,
			progress: null,
		});
		expect(snapshot({ ...claim, id: "W2" }).state).toBe("unknown");
		expect(snapshot({ ...claim, owner_sid: "different" }).state).toBe(
			"unknown",
		);
		db.run("UPDATE facts SET ts = 250");
		snapshot = taskExecutionSnapshot(
			db as unknown as GovernorStore,
			[claim],
			300,
		);
		expect(snapshot(claim)).toMatchObject({
			state: "paused",
			lifecycle_observed_at: 250,
		});
		expect(snapshot({ ...claim, open_decisions: 1 }).state).toBe("blocked");
		const done = { ...claim, state: "DONE", result_sha: "exact" };
		for (const [kind, payload, ts] of [
			["work.done", { sha: "exact" }, 210],
			[
				"work.review",
				{ receipt: JSON.stringify({ commit: "exact", verdict: "PASS" }) },
				220,
			],
			["work.landed", { commit: "exact", integration: "main" }, 230],
			["work.review", { verdict: "PASS", note: "unbound prose" }, 240],
		] as const)
			db.run(
				"INSERT INTO events(ts,kind,project,work,payload) VALUES (?,?,?,?,?)",
				ts,
				kind,
				claim.project,
				claim.id,
				JSON.stringify(payload),
			);
		snapshot = taskExecutionSnapshot(
			db as unknown as GovernorStore,
			[done],
			300,
		);
		expect(snapshot(done)).toMatchObject({
			state: "completed",
			progress: { stage: "landed", commit: "exact", ts: 230 },
		});
		expect(snapshot({ ...done, result_sha: "another" }).progress).toBeNull();
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("actual served task script parses and shares the exact summary implementation", () => {
	expect(() => new Function(TASKS)).not.toThrow();
	const summary = new Function(`${TASKS}; return executionSummary;`)();
	expect(
		summary([
			{
				project: "p",
				id: "W1",
				state: "CLAIMED",
				owner_sid: "owner",
				execution: { state: "unknown" },
			},
		]),
	).toMatchObject({ claims: 1, owners: 1, live_harnesses: 0, unknown: 1 });
	expect(TASKS).toContain("label: 'claimed'");
});
