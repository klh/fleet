import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
	mergeLaneRegistry,
	pendingManagedRestart,
	pruneLaneRegistry,
	readLaneRegistry,
	registerMissingRestartLane,
} from "../hooks/lib/lanes/lane-registry.ts";
import { restartJournalPath } from "../hooks/lib/executors/claude-restart.ts";
import { classifyPrune } from "../scripts/lib/registry-cli.ts";
import { pausedLaneFixture } from "./helpers/paused-lane.ts";
import { assertLocalRestartIntent } from "../scripts/lib/claude-restart-operation.ts";
import type { LaunchIntent } from "../scripts/lib/launch-fencing.ts";

test("restart intent proves local host, original owner and exact incarnation", () => {
	const wrapper = { pid: process.pid, birth: "original" };
	const intent: LaunchIntent = {
		project: "fixture",
		item: "W1",
		sid: "original",
		nonce: "nonce",
		revision: 1,
		executor: process.execPath,
		host: hostname(),
		attempt: 0,
		state: "REGISTERED",
		...wrapper,
	};
	expect(() =>
		assertLocalRestartIntent(intent, "original", wrapper),
	).not.toThrow();
	for (const changed of [
		{ host: "remote.example.invalid" },
		{ sid: "foreign" },
		{ state: "FAILED" },
		{ pid: process.pid + 1 },
		{ birth: "reused" },
	])
		expect(() =>
			assertLocalRestartIntent({ ...intent, ...changed }, "original", wrapper),
		).toThrow("local launch intent");
});

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
		expect(pruneLaneRegistry(root, [row.sid], () => true).removed).toEqual([]);
		rmSync(path);
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

test("real checkpointed STARTED registration permits dead pruning without fabricated verification", () => {
	const f = pausedLaneFixture();
	const sourceRoot = new URL("../", import.meta.url).pathname;
	const script = `
const root=process.env.FIXTURE_ROOT, tree=process.cwd(), sid=process.env.FIXTURE_SID, item=process.env.FIXTURE_ITEM;
const {openStore,projectIdentity}=await import(process.env.FIXTURE_SOURCE+"hooks/lib/govdb/govdb.ts");
const {acquireLaunchLease}=await import(process.env.FIXTURE_SOURCE+"scripts/lib/launch-preflight.ts");
const {reserveLaunchIntent,registerLaunch,processBirth}=await import(process.env.FIXTURE_SOURCE+"scripts/lib/launch-fencing.ts");
const {checkpointedClaudeRestart,restartJournalPath,restartHash}=await import(process.env.FIXTURE_SOURCE+"hooks/lib/executors/claude-restart.ts");
const {mergeLaneRegistry,pendingManagedRestart,pruneLaneRegistry}=await import(process.env.FIXTURE_SOURCE+"hooks/lib/lanes/lane-registry.ts");
const store=openStore(), project=projectIdentity(tree), nonce=crypto.randomUUID();
const claim=store.query("SELECT updated_at FROM work_items WHERE project=? AND id=?").get(project,item);
acquireLaunchLease(store,project,sid,nonce);
const intent=reserveLaunchIntent(store,{project,item,sid,nonce,revision:claim.updated_at,executor:process.execPath},3);
const transcript=tree+"/.fleet/fixture-transcript.jsonl"; await Bun.write(transcript,"fixture conversation\\n");
const snapshot={version:1,id:crypto.randomUUID(),sid,item,worktree:tree,nativeSession:crypto.randomUUID(),transcript,transcriptHash:restartHash(await Bun.file(transcript).bytes()),oldWrapper:{pid:2000000000,birth:"old"},oldNative:{pid:1999999999,birth:"old-native"}};
const {writeFileSync}=await import("node:fs");writeFileSync(restartJournalPath(tree),JSON.stringify({phase:"retired",snapshot}),{mode:0o600});
let child, row;
try{
const journal=await checkpointedClaudeRestart(restartJournalPath(tree),snapshot,{validate:async()=>{},identity:(pid)=>{const p=processBirth(pid);return p&&{pid,birth:p.birth}},retire:async()=>{},start:async()=>{child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"ignore",stderr:"ignore"});const p=processBirth(child.pid);if(!p)throw Error("child birth unavailable");return{pid:child.pid,birth:p.birth}},register:async(_s,fresh)=>{registerLaunch(store,intent,fresh.pid);row={sid,item,worktree:tree,pid:fresh.pid};mergeLaneRegistry(root,[row]);}});
if(journal.phase!=="started")throw Error("actual state transition missing");
if(pendingManagedRestart(row))throw Error("published canonical STARTED incorrectly protected");
const bytes=await Bun.file(restartJournalPath(tree)).text();
const bad=JSON.parse(bytes);bad.newWrapper.birth="forged";await Bun.write(restartJournalPath(tree),JSON.stringify(bad));
if(!pendingManagedRestart(row))throw Error("forged birth not protected");await Bun.write(restartJournalPath(tree),bytes);
child.kill();await child.exited;
const removed=pruneLaneRegistry(root,[sid],r=>processBirth(r.pid)===false).removed;
console.log(JSON.stringify({phase:journal.phase,removed:removed.map(r=>r.sid)}));
}finally{if(child&&child.exitCode===null){child.kill();await child.exited;}store.close();}
`;
	try {
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: f.cwd,
			env: {
				...f.env,
				FIXTURE_ROOT: join(f.home, "repo"),
				FIXTURE_SID: f.sid,
				FIXTURE_ITEM: f.id,
				FIXTURE_SOURCE: sourceRoot,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.stderr.toString()).toBe("");
		expect(child.exitCode).toBe(0);
		expect(JSON.parse(child.stdout.toString())).toEqual({
			phase: "started",
			removed: [f.sid],
		});
	} finally {
		rmSync(f.home, { recursive: true, force: true });
	}
}, 10000);
