import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeLaneRegistry,
	pendingManagedRestart,
	pruneLaneRegistry,
	readLaneRegistry,
	registerMissingRestartLane,
} from "../hooks/lib/lane-registry.ts";
import { restartJournalPath } from "../hooks/lib/claude-restart.ts";
import { classifyPrune } from "../scripts/lib/registry-cli.ts";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";

test("canonical prune retains pending and uncertain restart journals under its lock", () => {
	const root = mkdtempSync(join(tmpdir(), "restart-prune-"));
	const worktree = join(root, "tree");
	mkdirSync(join(worktree, ".fleet"), { recursive: true });
	const row = {
		sid: "fixture-lane",
		item: "W1",
		worktree,
		pid: 999999999,
		branch: "suspenders/W1",
		launchedAt: 1,
	};
	const path = restartJournalPath(worktree);
	try {
		mergeLaneRegistry(root, [row]);
		for (const phase of [
			"prepared",
			"retiring",
			"retired",
			"starting",
			"started",
		]) {
			writeFileSync(
				path,
				JSON.stringify({
					phase,
					snapshot: { sid: row.sid, item: row.item, worktree },
				}),
				{ mode: 0o600 },
			);
			expect(pendingManagedRestart(row)).toBe(true);
			expect(
				classifyPrune([row], [row.sid], () => "dead").get(row.sid)?.class,
			).not.toBe("prunable");
			expect(pruneLaneRegistry(root, [row.sid], () => true).removed).toEqual(
				[],
			);
		}
		writeFileSync(path, "corrupt");
		expect(pruneLaneRegistry(root, [row.sid], () => true).removed).toEqual([]);
		rmSync(path);
		expect(
			pruneLaneRegistry(root, [row.sid], () => {
				writeFileSync(
					path,
					JSON.stringify({
						phase: "retired",
						snapshot: { sid: row.sid, item: row.item, worktree },
					}),
					{ mode: 0o600 },
				);
				return true;
			}).removed,
		).toEqual([]);
		writeFileSync(
			path,
			JSON.stringify({
				phase: "verified",
				snapshot: { sid: row.sid, item: row.item, worktree },
			}),
		);
		expect(pruneLaneRegistry(root, [row.sid], () => true).removed).toEqual([
			row,
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("registry publication holds DB before file lock and restores exact bytes on body errors", () => {
	const root = mkdtempSync(join(tmpdir(), "restart-register-"));
	const db = new Database(":memory:");
	db.run("CREATE TABLE registration(id TEXT)");
	const other = { sid: "other", item: "W2", worktree: join(root, "other") };
	const fresh = {
		sid: "original",
		item: "W1",
		worktree: join(root, "tree"),
		pid: 123,
	};
	try {
		mergeLaneRegistry(root, [other]);
		const file = join(root, ".fleet", "lanes.json");
		const bytes = readFileSync(file);
		expect(() =>
			db.transaction(() =>
				registerMissingRestartLane(
					root,
					fresh,
					() => {
						expect(db.inTransaction).toBe(true);
						return true;
					},
					(publish) => {
						db.run("INSERT INTO registration VALUES ('new')");
						publish();
						throw Error("store body refused");
					},
				),
			)(),
		).toThrow("store body refused");
		expect(readFileSync(file)).toEqual(bytes);
		expect(db.query("SELECT * FROM registration").all()).toEqual([]);
		expect(() =>
			registerMissingRestartLane(
				root,
				fresh,
				() => false,
				() => {},
			),
		).toThrow("process identity changed");
		db.transaction(() =>
			registerMissingRestartLane(
				root,
				fresh,
				() => {
					expect(db.inTransaction).toBe(true);
					return true;
				},
				(publish) => {
					db.run("INSERT INTO registration VALUES ('new')");
					publish();
				},
			),
		)();
		expect(readLaneRegistry(root).lanes).toEqual([other, fresh]);
		expect(() =>
			registerMissingRestartLane(
				root,
				{ ...fresh, sid: "competitor" },
				() => true,
				() => {},
			),
		).toThrow("absence changed");
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing registry binding comes only from original retired journal and real claimed graph", () => {
	const f = pausedLaneFixture();
	const module = new URL(
		"../scripts/lib/claude-restart-operation.ts",
		import.meta.url,
	).pathname;
	const read = () => {
		const p = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				"const {missingRetiredLane}=await import(process.env.FIXTURE_MODULE);try{console.log(JSON.stringify(missingRetiredLane(process.env.FIXTURE_ROOT,process.env.FIXTURE_SID)))}catch(e){console.error(e.message);process.exitCode=1}",
			],
			{
				cwd: f.cwd,
				env: {
					...f.env,
					FIXTURE_MODULE: module,
					FIXTURE_ROOT: join(f.home, "repo"),
					FIXTURE_SID: f.sid,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		return {
			code: p.exitCode,
			out: p.stdout.toString(),
			error: p.stderr.toString(),
		};
	};
	const journal = restartJournalPath(f.cwd);
	try {
		f.coord(["fact", "set", `lane.${f.sid}.state`, "PAUSE_REQUESTED"]);
		f.coord([
			"capsule",
			"set",
			`--checkpoint=${f.sha}`,
			"--done=real checkpoint",
			"--next=continue",
		]);
		f.coord(["paused", "--sha", f.sha]);
		const claim = JSON.parse(f.work(["show", f.id, "--json"]));
		const value = {
			sid: f.sid,
			item: f.id,
			worktree: f.cwd,
			claimRevision: claim.updated_at,
			checkpoint: f.sha,
			oldWrapper: { pid: 2000000000, birth: "original-wrapper" },
			oldNative: { pid: 1999999999, birth: "original-native" },
		};
		writeFileSync(
			journal,
			JSON.stringify({ phase: "retired", snapshot: value }),
			{ mode: 0o600 },
		);
		expect(read().code).toBe(0);
		expect(JSON.parse(read().out)).toEqual({
			sid: f.sid,
			item: f.id,
			worktree: f.cwd,
			pid: value.oldWrapper.pid,
		});
		writeFileSync(
			journal,
			JSON.stringify({ phase: "starting", snapshot: value }),
		);
		expect(read().error).toContain("reconcile before retry");
		writeFileSync(
			journal,
			JSON.stringify({
				phase: "retired",
				snapshot: { ...value, sid: "foreign" },
			}),
		);
		expect(read().error).toContain("binding or process absence");
		writeFileSync(
			journal,
			JSON.stringify({ phase: "retired", snapshot: value }),
		);
		writeFileSync(
			journal,
			JSON.stringify({
				phase: "retired",
				snapshot: {
					...value,
					oldWrapper: { pid: process.pid, birth: "reused" },
				},
			}),
		);
		expect(read().error).toContain("binding or process absence");
		writeFileSync(
			journal,
			JSON.stringify({ phase: "retired", snapshot: value }),
		);
		const contextPath = join(f.cwd, ".fleet", "lane-context.json");
		const context = readFileSync(contextPath);
		writeFileSync(
			contextPath,
			JSON.stringify({
				...JSON.parse(context.toString()),
				claimToken: "forged",
			}),
		);
		expect(read().error).toContain("claim token is not proven");
		writeFileSync(contextPath, context);
		f.coord(["fact", "set", `lane.${f.sid}.state`, "RUNNING"]);
		expect(read().error).toContain("canonical PAUSED");
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
}, 10000);
