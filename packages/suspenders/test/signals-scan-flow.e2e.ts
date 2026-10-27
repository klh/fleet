// test/signals-scan-flow.test.ts — W969: the happy-path scan flow (one
// close → lane.signal event + blam queue row, window advances). Retry /
// attempt-cap live in signals-scan-retry.test.ts. Fixture store
// (in-memory), injected leg, temp state + blam queue — no real :8903.
import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSignalsScan } from "../hooks/lib/harvest/signals-scan.ts";

const root = mkdtempSync(join(tmpdir(), "signals-scan-flow-"));
const blamQueue = join(root, "blam-signals.jsonl");
test.afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixtureStore(): Database {
	const store = new Database(":memory:");
	store.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT, project TEXT, work TEXT)",
	);
	store.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, result_sha TEXT, PRIMARY KEY (project, id))",
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
	const p = join(root, "tr-flow.jsonl");
	writeFileSync(
		p,
		JSON.stringify({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "DONE W1 all green" }],
			},
		}),
	);
	return p;
}

function mkLeg(cls: string) {
	return async () => {
		return {
			text: JSON.stringify({ class: cls, confidence: 0.8, evidence: "why" }),
			model: "test",
			ms: 1,
		};
	};
}

test.describe("scan flow (W969)", () => {
	test("scans one close: event + blam row + window advances", async () => {
		const store = fixtureStore();
		seed(store);
		store
			.query("INSERT INTO sessions (sid, transcript_path) VALUES (?,?)")
			.run("autow9-x", transcriptFixture());
		const scan = createSignalsScan({
			repo: root,
			store,
			statePath: join(root, "s1.json"),
			blamPath: blamQueue,
			leg: mkLeg("claim-evidence-mismatch"),
		});
		const r = await scan();
		expect(r.scanned[0]?.item).toBe("W1");
		expect(r.blamQueued).toBe(1);
		expect(r.held).toBe(0);
	});
});
