// work-alloc.test.ts — W515: allocation scorer + decision-object rebalance.
// Lib tests on an in-memory store fixture (mirrors work-release.test.ts
// style); one CLI e2e that fabricates a lane (fresh transcript inside
// the 15-min reclaim lease) and drives `work allocate --apply` end to end.
// W646: scope-hint overlap — HintSet path/word split (paths weigh ×3),
// recent-claim history affinity, scope-miss penalty, score>overlap>load>
// live>sid tiebreak, overlap evidence in the reason string.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpDir } from "./helpers/fixture-kit.ts";

import { join } from "node:path";
import {
	assignTask,
	beats,
	candidateLanes,
	hintSet,
	hintTokens,
	planAllocation,
	scoreLane,
	type AllocLane,
} from "../hooks/lib/work/work-alloc.ts";
test.describe("@unit", () => {

const databases: Database[] = [];
const directories: string[] = [];
const bunPath = process.execPath;
test.afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(file = ":memory:"): Database {
	const db = new Database(file);
	databases.push(db);
	db.run(
		"CREATE TABLE work_items (project TEXT, id TEXT, parent_id TEXT, title TEXT, description TEXT, state TEXT DEFAULT 'READY', priority INTEGER DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER DEFAULT 1, requires TEXT, tags TEXT, origin TEXT, alloc_reason TEXT, evidence TEXT, claim_token_hash TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY(project,id))",
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
	history: string[] = [],
): AllocLane => ({
	sid,
	live,
	caps,
	hints,
	history,
});

test.describe("hintTokens + scorer", () => {
	test("scope segments and slash-paths become lowercase tokens", () => {
		expect(
			hintTokens(
				"packages/belt",
				"fix board render",
				"see hooks/lib for details",
			),
		).toEqual(["packages", "belt", "hooks", "lib"]);
	});
	test("hintSet splits path tokens from domain words", () => {
		expect(
			hintSet("packages/belt", "fix board render", "see hooks/lib here"),
		).toEqual({ paths: ["hooks", "lib"], words: ["packages", "belt"] });
	});
	test("role bonus, affinity, load, tiebreak via scoreLane", () => {
		const item = {
			requires: ["build"],
			hints: { paths: ["hooks"], words: ["lib"] },
		};
		const capable = lane("zeta", true, ["build"], ["hooks"]);
		const other = lane("alpha", true, ["build"], []);
		// zeta: role 18 + affinity (path hit: 3/4 of the weight ×4 = 3);
		// alpha: role only — affinity lifts zeta above the sid tiebreak
		const z = scoreLane(item, capable, 0);
		const a = scoreLane(item, other, 0);
		expect(z.score).toBe(21);
		expect(z.parts).toContain("affinity +3 [hooks]");
		expect(a.score).toBe(18);
		expect(z.parts).toContain("role +18");
	});
	test("load penalizes by 4 per held item", () => {
		const item = { requires: [], hints: { paths: [], words: [] } };
		const { score, parts } = scoreLane(item, lane("a", true), 2);
		expect(score).toBe(-8);
		expect(parts).toContain("load -8");
	});
	test("path hits weigh 3× word hits inside the affinity", () => {
		const item = { requires: [], hints: { paths: ["a"], words: ["b"] } };
		const both = scoreLane(item, lane("x", true, [], ["a", "b"]), 0);
		const wordOnly = scoreLane(item, lane("y", true, [], ["b"]), 0);
		// both: 3+1 of 4 weighted → +4; word-only: 1 of 4 → +1
		expect(both.score).toBe(4);
		expect(wordOnly.score).toBe(1);
	});
	test("history hits count like worktree hints", () => {
		const item = { requires: [], hints: { paths: ["hooks"], words: [] } };
		const { score, parts } = scoreLane(
			item,
			lane("h", true, [], [], ["hooks"]),
			0,
		);
		expect(score).toBe(4);
		expect(parts).toContain("affinity +4 [hooks]");
	});
	test("scope knowledge with zero overlap takes the −3 penalty", () => {
		const item = { requires: [], hints: { paths: ["x"], words: [] } };
		const { score, parts } = scoreLane(
			item,
			lane("s", true, [], ["unrelated"]),
			0,
		);
		expect(score).toBe(-3);
		expect(parts).toContain("scope-penalty -3");
	});
});

test.describe("beats tiebreak", () => {
	test("score dominates; equal score → more overlap wins", () => {
		const a = lane("a", true);
		const b = lane("b", true);
		expect(
			beats(
				{ lane: a, score: 1, overlap: 0, load: 9 },
				{ lane: b, score: 0, overlap: 9, load: 0 },
			),
		).toBe(true);
		expect(
			beats(
				{ lane: a, score: 0, overlap: 2, load: 5 },
				{ lane: b, score: 0, overlap: 1, load: 0 },
			),
		).toBe(true);
	});
	test("then load, then live, then sid", () => {
		const a = lane("a", true);
		const z = lane("z", true);
		const dead = lane("z9", false);
		// equal score+overlap → lighter lane wins even against a live one
		expect(
			beats(
				{ lane: a, score: 0, overlap: 0, load: 0 },
				{ lane: dead, score: 0, overlap: 0, load: 1 },
			),
		).toBe(true);
		// equal so-far → live wins
		expect(
			beats(
				{ lane: a, score: 0, overlap: 0, load: 0 },
				{ lane: z, score: 0, overlap: 0, load: 0 },
			),
		).toBe(true);
		// all equal → smaller sid
		expect(
			beats(
				{ lane: z, score: 0, overlap: 0, load: 0 },
				{ lane: a, score: 0, overlap: 0, load: 0 },
			),
		).toBe(false);
	});
});

test.describe("planAllocation", () => {
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
	test("recent-claim history steers overlap; reason carries the evidence", () => {
		const db = fixture();
		// laneA closed a claim that named hooks/lib; W2 overlaps that history
		seed(db, "H1", "DONE", "laneA");
		db.query(
			"UPDATE work_items SET title='fix hooks/lib bug' WHERE id='H1'",
		).run();
		seed(db, "W2");
		db.query(
			"UPDATE work_items SET title='fix hooks/lib bug' WHERE id='W2'",
		).run();
		const [d] = planAllocation(
			db,
			"project",
			candidateLanes(
				db,
				[
					{ sid: "laneA", item: "H1" },
					{ sid: "laneB", item: "W9" },
				],
				"project",
			),
			{ capacity: 1 },
		);
		expect(d).toMatchObject({ item: "W2", sid: "laneA" });
		expect(String(d?.reason)).toContain("affinity +4 [hooks,lib,src]");
	});
});

test.describe("candidateLanes history", () => {
	test("collects hint tokens from the lane's recent claims", () => {
		const db = fixture();
		seed(db, "H1", "DONE", "laneA");
		db.query(
			"UPDATE work_items SET title='fix hooks/lib bug' WHERE id='H1'",
		).run();
		const lanes = candidateLanes(
			db,
			[
				{ sid: "laneA", item: "H1" },
				{ sid: "laneB", item: "W9" },
			],
			"project",
		);
		const [a, b] = lanes;
		expect(a.history).toContain("hooks");
		expect(a.history).toContain("lib");
		expect(b.history).toEqual([]);
	});
});

test.describe("assignTask — the sole assignment gateway", () => {
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

test.describe("work allocate CLI", () => {
	test("pure plan then --apply claims through the gateway (e2e)", () => {
		const root = tmpDir("w515-cli-");
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

});
