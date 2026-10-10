// work-alloc.test.ts — W515: allocation scorer + decision-object rebalance.
// Lib tests on an in-memory store fixture (mirrors work-release.test.ts
// style); one CLI e2e that fabricates a live lane (fresh transcript inside
// the 15-min reclaim lease) and drives `work allocate --apply` end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assignTask,
	hintTokens,
	planAllocation,
	scoreLane,
	type AllocLane,
} from "../hooks/lib/work-alloc.ts";

const databases: Database[] = [];
const directories: string[] = [];
const bunPath = process.execPath;
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(file = ":memory:"): Database {
	const db = new Database(file);
	databases.push(db);
	db.run(
		"CREATE TABLE work_items (project TEXT, id TEXT, parent_id TEXT, title TEXT, description TEXT, state TEXT DEFAULT 'READY', priority INTEGER DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER DEFAULT 1, requires TEXT, tags TEXT, origin TEXT, alloc_reason TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY(project,id))",
	);
	db.run(
		"CREATE TABLE work_deps (project TEXT, work_id TEXT, depends_on TEXT, PRIMARY KEY(project,work_id,depends_on))",
	);
	db.run(
		"CREATE TABLE claims (sid TEXT, scope TEXT, intent TEXT, hot INTEGER DEFAULT 0, ts INTEGER, tp TEXT, PRIMARY KEY(sid,scope))",
	);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER, hb INTEGER, state TEXT DEFAULT 'RUNNING', capabilities TEXT, transcript_path TEXT)",
	);
	return db;
}
function seed(
	db: Database,
	id: string,
	state = "READY",
	owner: string | null = null,
	requires: string | null = null,
): void {
	db.query(
		"INSERT INTO work_items (project,id,title,state,owner_sid,requires,scope,created_at,updated_at) VALUES ('project',?,'t',?,?,?,'src',100,?)",
	).run(id, state, owner, requires, 100);
}
const lane = (
	sid: string,
	live: boolean,
	caps: string[] = [],
	hints: string[] = [],
): AllocLane => ({
	sid,
	live,
	caps,
	hints,
});

describe("hintTokens + scorer", () => {
	test("scope segments and slash-paths become lowercase tokens", () => {
		expect(
			hintTokens(
				"packages/belt",
				"fix board render",
				"see hooks/lib for details",
			),
		).toEqual(["packages", "belt", "hooks", "lib"]);
	});
	test("role bonus, affinity, load, tiebreak via scoreLane", () => {
		const item = { requires: ["build"], hints: ["hooks", "lib"] };
		const capable = lane("zeta", true, ["build"], ["hooks"]);
		const other = lane("alpha", true, ["build"], []);
		// zeta: role 18 + affinity (1/2 ×4 = 2); alpha: role 18 only — but the
		// deterministic tiebreak is sid, and affinity lifts zeta above it
		const z = scoreLane(item, capable, 0);
		const a = scoreLane(item, other, 0);
		expect(z.score).toBe(20);
		expect(a.score).toBe(18);
		expect(z.parts).toContain("role +18");
	});
	test("load penalizes by 4 per held item", () => {
		const item = { requires: [], hints: [] };
		const { score, parts } = scoreLane(item, lane("a", true), 2);
		expect(score).toBe(-8);
		expect(parts).toContain("load -8");
	});
});

describe("planAllocation", () => {
	test("equal scores prefer the live lane; dead targets become recommends", () => {
		const db = fixture();
		seed(db, "W1");
		seed(db, "W2");
		const decisions = planAllocation(
			db,
			"project",
			[lane("live1", true), lane("dead1", false)],
			{ capacity: 1 },
		);
		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({
			item: "W1",
			sid: "live1",
			kind: "assign",
		});
		expect(decisions[1]).toMatchObject({
			item: "W2",
			sid: "dead1",
			kind: "recommend",
		});
		expect(String(decisions[1]?.reason)).toContain("target not live");
	});

	test("live-only set assigns once, then recommends at capacity", () => {
		const db = fixture();
		seed(db, "W1");
		seed(db, "W2");
		const decisions = planAllocation(db, "project", [lane("live1", true)]);
		expect(decisions[0]).toMatchObject({
			kind: "assign",
			sid: "live1",
			item: "W1",
		});
		expect(decisions[1]).toMatchObject({ kind: "recommend", sid: "live1" });
		expect(String(decisions[1]?.reason)).toContain("at capacity");
	});

	test("capacity 2 assigns both; the load penalty shows in the second reason", () => {
		const db = fixture();
		seed(db, "W1");
		seed(db, "W2");
		const decisions = planAllocation(db, "project", [lane("l1", true)], {
			capacity: 2,
		});
		expect(decisions.map((d) => d.kind)).toEqual(["assign", "assign"]);
		expect(String(decisions[1]?.reason)).toContain("load -4");
	});

	test("stuck lanes are skipped — work flows to lighter lanes", () => {
		const db = fixture();
		seed(db, "W1");
		seed(db, "S1", "CLAIMED", "stuckguy");
		db.query("UPDATE work_items SET state='ORPHANED' WHERE id='S1'").run();
		const decisions = planAllocation(db, "project", [
			lane("stuckguy", true),
			lane("free", true),
		]);
		expect(decisions[0]).toMatchObject({ kind: "assign", sid: "free" });
	});

	test("requires gates eligibility; reclaimed-first FIFO orders the plan", () => {
		const db = fixture();
		seed(db, "W9", "READY", null, "build");
		seed(db, "W1", "READY", null);
		seed(db, "W2", "READY", null);
		// W2 released by an operator reclaim — it plans before the older W1
		db.query(
			"INSERT INTO events (ts, kind, payload) VALUES (50, 'work.released', ?)",
		).run(
			'{"work":"W2","project":"project","by":"op","reason":"operator-reclaim"}',
		);
		const decisions = planAllocation(db, "project", [lane("l1", true)], {
			capacity: 2,
		});
		expect(decisions.map((d) => d.item)).toEqual(["W2", "W1"]);
		// W9 needs build — no lane has it — no decision at all
		expect(decisions.map((d) => d.item)).not.toContain("W9");
	});
});

describe("assignTask — the sole assignment gateway", () => {
	test("CAS claims, stamps alloc_reason, couples claim, emits audit event", () => {
		const db = fixture();
		seed(db, "W1");
		const r = assignTask(db, "project", {
			id: "W1",
			sid: "laneA",
			reason: "manual take",
			origin: "host:agent",
		});
		expect(r.ok).toBe(true);
		expect(
			db
				.query(
					"SELECT state, owner_sid, alloc_reason, origin FROM work_items WHERE id='W1'",
				)
				.get(),
		).toEqual({
			state: "CLAIMED",
			owner_sid: "laneA",
			alloc_reason: "manual take",
			origin: "host:agent",
		});
		expect(db.query("SELECT sid, scope, intent FROM claims").all()).toEqual([
			{ sid: "laneA", scope: "src", intent: "work-graph" },
		]);
		const ev = db
			.query("SELECT payload FROM events WHERE kind='work.claimed'")
			.get() as { payload: string } | null;
		expect(JSON.parse(String(ev?.payload))).toMatchObject({
			work: "W1",
			by: "laneA",
			alloc_reason: "manual take",
		});
	});

	test("race loss and bad states return {ok:false} instead of dying", () => {
		const db = fixture();
		seed(db, "W1", "CLAIMED", "other");
		expect(
			assignTask(db, "project", { id: "W1", sid: "a", reason: "x" }).why,
		).toContain("not READY");
		expect(
			db.query("SELECT owner_sid FROM work_items WHERE id='W1'").get(),
		).toEqual({ owner_sid: "other" });
		expect(
			assignTask(db, "project", { id: "NOPE", sid: "a", reason: "x" }).why,
		).toContain("no such work item");
	});

	test("post-lock readiness recheck refuses unmet deps inside the tx", () => {
		const db = fixture();
		seed(db, "W1");
		seed(db, "D1", "RUNNING", "someone");
		db.query("INSERT INTO work_deps VALUES ('project','W1','D1')").run();
		const r = assignTask(db, "project", { id: "W1", sid: "a", reason: "x" });
		expect(r.ok).toBe(false);
		expect(r.why).toContain("unmet dependencies");
		expect(
			db.query("SELECT state FROM work_items WHERE id='W1'").get(),
		).toEqual({ state: "READY" });
	});
});

describe("work allocate CLI", () => {
	test("pure plan then --apply claims through the gateway (e2e)", () => {
		const root = mkdtempSync(join(tmpdir(), "w515-cli-"));
		directories.push(root);
		mkdirSync(join(root, ".git"), { recursive: true });
		// a live lane: registry entry + fresh transcript inside the 15-min lease
		mkdirSync(join(root, ".fleet"), { recursive: true });
		writeFileSync(
			join(root, ".fleet", "lanes.json"),
			'[{"sid":"laneA","item":"W1"}]',
		);
		const projDir = join(root, ".claude", "projects", "p");
		mkdirSync(projDir, { recursive: true });
		const tp = join(projDir, "laneA.jsonl");
		writeFileSync(tp, "{}\n");
		const call = (...args: string[]) => {
			const p = Bun.spawnSync(
				[
					bunPath,
					join(import.meta.dir, "..", "hooks", "bin", "work.ts"),
					...args,
				],
				{
					cwd: root,
					env: { ...process.env, HOME: root, GOVERNOR_STORE_URL: "local" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			return {
				out: p.stdout.toString(),
				err: p.stderr.toString(),
				code: p.exitCode,
			};
		};
		expect(call("add", "allocable work").code).toBe(0);
		const plan = call("allocate", "--json");
		expect(plan.code, plan.err).toBe(0);
		const decisions = JSON.parse(plan.out) as {
			kind: string;
			item: string;
			sid: string;
			reason: string;
		}[];
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			kind: "assign",
			item: "W1",
			sid: "laneA",
		});
		expect(decisions[0]?.reason).toContain("score=");
		const apply = call("allocate", "--apply");
		expect(apply.code, apply.err).toBe(0);
		expect(apply.out).toContain("1 item(s) allocated");
		const show = JSON.parse(call("show", "W1", "--json").out) as {
			state: string;
			owner_sid: string;
			alloc_reason: string;
		};
		expect(show.state).toBe("CLAIMED");
		expect(show.owner_sid).toBe("laneA");
		expect(String(show.alloc_reason)).toContain("allocate:");
	});
});
