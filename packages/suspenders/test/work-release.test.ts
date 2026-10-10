import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseWorkClaim } from "../hooks/lib/work-release.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const expected = {
	project: "project",
	id: "W1",
	owner: "old",
	state: "CLAIMED",
	updatedAt: 100,
};
function fixture(file = ":memory:") {
	const db = new Database(file);
	databases.push(db);
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,state TEXT,owner_sid TEXT,scope TEXT,updated_at INTEGER,PRIMARY KEY(project,id))",
	);
	db.run(
		"CREATE TABLE claims(sid TEXT,scope TEXT,intent TEXT,PRIMARY KEY(sid,scope))",
	);
	db.run(
		"CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	db.run(
		"INSERT INTO work_items VALUES ('project','W1','CLAIMED','old','src',100)",
	);
	db.run(
		"INSERT INTO claims VALUES ('old','src','work-graph'),('old','other','editing unrelated')",
	);
	return db;
}

test("exact release couples state, owned work claim and one project-scoped event", () => {
	const db = fixture();
	expect(
		releaseWorkClaim(db, expected, { by: "old", reason: "owner-release" }),
	).toBe(true);
	expect(db.query("SELECT state,owner_sid FROM work_items").get()).toEqual({
		state: "READY",
		owner_sid: null,
	});
	expect(db.query("SELECT scope FROM claims").all()).toEqual([
		{ scope: "other" },
	]);
	const event = db.query("SELECT payload FROM events").get() as {
		payload: string;
	};
	expect(JSON.parse(event.payload)).toMatchObject({
		work: "W1",
		project: "project",
		by: "old",
		reason: "owner-release",
	});
	expect(
		releaseWorkClaim(db, expected, { by: "old", reason: "owner-release" }),
	).toBe(false);
	expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
});

test.each(["transfer", "renewal", "terminal", "missing"])(
	"stale %s observation cannot release or emit success",
	(race) => {
		const db = fixture();
		if (race === "transfer")
			db.run("UPDATE work_items SET owner_sid='new',updated_at=101");
		if (race === "renewal") db.run("UPDATE work_items SET updated_at=101");
		if (race === "terminal") db.run("UPDATE work_items SET state='DONE'");
		if (race === "missing") db.run("DELETE FROM work_items");
		expect(
			releaseWorkClaim(db, expected, {
				by: "operator",
				reason: "operator-reclaim",
			}),
		).toBe(false);
		expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
			n: 0,
		});
		expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({
			n: 2,
		});
	},
);

test("another process transferring the claim wins against stale owner release", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-release-race-"));
	directories.push(dir);
	const path = join(dir, "claims.sqlite");
	const db = fixture(path);
	const child = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`import {Database} from "bun:sqlite";const db=new Database(${JSON.stringify(path)});db.run("UPDATE work_items SET owner_sid='new',updated_at=101");db.close();`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	expect(
		releaseWorkClaim(db, expected, { by: "old", reason: "owner-release" }),
	).toBe(false);
	expect(db.query("SELECT owner_sid FROM work_items").get()).toEqual({
		owner_sid: "new",
	});
});

test("another active item retains its same-owner work-graph scope claim", () => {
	const db = fixture();
	db.run(
		"INSERT INTO work_items VALUES ('other-project','W2','RUNNING','old','src',101)",
	);
	expect(
		releaseWorkClaim(db, expected, {
			by: "operator",
			reason: "operator-reclaim",
		}),
	).toBe(true);
	expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 2 });
});

test("unrelated same-owner same-scope intent survives owner release", () => {
	const db = fixture();
	db.run("UPDATE claims SET intent='editing unrelated' WHERE scope='src'");
	expect(
		releaseWorkClaim(db, expected, { by: "old", reason: "owner-release" }),
	).toBe(true);
	expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 2 });
});

test("legacy item-intent claims are scoped to the item without deleting cross-project ambiguity", () => {
	const db = fixture();
	db.run(
		"INSERT INTO claims VALUES ('old','legacy','W1 editing'),('old','other-item','W10 editing')",
	);
	expect(
		releaseWorkClaim(db, expected, {
			by: "operator",
			reason: "operator-reclaim",
		}),
	).toBe(true);
	expect(db.query("SELECT scope FROM claims ORDER BY scope").all()).toEqual([
		{ scope: "other" },
		{ scope: "other-item" },
	]);
});

test("legacy same-id claim is retained when another project still owns it", () => {
	const db = fixture();
	db.run(
		"INSERT INTO work_items VALUES ('other-project','W1','CLAIMED','old','other-src',101)",
	);
	db.run("INSERT INTO claims VALUES ('old','legacy','W1 editing')");
	expect(
		releaseWorkClaim(db, expected, {
			by: "operator",
			reason: "operator-reclaim",
		}),
	).toBe(true);
	expect(db.query("SELECT scope FROM claims ORDER BY scope").all()).toEqual([
		{ scope: "legacy" },
		{ scope: "other" },
	]);
});

test("claims/events failure rolls back release instead of publishing partial success", () => {
	const db = fixture();
	db.run(
		"CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event failure'); END",
	);
	expect(() =>
		releaseWorkClaim(db, expected, { by: "old", reason: "owner-release" }),
	).toThrow("event failure");
	expect(db.query("SELECT state,owner_sid FROM work_items").get()).toEqual({
		state: "CLAIMED",
		owner_sid: "old",
	});
	expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 2 });
});

test("authoritative remote transaction failure propagates without local fallback", () => {
	const db = fixture();
	const store: GovernorStore = {
		local: false,
		query: (sql) => db.query(sql),
		run: (sql, ...params) => db.run(sql, ...(params as never[])),
		close: () => {},
		transaction: () => () => {
			throw new Error("remote transaction unavailable");
		},
	};
	expect(() =>
		releaseWorkClaim(store, expected, { by: "old", reason: "owner-release" }),
	).toThrow("remote transaction unavailable");
	expect(db.query("SELECT state FROM work_items").get()).toEqual({
		state: "CLAIMED",
	});
	expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
});

test("remote transaction rollback after executing its body leaves no release receipt", () => {
	const db = fixture();
	const store: GovernorStore = {
		local: false,
		query: (sql) => db.query(sql),
		run: (sql, ...params) => db.run(sql, ...(params as never[])),
		close: () => {},
		transaction: <T>(fn: () => T) =>
			db.transaction(() => {
				fn();
				throw new Error("remote commit refused");
			}),
	};
	expect(() =>
		releaseWorkClaim(store, expected, { by: "old", reason: "owner-release" }),
	).toThrow("remote commit refused");
	expect(db.query("SELECT state FROM work_items").get()).toEqual({
		state: "CLAIMED",
	});
	expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 2 });
	expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
});

test("CLI scoped orphan listing and expected-owner reclaim preserve other claims", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-release-cli-"));
	directories.push(root);
	const call = (...args: string[]) =>
		Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../hooks/bin/work.ts"),
				...args,
			],
			{
				cwd: root,
				env: { ...process.env, HOME: root, GOVERNOR_STORE_URL: "local" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	const ids = ["first", "second"].map((title) => {
		const result = call("add", title);
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		return result.stdout.toString().match(/W\d+/)?.[0] ?? "";
	});
	for (const [index, id] of ids.entries())
		expect(call("take", id, "--as", `owner${index}`).exitCode).toBe(0);
	const scoped = call("orphaned", "--item", ids[0], "--json");
	expect(scoped.exitCode, scoped.stderr.toString()).toBe(0);
	expect(
		JSON.parse(scoped.stdout.toString()).map((row: { id: string }) => row.id),
	).toEqual([ids[0]]);
	expect(call("reclaim", ids[0], "--expect-owner", "owner1").exitCode).not.toBe(
		0,
	);
	expect(call("reclaim", ids[0], "--expect-owner", "owner0").exitCode).toBe(0);
	expect(
		JSON.parse(call("show", ids[1], "--json").stdout.toString()).state,
	).toBe("CLAIMED");
	// W613: the bulk sweep is confirmatory — dead ×3 consecutive passes before
	// the release fires (one-shot reclaims stay the per-item path above). The
	// streak persists in the store, so separate CLI invocations accumulate.
	expect(call("reclaim", "all").exitCode).toBe(0);
	expect(
		JSON.parse(call("show", ids[1], "--json").stdout.toString()).state,
	).toBe("CLAIMED");
	expect(call("reclaim", "all").exitCode).toBe(0);
	expect(
		JSON.parse(call("show", ids[1], "--json").stdout.toString()).state,
	).toBe("CLAIMED");
	expect(call("reclaim", "all").exitCode).toBe(0);
	expect(
		JSON.parse(call("show", ids[1], "--json").stdout.toString()).state,
	).toBe("READY");
});

test("authoritative remote guarded release is one transaction and refused guard changes nothing", async () => {
	const home = mkdtempSync(join(tmpdir(), "work-release-remote-"));
	directories.push(home);
	const reservation = Bun.serve({
		port: 0,
		fetch: () => new Response("fixture"),
	});
	const port = reservation.port;
	reservation.stop(true);
	const server = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "../hooks/bin/store-server.ts"),
			"--port",
			String(port),
		],
		{
			env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: "local" },
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	try {
		const url = `http://127.0.0.1:${port}`;
		let ready = false;
		for (let n = 0; n < 100; n++) {
			try {
				if ((await fetch(`${url}/health`)).ok) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(20);
		}
		expect(ready).toBe(true);
		const { HttpGovernorStore } = await import("../hooks/lib/govdb.ts");
		const store = new HttpGovernorStore(url, null);
		store
			.query(
				"INSERT INTO work_items(project,id,title,state,owner_sid,scope,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
			)
			.run("project", "W1", "fixture", "CLAIMED", "old", "src", 100, 100);
		store
			.query("INSERT INTO claims(sid,scope,intent,ts) VALUES (?,?,?,?)")
			.run("old", "src", "work-graph", 100);
		const { acquireLaunchLease, releaseFailedLaunch } = await import(
			"../scripts/lib/launch-preflight.ts"
		);
		acquireLaunchLease(store, "project", "old", "nonce");
		const before = {
			claims: store.query("SELECT * FROM claims").all(),
			events: store.query("SELECT * FROM events").all(),
			item: store
				.query(
					"SELECT state,owner_sid,updated_at FROM work_items WHERE project=? AND id=?",
				)
				.get("project", "W1"),
		};
		expect(
			releaseFailedLaunch(store, {
				project: "project",
				item: "W1",
				sid: "old",
				revision: 100,
				nonce: "wrong-generation",
			}),
		).toBe(false);
		expect({
			claims: store.query("SELECT * FROM claims").all(),
			events: store.query("SELECT * FROM events").all(),
			item: store
				.query(
					"SELECT state,owner_sid,updated_at FROM work_items WHERE project=? AND id=?",
				)
				.get("project", "W1"),
		}).toEqual(before);
		expect(
			releaseFailedLaunch(store, {
				project: "project",
				item: "W1",
				sid: "old",
				revision: 100,
				nonce: "nonce",
			}),
		).toBe(true);
		expect(
			store
				.query(
					"SELECT state,owner_sid FROM work_items WHERE project=? AND id=?",
				)
				.get("project", "W1"),
		).toEqual({ state: "READY", owner_sid: null });
		expect(store.query("SELECT * FROM claims").all()).toHaveLength(0);
		expect(
			store.query("SELECT kind FROM events WHERE kind='work.released'").all(),
		).toHaveLength(1);
		store.close();
	} finally {
		server.kill("SIGKILL");
		await server.exited;
	}
}, 30000);
