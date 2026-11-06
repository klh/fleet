// lane-zero-token.e2e.ts — W2786 co-situated proof: the zero-token
// fast-retire gate. A provably-dead lane (liveness dead per lesson
// liveness-test-fixtures: local host + pid in no process table) whose
// attribution is PROVABLY empty (a scratch ledger with zero rows for the
// lane's key) is fast-retire eligible; banked tokens or an unreadable
// ledger keep the conservative flow. The retirement legs (failIntent) fire
// through the operator door's own machinery.
//
// Isolation (the w2189 pattern): pinReg() + openGovernorDb() under a
// scratch HOME — GOVERNOR_STORE_URL=local is NOT isolation (REG_ROOT pins
// HOME at module load, so static-import hoisting sends openStore() to the
// machine governor).

import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { openGovernorDb } from "../hooks/lib/govdb/govdb-open.ts";
import { pinReg } from "../hooks/lib/govdb/govdb-util.ts";
import {
	fastRetireEligible,
	zeroTokenProof,
} from "../hooks/lib/lanes/lane-zero-token.ts";
import { failIntent } from "../scripts/lib/launch-intent-cli.ts";
import {
	finishFailedLaunch,
	launchSchema,
} from "../scripts/lib/launch-fencing.ts";

// scratch HOME pins the transcript tree (none), the spoke ledger path and
// the governor root — everything the gate reads stays inside the fixture.
const home = join(tmpdir(), `w2786-zero-${crypto.randomUUID()}`);
mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
process.env.HOME = home;
pinReg();
const store = openGovernorDb() as unknown as Database;

const ledger = join(home, ".claude", "local-llm", "buckle.db");
{
	const d = new Database(ledger);
	d.run(
		"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER, requests INTEGER)",
	);
	d.run("CREATE TABLE api_keys (key_id TEXT, name TEXT)");
	d.run("INSERT INTO api_keys VALUES ('k1', 'lane-a'), ('k2', 'lane-b')");
	d.close();
}

// a lane shaped like the registry row stall-watch iterates: LOCAL host + a
// pid that exists in no process table = laneProcessIdentity false (proven
// dead — the lesson.liveness-test-fixtures local-host shape), no transcript
// under the scratch HOME, session row positively closed (W972 evidence).
const project = "/scratch/w2786";
const THIS_HOST = hostname();
const claimedAt = Date.now() - 86_400_000;
store
	.query(
		"INSERT OR REPLACE INTO work_items (project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
	)
	.run(
		project,
		"W9001",
		"dead zero-token lane",
		"CLAIMED",
		"lane-a",
		claimedAt,
		claimedAt,
	);
store
	.query(
		"INSERT OR REPLACE INTO sessions (sid,state,started_at,hb) VALUES (?,?,?,?)",
	)
	.run("lane-a", "CLOSED", claimedAt, 0);
// the claim event the attribution replay keys on (work take emits this):
// a window exists for lane-a, the ledger attributes nothing to it.
store
	.query(
		"INSERT INTO events (ts,source,kind,scope,payload,target,project) VALUES (?,?,?,?,?,NULL,?)",
	)
	.run(
		claimedAt,
		"work",
		"work.claimed",
		null,
		JSON.stringify({ work: "W9001", by: "lane-a", project }),
		project,
	);
// register a launch intent for the dead lane so failIntent has a row
launchSchema(store as never);
store
	.query(
		"INSERT OR REPLACE INTO lane_launch_intents (project,item,sid,nonce,revision,executor,host,attempt,state,pid,birth) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	)
	.run(
		project,
		"W9001",
		"lane-a",
		"n1",
		claimedAt,
		"/bin/claude",
		THIS_HOST,
		0,
		"REGISTERED",
		999_997,
		null,
	);

const deadLane = {
	sid: "lane-a",
	item: "W9001",
	pid: 999_997,
	branch: "suspenders/W9001",
	worktree: "/scratch/w2786/.worktrees/W9001",
	host: THIS_HOST,
	launchedAt: claimedAt,
};

test("zero spend + dead lane = fast-retire eligible", () => {
	// lane-a has NO router_usage rows — provably zero, not unknown
	const v = fastRetireEligible(
		store,
		store as never,
		project,
		{ id: "W9001", owner: "lane-a", revision: claimedAt, lane: deadLane },
		undefined,
		ledger,
	);
	expect(v.zero, v.why).toBe(true);
});

test("banked tokens keep the conservative flow", () => {
	const d = new Database(ledger);
	d.run(
		"INSERT INTO router_usage VALUES ('2026-11-06T10:00', 'k1', 'glm-5.3', 100, 50, 0, 0, 3)",
	);
	d.close();
	const v = zeroTokenProof(store, project, "W9001", undefined, ledger);
	expect(v.zero, v.why).toBe(false);
	expect(v.why).toContain("banked");
	const d2 = new Database(ledger);
	d2.run("DELETE FROM router_usage");
	d2.close();
});

test("no readable ledger reads unknown, never zero", () => {
	const v = zeroTokenProof(
		store,
		project,
		"W9001",
		undefined,
		"/nonexistent/ledger.db",
	);
	expect(v.zero, v.why).toBe(false);
});

test("the retirement legs fire: intent FAILED via the operator-door machinery", () => {
	const prior = store
		.query("SELECT state FROM lane_launch_intents WHERE project=? AND item=?")
		.get(project, "W9001") as { state: string };
	expect(prior.state).toBe("REGISTERED");
	const out = failIntent(
		store as never,
		project,
		"W9001",
		"W2786 test: dead lane, zero attribution tokens",
	);
	expect(out.ok, out.line).toBe(true);
	const after = store
		.query("SELECT state FROM lane_launch_intents WHERE project=? AND item=?")
		.get(project, "W9001") as { state: string };
	expect(after.state).toBe("FAILED");
	// idempotent second fail
	const again = failIntent(
		store as never,
		project,
		"W9001",
		"second pass evidence",
	);
	expect(again.ok).toBe(true);
});

test("finishFailedLaunch clears the intent (the hygiene sweep's write path)", () => {
	store
		.query(
			"UPDATE lane_launch_intents SET state='REGISTERED' WHERE project=? AND item=?",
		)
		.run(project, "W9001");
	finishFailedLaunch(store as never, {
		project,
		item: "W9001",
		sid: "lane-a",
		nonce: "n1",
		revision: claimedAt,
		executor: "/bin/claude",
		host: THIS_HOST,
		attempt: 0,
		state: "REGISTERED",
		pid: 999_997,
		birth: null,
	});
	const after = store
		.query("SELECT state FROM lane_launch_intents WHERE project=? AND item=?")
		.get(project, "W9001") as { state: string };
	expect(after.state).toBe("FAILED");
});
