// W743 — repro-first gate tests: fail-note classifier, re-mint targets, gate
// refusals, carrier-death exemption via the launch death log, benchmark
// aggregate. In-memory fixture store, real functions.
import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { openMemoryStore, type GovernorStore } from "./govdb-store.ts";
import {
	benchmarkRepro,
	carrierDeathEvidence,
	classifyFailNote,
	remintTargets,
	reproGateForItem,
	reproGateRefusal,
} from "./repro-gate.ts";

const P = "/fixture/fleet.git";

function fixtureStore(): GovernorStore {
	const db = openMemoryStore();
	db.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT, description TEXT, state TEXT, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE events (ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS lane_launch_intents(project TEXT NOT NULL,item TEXT NOT NULL,sid TEXT NOT NULL,nonce TEXT NOT NULL,revision INTEGER NOT NULL,executor TEXT NOT NULL,host TEXT NOT NULL,attempt INTEGER NOT NULL,state TEXT NOT NULL,pid INTEGER,birth TEXT,PRIMARY KEY(project,item))",
	);
	return db;
}

function seedItem(
	db: GovernorStore,
	id: string,
	state: string,
	title = `item ${id}`,
	desc: string | null = null,
): void {
	db.run(
		"INSERT INTO work_items (project, id, title, description, state) VALUES (?,?,?,?,?)",
		P,
		id,
		title,
		desc,
		state,
	);
}

function seedFail(
	db: GovernorStore,
	id: string,
	note: string,
	ts = Date.now(),
): void {
	db.run(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?,?,?,?,?,NULL)",
		ts,
		"work",
		"work.failed",
		null,
		JSON.stringify({ work: id, project: P, note }),
	);
}

describe("classifyFailNote", () => {
	test("repro marker with command and output", () => {
		expect(
			classifyFailNote("repro: bun test x.test.ts -> 3 fails, exit 1"),
		).toEqual({ kind: "repro", why: "bun test x.test.ts -> 3 fails, exit 1" });
	});
	test("no-repro marker beats the repro marker", () => {
		expect(classifyFailNote("no-repro: flake proven by A/B")).toEqual({
			kind: "no-repro",
			why: "flake proven by A/B",
		});
	});
	test("vocabulary reads quota walls as carrier-death family", () => {
		expect(classifyFailNote("lane died on the 429 quota wall")).toEqual({
			kind: "no-repro",
			why: "carrier death",
		});
	});
	test("vocabulary reads environment-gone prose", () => {
		expect(classifyFailNote("environment gone after the hub flip")).toEqual({
			kind: "no-repro",
			why: "environment gone",
		});
	});
	test("unclassified prose stays none", () => {
		expect(classifyFailNote("tests fail sometimes")).toEqual({
			kind: "none",
			why: "no repro artifact and no named no-repro reason",
		});
	});
	test("empty note is none", () => {
		expect(classifyFailNote("")).toEqual({
			kind: "none",
			why: "empty fail note",
		});
		expect(classifyFailNote(null)).toEqual({
			kind: "none",
			why: "empty fail note",
		});
	});
});

describe("remintTargets", () => {
	test("the in-the-wild pattern", () => {
		expect(
			remintTargets("dispatch verb (re-mint of FAILED W719): wedged intents"),
		).toEqual(["W719"]);
	});
	test("prose references never trip it", () => {
		expect(remintTargets("re-mint of a FAILED item W722 here")).toEqual([]);
	});
});

describe("reproGateRefusal", () => {
	test("inert when the text is not a re-mint", () => {
		const db = fixtureStore();
		seedItem(db, "W1", "FAILED");
		seedFail(db, "W1", "gave up, no evidence");
		expect(reproGateRefusal(db, P, "plain new item title")).toBeNull();
	});
	test("refuses an evidence-free re-mint of a FAILED item", () => {
		const db = fixtureStore();
		seedItem(db, "W1", "FAILED");
		seedFail(db, "W1", "gave up, no evidence");
		const r = reproGateRefusal(db, P, "new (re-mint of FAILED W1)");
		expect(r).toContain("W743 repro-first gate");
	});
	test("passes when the re-mint itself carries the marker", () => {
		const db = fixtureStore();
		seedItem(db, "W1", "FAILED");
		seedFail(db, "W1", "gave up, no evidence");
		expect(
			reproGateRefusal(
				db,
				P,
				"new (re-mint of FAILED W1) no-repro: flake proven by A/B",
			),
		).toBeNull();
	});
	test("passes on the predecessor's repro note", () => {
		const db = fixtureStore();
		seedItem(db, "W1", "FAILED");
		seedFail(db, "W1", "repro: bun test foo -> exit 1, 3 failures");
		expect(reproGateRefusal(db, P, "new (re-mint of FAILED W1)")).toBeNull();
	});
	test("passes on the predecessor's carrier-death note", () => {
		const db = fixtureStore();
		seedItem(db, "W1", "FAILED");
		seedFail(db, "W1", "lane died on the 429 quota wall");
		expect(reproGateRefusal(db, P, "new (re-mint of FAILED W1)")).toBeNull();
	});
	test("refuses when the referenced id is absent", () => {
		const db = fixtureStore();
		expect(reproGateRefusal(db, P, "new (re-mint of FAILED W404)")).toContain(
			"not in this work graph",
		);
	});
});

describe("carrierDeathEvidence", () => {
	test("dead registered process, intent never FAILED", () => {
		const db = fixtureStore();
		db.run(
			"INSERT INTO lane_launch_intents VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			P,
			"W9",
			"sid-x",
			"nonce-x",
			1,
			"/bin/claude",
			hostname(),
			2,
			"REGISTERED",
			999999999,
			"1:2",
		);
		const d = carrierDeathEvidence(db, P, "W9");
		expect(d.exempt).toBe(true);
		expect(d.why).toContain("carrier death");
	});
	test("no intent row is not a carrier death", () => {
		const db = fixtureStore();
		expect(carrierDeathEvidence(db, P, "W9").exempt).toBe(false);
	});
});

describe("gate via the death log", () => {
	test("no note, dead intent: the death log exempts", () => {
		const db = fixtureStore();
		seedItem(db, "W1", "FAILED");
		db.run(
			"INSERT INTO lane_launch_intents VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			P,
			"W1",
			"sid-y",
			"nonce-y",
			1,
			"/bin/claude",
			hostname(),
			2,
			"REGISTERED",
			999999999,
			"1:2",
		);
		expect(reproGateRefusal(db, P, "new (re-mint of FAILED W1)")).toBeNull();
	});
});

describe("benchmarkRepro", () => {
	test("rates over a synthetic chain", () => {
		const db = fixtureStore();
		seedItem(db, "W1", "FAILED", "parent");
		seedItem(
			db,
			"W2",
			"READY",
			"child (re-mint of FAILED W1) no-repro: env gone",
		);
		seedItem(db, "W3", "DONE", "unrelated");
		seedFail(db, "W1", "gave up with no evidence", 1000);
		seedFail(db, "W1", "repro: bun test a -> 2 fail", 2000);
		seedFail(db, "W2", "gave up with no evidence", 3000);
		const b = benchmarkRepro(
			db.query("SELECT id, title, description FROM work_items").all(),
			db.query("SELECT payload FROM events WHERE kind='work.failed'").all(),
		);
		expect(b.items).toBe(3);
		expect(b.failed).toBe(2);
		expect(b.reproSuccessRate).toBe(1 / 3);
		expect(b.repeatFailRate).toBe(1 / 2);
		const w1 = b.rows.get("W1");
		expect(w1?.remintChainDepth).toBe(1);
		expect(w1?.failCount).toBe(2);
		expect(b.rows.get("W3")?.failCount).toBe(0);
	});
});
