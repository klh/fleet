// test/reclaim-sweep.test.ts — W376: the fleet-loop reclaim sweep runs the
// `work reclaim all` core (lib/reclaim-all.ts) per cycle and broadcasts
// releases on the coord bus. Pins: release needs 3 consecutive dead passes
// (W610 parity), unknown claimants never release, extend leases hold,
// releases are CAS-verified (READY + work.released event), and the sweep
// broadcasts exactly once per pass when something was freed.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createReclaimSweep } from "../hooks/lib/fleet-loop/reclaim-sweep.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	type ReclaimAllRow,
	reclaimAll,
} from "../hooks/lib/lanes/reclaim-all.ts";
import { setReclaimHold } from "../hooks/lib/lanes/reclaim-liveness.ts";

const databases: Database[] = [];
const directories: string[] = [];
const HOST = hostname();

function fixture(): GovernorStore {
	const db = new Database(":memory:");
	databases.push(db);
	db.run("CREATE TABLE claims (sid TEXT, intent TEXT, scope TEXT)");
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE work_items (project TEXT, id TEXT, title TEXT, state TEXT, owner_sid TEXT, updated_at INTEGER, scope TEXT)",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, state TEXT, hb INTEGER)",
	);
	return {
		local: true,
		query: (sql) => db.query(sql),
		run: (sql, ...params) => db.run(sql, ...(params as never[])),
		transaction: <T>(fn: () => T) => db.transaction(fn),
		close: () => db.close(),
	} as unknown as GovernorStore;
}

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function seedClaim(
	store: GovernorStore,
	project: string,
	id: string,
	owner: string,
) {
	store.run(
		"INSERT INTO work_items (project, id, title, state, owner_sid, updated_at) VALUES (?, ?, ?, 'CLAIMED', ?, ?)",
		project,
		id,
		`reap ${id}`,
		owner,
		1_000_000,
	);
}

function seedDeadRegistry(root: string, sid: string, item: string) {
	mkdirSync(join(root, ".fleet"), { recursive: true });
	writeFileSync(
		join(root, ".fleet", "lanes.json"),
		JSON.stringify([{ sid, item, pid: 999999999, host: HOST }]),
	);
}

const deadPasses = (
	store: GovernorStore,
	project: string,
	root: string,
): ReclaimAllRow[] => {
	const run = () => reclaimAll(store, project, root);
	run(); // strike 1
	run(); // strike 2
	return run(); // strike 3 → release
};

describe("reclaimAll release path", () => {
	test("releases on the third consecutive dead pass (CAS-verified)", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w376-sweep-"));
		directories.push(root);
		const P = realpathSync(root);
		seedClaim(store, P, "W1", "autod");
		seedDeadRegistry(root, "autod", "W1");
		const rows = deadPasses(store, P, root);
		const released = rows.filter((x) => x.action === "released");
		expect(released.map((x) => x.id)).toEqual(["W1"]);
		expect(released[0]?.was).toBe("autod");
	});
	test("READY state + work.released event + strikes cleared are the release evidence", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w376-sweep-"));
		directories.push(root);
		const P = realpathSync(root);
		seedClaim(store, P, "W2", "autod");
		seedDeadRegistry(root, "autod", "W2");
		deadPasses(store, P, root);
		const item = store
			.query("SELECT state, owner_sid FROM work_items WHERE id = 'W2'")
			.get() as { state: string; owner_sid: string | null };
		expect(item).toEqual({ state: "READY", owner_sid: null });
		const evt = store
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'work.released' AND json_extract(payload, '$.work') = 'W2'",
			)
			.get() as { n: number };
		expect(evt.n).toBe(1);
		expect(
			store
				.query(
					"SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'reclaim.strike.%'",
				)
				.get(),
		).toEqual({ n: 0 });
	});
});

describe("reclaimAll holds", () => {
	test("pause marker holds all claims without accruing reclaim strikes", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w1088-sweep-"));
		directories.push(root);
		const project = realpathSync(root);
		seedClaim(store, project, "W8", "autod");
		seedDeadRegistry(root, "autod", "W8");
		writeFileSync(join(root, ".fleet", "reclaim-paused"), "paused\n");
		for (let i = 0; i < 4; i++) {
			expect(reclaimAll(store, project, root)).toEqual([
				{ id: "W8", action: "held", why: "automatic recovery paused" },
			]);
		}
		expect(store.query("SELECT COUNT(*) AS n FROM facts").get()).toEqual({
			n: 0,
		});
	});

	test("a dead registry row cannot condemn a different claim owned by the same session", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w376-sweep-"));
		directories.push(root);
		const project = realpathSync(root);
		seedClaim(store, project, "W7", "manual-session");
		seedClaim(store, project, "W8", "manual-session");
		seedDeadRegistry(root, "manual-session", "W7");
		store.run(
			"INSERT INTO sessions (sid, state, hb) VALUES ('manual-session', 'RUNNING', ?)",
			Date.now() - 2 * 60 * 60_000,
		);
		const rows = deadPasses(store, project, root);
		expect(rows.find((row) => row.id === "W7")?.action).toBe("released");
		expect(rows.find((row) => row.id === "W8")?.action).toBe("held");
		expect(
			store.query("SELECT state FROM work_items WHERE id = 'W8'").get(),
		).toEqual({ state: "CLAIMED" });
	});
	test("unknown claimant never releases, pass after pass", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w376-sweep-"));
		directories.push(root);
		const P = realpathSync(root);
		seedClaim(store, P, "W3", "autod");
		store.run(
			"INSERT INTO sessions (sid, state, hb) VALUES ('autod', 'RUNNING', ?)",
			Date.now() - 2 * 60 * 60_000,
		);
		for (let i = 0; i < 5; i++) {
			const rows = reclaimAll(store, P, root);
			expect(rows.every((x) => x.action === "held")).toBe(true);
		}
		const item = store
			.query("SELECT state FROM work_items WHERE id = 'W3'")
			.get() as { state: string };
		expect(item.state).toBe("CLAIMED");
	});
	test("extend lease holds the pass; release falls through after expiry", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w376-sweep-"));
		directories.push(root);
		const P = realpathSync(root);
		seedClaim(store, P, "W4", "autod");
		seedDeadRegistry(root, "autod", "W4");
		setReclaimHold(store, P, "W4", Date.now() + 60_000, "autod");
		const held = reclaimAll(store, P, root);
		expect(held.every((x) => x.action === "held")).toBe(true);
	});
});

describe("fleet-loop reclaim sweep", () => {
	const sweepDeps = (
		root: string,
		store: GovernorStore,
		notes: string[],
	): Parameters<typeof createReclaimSweep>[0] => ({
		REPO: root,
		log: (m: string) => notes.push(`log:${m}`),
		broadcast: (n: string) => notes.push(`broadcast:${n}`),
		store: () => store,
	});
	test("broadcasts once per pass when a claim was freed", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w376-sweep-"));
		directories.push(root);
		const P = realpathSync(root);
		seedClaim(store, P, "W5", "autod");
		seedDeadRegistry(root, "autod", "W5");
		const notes: string[] = [];
		const { reclaimSweep } = createReclaimSweep(sweepDeps(root, store, notes));
		reclaimSweep(); // strike 1
		reclaimSweep(); // strike 2
		reclaimSweep(); // strike 3 → release + broadcast
		const after = notes.filter((n) => n.startsWith("broadcast:"));
		expect(after).toEqual([
			"broadcast:reclaim-all: W5 reclaimed → READY (orphaned claims, fleet-loop auto-reclaim pass)",
		]);
	});
	test("a silent pass (nothing freed) emits no broadcast and no RECLAIM line", () => {
		const store = fixture();
		const root = mkdtempSync(join(tmpdir(), "w376-sweep-"));
		directories.push(root);
		const P = realpathSync(root);
		seedClaim(store, P, "W6", "autod");
		const notes: string[] = [];
		const { reclaimSweep } = createReclaimSweep(sweepDeps(root, store, notes));
		reclaimSweep(); // unknown claimant — held
		expect(notes).toEqual([]);
	});
});
