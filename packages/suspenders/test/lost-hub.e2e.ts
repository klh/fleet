// test/lost-hub.e2e.ts — W2321.4: the lost-hub requeue policy. First-loss
// grace anchors at the FIRST observed loss and never resets on failed
// re-probes (MultiKueue connectionState discipline); past grace the hub's
// CLAIMED items requeue BUDGETED (work_recovery_attempts ≤3) through the ONE
// release path; exhaustion holds + NEED_DECISION; a claimant still talking
// (fresh hb) holds; unprobeable is no observation. All store legs on an
// in-memory governor shape (reclaim-sweep.e2e.ts fixture idiom).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyLostHub,
	hubClaims,
	hubForLaneHost,
	hubLostGraceMs,
	sshHostPart,
	type LostHubEpisode,
	requeueHubClaims,
} from "../hooks/lib/fleet-loop/lost-hub.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";

test.describe("@unit", () => {
	const databases: Database[] = [];
	const directories: string[] = [];

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
		db.run(
			"CREATE TABLE work_recovery_attempts (project TEXT NOT NULL, id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project,id))",
		);
		return {
			local: true,
			query: (sql) => db.query(sql),
			run: (sql, ...params) => db.run(sql, ...(params as never[])),
			transaction: <T>(fn: () => T) => db.transaction(fn),
			close: () => db.close(),
		} as unknown as GovernorStore;
	}

	test.afterEach(() => {
		for (const db of databases.splice(0)) db.close();
		for (const dir of directories.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	const T0 = 1_700_000_000_000;
	const GRACE = 15 * 60_000;

	test.describe("classifyLostHub — first-loss anchor", () => {
		test("first loss starts the clock (grace, notify once)", () => {
			const r = classifyLostHub(
				{},
				{ hub: "nas", reachable: false, now: T0 },
				GRACE,
			);
			expect(r.action).toBe("grace");
			expect(r.notify).toBe(true);
			expect(r.episode.firstLostAt).toBe(T0);
		});
		test("failed re-probes NEVER reset the anchor", () => {
			const first = classifyLostHub(
				{},
				{ hub: "nas", reachable: false, now: T0 },
				GRACE,
			);
			const later = classifyLostHub(
				first.episode,
				{ hub: "nas", reachable: false, now: T0 + 10 * 60_000 },
				GRACE,
			);
			expect(later.episode.firstLostAt).toBe(T0);
			expect(later.action).toBe("grace");
			const past = classifyLostHub(
				later.episode,
				{ hub: "nas", reachable: false, now: T0 + GRACE + 1 },
				GRACE,
			);
			expect(past.action).toBe("requeue");
			expect(past.episode.firstLostAt).toBe(T0);
		});
		test("recovery resets the episode", () => {
			const lost = classifyLostHub(
				{},
				{ hub: "nas", reachable: false, now: T0 },
				GRACE,
			);
			const back = classifyLostHub(
				lost.episode,
				{ hub: "nas", reachable: true, now: T0 + 5 * 60_000 },
				GRACE,
			);
			expect(back.action).toBe("ok");
			expect(back.episode).toEqual({});
			expect(back.notify).toBe(true); // recovered from a loss episode
		});
		test("notify fires once per loss episode, not per pass", () => {
			const a = classifyLostHub(
				{},
				{ hub: "nas", reachable: false, now: T0 },
				GRACE,
			);
			expect(a.notify).toBe(true);
			const b = classifyLostHub(
				a.episode,
				{ hub: "nas", reachable: false, now: T0 + 1000 },
				GRACE,
			);
			expect(b.notify).toBe(false);
		});
	});

	test.describe("grace knob", () => {
		test("junk → default 15min; floor 60s enforced", () => {
			expect(hubLostGraceMs(undefined)).toBe(15 * 60_000);
			expect(hubLostGraceMs("junk")).toBe(15 * 60_000);
			expect(hubLostGraceMs("10")).toBe(60_000);
			expect(hubLostGraceMs("120000")).toBe(120_000);
		});
	});

	test.describe("hub↔lane join", () => {
		test("lane host maps to the hub label; non-hub hosts do not", () => {
			const hubs = new Map([
				["nas", "nas.threads.dk"],
				["desktop", "desktop.local"],
			]);
			expect(hubForLaneHost("nas.threads.dk", hubs)).toBe("nas");
			expect(hubForLaneHost("NAS", hubs)).toBe("nas");
			expect(hubForLaneHost("desktop.local", hubs)).toBe("desktop");
			expect(hubForLaneHost("laptop.local", hubs)).toBeNull();
			expect(hubForLaneHost(undefined, hubs)).toBeNull();
		});
		test("sshHostPart strips user and port", () => {
			expect(sshHostPart("kk@nas.threads.dk")).toBe("nas.threads.dk");
			expect(sshHostPart("nas.threads.dk:2222")).toBe("nas.threads.dk");
		});
	});

	test.describe("hubClaims — the registry join", () => {
		test("only the hub's own CLAIMED items, matched sid+item", () => {
			const store = fixture();
			const root = mkdtempSync(join(tmpdir(), "w2321-4-"));
			directories.push(root);
			const P = realpathSync(root);
			mkdirSync(join(root, ".fleet"), { recursive: true });
			writeFileSync(
				join(root, ".fleet", "lanes.json"),
				JSON.stringify([
					{ sid: "auto-nas", item: "W1", host: "nas.threads.dk" },
					{ sid: "auto-lap", item: "W2", host: "laptop.local" },
					{ sid: "auto-nas2", item: "W9", host: "nas.threads.dk" },
				]),
			);
			store.run(
				"INSERT INTO work_items (project,id,title,state,owner_sid,updated_at) VALUES (?,?,?, 'CLAIMED',?,?)",
				P,
				"W1",
				"on hub",
				"auto-nas",
				T0,
			);
			store.run(
				"INSERT INTO work_items (project,id,title,state,owner_sid,updated_at) VALUES (?,?,?, 'CLAIMED',?,?)",
				P,
				"W2",
				"on laptop",
				"auto-lap",
				T0,
			);
			// W9 row not CLAIMED by its lane's sid — join is sid+item both
			store.run(
				"INSERT INTO work_items (project,id,title,state,owner_sid,updated_at) VALUES (?,?,?, 'CLAIMED',?,?)",
				P,
				"W9",
				"mismatched owner",
				"someone-else",
				T0,
			);
			const claims = hubClaims(
				store,
				P,
				root,
				"nas",
				new Map([["nas", "nas.threads.dk"]]),
			);
			expect(claims.map((c) => c.id)).toEqual(["W1"]);
		});
	});

	test.describe("requeueHubClaims — budgeted requeue", () => {
		function seed(store: GovernorStore, project: string) {
			store.run(
				"INSERT INTO work_items (project,id,title,state,owner_sid,updated_at) VALUES (?,?,?, 'CLAIMED',?,?)",
				project,
				"W1",
				"hub lane",
				"auto-nas",
				T0,
			);
		}

		test("releases → READY with cause lost-hub, stamps the sticky marker", () => {
			const store = fixture();
			const root = mkdtempSync(join(tmpdir(), "w2321-4-"));
			directories.push(root);
			const P = realpathSync(root);
			seed(store, P);
			const decisions: string[] = [];
			const out = requeueHubClaims(store, {
				project: P,
				repo: root,
				hub: "nas",
				claims: [
					{ id: "W1", owner: "auto-nas", state: "CLAIMED", updatedAt: T0 },
				],
				emitDecision: (id) => decisions.push(id),
			});
			expect(out).toEqual([
				{
					id: "W1",
					action: "released",
					hub: "nas",
					why: expect.stringContaining("budgeted requeue"),
				},
			]);
			expect(
				store
					.query("SELECT state, owner_sid FROM work_items WHERE id='W1'")
					.get(),
			).toEqual({ state: "READY", owner_sid: null });
			const evt = store
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE kind='work.released' AND json_extract(payload,'$.cause')='lost-hub'",
				)
				.get();
			expect(evt).toEqual({ n: 1 });
			const marker = store
				.query(
					"SELECT COUNT(*) AS n FROM facts WHERE key='reclaim.reason." +
						P +
						".W1'",
				)
				.get();
			expect(marker).toEqual({ n: 1 });
			expect(decisions).toEqual([]);
		});

		test("third release exhausts the budget → held + NEED_DECISION", () => {
			const store = fixture();
			const root = mkdtempSync(join(tmpdir(), "w2321-4-"));
			directories.push(root);
			const P = realpathSync(root);
			seed(store, P);
			const decisions: string[] = [];
			const claim = {
				id: "W1",
				owner: "auto-nas",
				state: "CLAIMED",
				updatedAt: T0,
			};
			// three prior attempts consumed the budget
			store.run(
				"INSERT INTO work_recovery_attempts (project,id,attempts) VALUES (?,?,'3')",
				P,
				"W1",
			);
			const out = requeueHubClaims(store, {
				project: P,
				repo: root,
				hub: "nas",
				claims: [claim],
				emitDecision: (id) => decisions.push(id),
			});
			expect(out).toEqual([
				{ id: "W1", action: "held", why: "requeue budget exhausted" },
			]);
			expect(
				store.query("SELECT state FROM work_items WHERE id='W1'").get(),
			).toEqual({ state: "CLAIMED" });
			expect(decisions).toEqual(["W1"]);
		});

		test("a claimant still talking (fresh hb) holds", () => {
			const store = fixture();
			const root = mkdtempSync(join(tmpdir(), "w2321-4-"));
			directories.push(root);
			const P = realpathSync(root);
			seed(store, P);
			store.run(
				"INSERT INTO sessions (sid,state,hb) VALUES ('auto-nas','RUNNING',?)",
				Date.now(),
			);
			const out = requeueHubClaims(store, {
				project: P,
				repo: root,
				hub: "nas",
				claims: [
					{ id: "W1", owner: "auto-nas", state: "CLAIMED", updatedAt: T0 },
				],
				emitDecision: () => {},
			});
			expect(out[0]?.action).toBe("held");
			expect(
				store.query("SELECT state FROM work_items WHERE id='W1'").get(),
			).toEqual({ state: "CLAIMED" });
		});

		test("extend lease holds the requeue", () => {
			const store = fixture();
			const root = mkdtempSync(join(tmpdir(), "w2321-4-"));
			directories.push(root);
			const P = realpathSync(root);
			seed(store, P);
			store.run(
				"INSERT INTO facts (key,value,source,version,ts) VALUES (?,?,?,?,?)",
				`reclaim.extend.${P}.W1`,
				JSON.stringify({ holdUntil: Date.now() + 60_000, by: "test" }),
				"work",
				1,
				Date.now(),
			);
			const out = requeueHubClaims(store, {
				project: P,
				repo: root,
				hub: "nas",
				claims: [
					{ id: "W1", owner: "auto-nas", state: "CLAIMED", updatedAt: T0 },
				],
				emitDecision: () => {},
			});
			expect(out[0]?.action).toBe("held");
		});

		test("pause marker holds everything", () => {
			const store = fixture();
			const root = mkdtempSync(join(tmpdir(), "w2321-4-"));
			directories.push(root);
			const P = realpathSync(root);
			seed(store, P);
			mkdirSync(join(root, ".fleet"), { recursive: true });
			writeFileSync(join(root, ".fleet", "lost-hub-paused"), "paused\n");
			const out = requeueHubClaims(store, {
				project: P,
				repo: root,
				hub: "nas",
				claims: [
					{ id: "W1", owner: "auto-nas", state: "CLAIMED", updatedAt: T0 },
				],
				emitDecision: () => {},
			});
			expect(out[0]?.action).toBe("held");
		});
	});

	test.describe("episode persistence round-trip", () => {
		test("writeEpisode/readEpisode survive and default empty", async () => {
			const store = fixture();
			const { readEpisode, writeEpisode } = await import(
				"../hooks/lib/fleet-loop/lost-hub.ts"
			);
			expect(readEpisode(store, "p", "nas")).toEqual({});
			const ep: LostHubEpisode = {
				firstLostAt: T0,
				lastLostAt: T0 + 1,
				requeued: true,
			};
			writeEpisode(store, "p", "nas", ep);
			expect(readEpisode(store, "p", "nas")).toEqual(ep);
		});
	});
});
