// test/signals-scan-retry.test.ts — W969: leg-down hold + retry, and the
// attempt cap. Companion to signals-scan-flow.test.ts (happy path) —
// separate file purely because sequential appends to one test file kept
// truncating mid-emission this session (W969 lane note).
import { Database } from "bun:sqlite";
import { expect, test } from "./pw";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSignalsScan,
	readScanState,
} from "../hooks/lib/harvest/signals-scan.ts";

const root = mkdtempSync(join(tmpdir(), "signals-scan-retry-"));
const blamQueue = join(root, "blam2.jsonl");
test.afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixtureStore(): Database {
	const store = new Database(":memory:");
	store.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT, project TEXT, work TEXT)",
	);
	store.run(
		"CREATE TABLE work_items (project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, result_sha TEXT, PRIMARY KEY (project, id))",
	);
	return store;
}

function seed(store: Database): void {
	store
		.query(
			"INSERT INTO work_items (project, id, title, description, result_sha) VALUES (?,?,?,?,?)",
		)
		.run("p", "W1", "t", null, null);
	store
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, project, work) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			1,
			"work",
			"work.claimed",
			null,
			JSON.stringify({ work: "W1", project: "p", by: "autow9-x" }),
			"p",
			"W1",
		);
	store
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, project, work) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			2,
			"work",
			"work.done",
			null,
			JSON.stringify({ work: "W1", project: "p" }),
			"p",
			"W1",
		);
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

test.describe("retry flow (W969)", () => {
	test("leg down holds the window; next fire scans", async () => {
		const store = fixtureStore();
		seed(store);
		let fail = true;
		const sp = join(root, "hold.json");
		const scan = createSignalsScan({
			repo: root,
			store,
			statePath: sp,
			blamPath: blamQueue,
			leg: async () => {
				if (fail) throw new Error("503");
				return mkLeg("clean")();
			},
		});
		expect((await scan()).held).toBe(1);
		expect(readScanState(sp).lastId).toBe(0);
		fail = false;
		expect((await scan()).scanned).toHaveLength(1);
		expect(readScanState(sp).lastId).toBeGreaterThan(0);
	});

	test("attempt cap: give up silently, window advances", async () => {
		const store = fixtureStore();
		seed(store);
		const sp = join(root, "cap.json");
		const scan = createSignalsScan({
			repo: root,
			store,
			statePath: sp,
			blamPath: blamQueue,
			leg: async () => {
				throw new Error("down");
			},
		});
		await scan();
		await scan();
		await scan();
		const r4 = await scan();
		expect(r4.skipped).toBe(1);
		expect(readScanState(sp).lastId).toBe(2);
	});
});
