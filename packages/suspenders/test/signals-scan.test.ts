// test/signals-scan.test.ts — W969 Signals-lite: the silent-failure
// scanner. Fixture store (in-memory), injected oracle leg, temp state +
// blam queue — no real :8903 leg, no real governor.db.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemCapsuleKey } from "../hooks/lib/lanes/capsule-fence.ts";
import {
	buildEvidence,
	closingSid,
	parseVerdict,
	transcriptEvidence,
} from "../hooks/lib/harvest/signals-scan.ts";

const root = mkdtempSync(join(tmpdir(), "signals-scan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixtureStore(): Database {
	const store = new Database(":memory:");
	store.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT, project TEXT, work TEXT)",
	);
	store.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, result_sha TEXT, PRIMARY KEY (project, id))",
	);
	store.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	store.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, transcript_path TEXT)",
	);
	return store;
}

const t0 = 1_760_000_000_000;

function seed(store: Database, id = "W1"): void {
	store
		.query(
			"INSERT INTO work_items (project, id, title, description, result_sha) VALUES (?,?,?,?,?)",
		)
		.run("p", id, "Signals item", "do the thing", "deadbeefcafe");
	store
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, project, work) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			t0,
			"work",
			"work.claimed",
			null,
			JSON.stringify({ work: id, project: "p", by: "autow9-x" }),
			"p",
			id,
		);
	store
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, project, work) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			t0 + 1,
			"work",
			"work.done",
			null,
			JSON.stringify({
				work: id,
				project: "p",
				sha: "deadbeef",
				summary: "landed",
			}),
			"p",
			id,
		);
}

function transcriptFixture(): string {
	const p = join(root, "tr.jsonl");
	writeFileSync(
		p,
		[
			JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "text", text: "DONE W1 all green" }],
				},
			}),
			JSON.stringify({
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", name: "Bash", input: { command: "bun test" } },
					],
				},
			}),
		].join("\n"),
	);
	return p;
}

function doneIdOf(store: Database): number {
	return (
		store.query("SELECT id FROM events WHERE kind = 'work.done'").get() as {
			id: number;
		}
	).id;
}

describe("parseVerdict (W969)", () => {
	test("valid verdict parses", () => {
		const v = parseVerdict(
			'{"class":"claim-evidence-mismatch","confidence":0.8,"evidence":"sha not in evidence"}',
		);
		expect(v?.cls).toBe("claim-evidence-mismatch");
		expect(v?.confidence).toBe(0.8);
		expect(v?.evidence).toBe("sha not in evidence");
	});
	test("prose-wrapped JSON extracts", () => {
		const v = parseVerdict(
			'here:\n{"class":"clean","confidence":0.9,"evidence":"all consistent"}\nthanks',
		);
		expect(v?.cls).toBe("clean");
	});
	test("junk and out-of-vocabulary class return null", () => {
		expect(parseVerdict("not json")).toBeNull();
		expect(
			parseVerdict('{"class":"zork","confidence":0.5,"evidence":"x"}'),
		).toBeNull();
	});
	test("confidence clamps; string confidence falls back to 0.5", () => {
		const v = parseVerdict('{"class":"clean","confidence":7,"evidence":""}');
		expect(v?.confidence).toBe(1);
	});
});

describe("transcriptEvidence (W969)", () => {
	test("assistant text + tool blocks, newest-last, bounded", () => {
		const out = transcriptEvidence(transcriptFixture());
		expect(out).toContain("[text] DONE W1 all green");
		expect(out).toContain("[tool] Bash: bun test");
		expect(out.indexOf("[text]")).toBeLessThan(out.indexOf("[tool]"));
	});
	test("missing file fail-softs to empty", () => {
		expect(transcriptEvidence(join(root, "absent.jsonl"))).toBe("");
	});
});

describe("evidence assembly (W969)", () => {
	test("buildEvidence carries item + lane + capsule + done payload", () => {
		const store = fixtureStore();
		seed(store);
		store
			.query("INSERT INTO sessions (sid, transcript_path) VALUES (?,?)")
			.run("autow9-x", transcriptFixture());
		store
			.query("INSERT INTO facts (key, value, ts) VALUES (?,?,?)")
			.run(
				itemCapsuleKey("p", "W1"),
				JSON.stringify({ note: "banked", ts: t0 }),
				t0,
			);
		const ev = buildEvidence(store, "p", "W1", "autow9-x");
		expect(ev).toContain("ITEM: W1 — Signals item (sha deadbeefcafe)");
		expect(ev).toContain("LANE: autow9-x");
		expect(ev).toContain("TRANSCRIPT TAIL:");
		expect(ev).toContain("CAPSULE:");
		expect(ev).toContain("DONE EVENT:");
	});
	test("closingSid reads the claim before the close", () => {
		const store = fixtureStore();
		seed(store);
		expect(closingSid(store, "p", "W1", doneIdOf(store))).toBe("autow9-x");
	});
});
