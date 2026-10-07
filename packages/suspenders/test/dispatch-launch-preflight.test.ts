import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveLaneExecutor,
	releaseFailedLaunch,
	acquireLaunchLease,
	renewLaunchLease,
	releaseLaunchLease,
} from "../scripts/lib/launch-preflight.ts";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
	const d = mkdtempSync(join(tmpdir(), "executor-preflight-"));
	dirs.push(d);
	return d;
};
const executable = (p: string) => {
	writeFileSync(p, "#!/bin/sh\nexit 0\n");
	chmodSync(p, 0o700);
	return p;
};
test("stripped PATH resolves canonical local executor", () => {
	const h = home();
	mkdirSync(join(h, ".local/bin"), { recursive: true });
	const p = executable(join(h, ".local/bin/claude"));
	expect(
		resolveLaneExecutor("claude", { HOME: h, PATH: "/usr/bin:/bin" }),
	).toBe(p);
});
test("configured absolute executor wins and missing configured binary fails closed", () => {
	const h = home();
	const p = executable(join(h, "custom-claude"));
	expect(
		resolveLaneExecutor("claude", {
			HOME: h,
			PATH: "",
			SUSPENDERS_CLAUDE_BIN: p,
		}),
	).toBe(p);
	expect(
		resolveLaneExecutor("claude", {
			HOME: h,
			PATH: "",
			SUSPENDERS_CLAUDE_BIN: join(h, "missing"),
		}),
	).toBeNull();
	expect(
		resolveLaneExecutor("claude", {
			HOME: h,
			PATH: "",
			SUSPENDERS_CLAUDE_BIN: "relative",
		}),
	).toBeNull();
});
test("missing executor never guesses an unbounded installation tree", () => {
	expect(
		resolveLaneExecutor("copilot", { HOME: home(), PATH: "/nonexistent" }),
	).toBeNull();
});
test("codex configured executor uses the same authoritative bounded resolution", () => {
	const h = home(),
		p = executable(join(h, "codex"));
	expect(
		resolveLaneExecutor("codex", {
			HOME: h,
			PATH: "",
			SUSPENDERS_CODEX_BIN: p,
		}),
	).toBe(p);
	expect(
		resolveLaneExecutor("codex", {
			HOME: h,
			PATH: "",
			SUSPENDERS_CODEX_BIN: join(h, "missing"),
		}),
	).toBeNull();
});
function dbFixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,state TEXT,owner_sid TEXT,scope TEXT,updated_at INTEGER,PRIMARY KEY(project,id))",
	);
	db.run("CREATE TABLE claims(sid TEXT,scope TEXT,intent TEXT)");
	db.run(
		"CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	db.run(
		"INSERT INTO work_items VALUES ('project','W1','CLAIMED','lane','src',100)",
	);
	db.run(
		"INSERT INTO claims VALUES ('lane','src','work-graph'),('other','other-src','work-graph')",
	);
	return db;
}
test("failed launch releases only its exact claim revision", () => {
	const db = dbFixture();
	expect(
		releaseFailedLaunch(db, {
			project: "project",
			item: "W1",
			sid: "lane",
			revision: 100,
		}),
	).toBe(true);
	expect(db.query("SELECT state,owner_sid FROM work_items").get()).toEqual({
		state: "READY",
		owner_sid: null,
	});
	expect(db.query("SELECT sid FROM claims").all()).toEqual([{ sid: "other" }]);
	db.close();
});
test("concurrent ownership transfer and same-owner renewal survive cleanup", () => {
	const db = dbFixture();
	db.run("UPDATE work_items SET owner_sid='other',updated_at=101");
	expect(
		releaseFailedLaunch(db, {
			project: "project",
			item: "W1",
			sid: "lane",
			revision: 100,
		}),
	).toBe(false);
	db.run("UPDATE work_items SET owner_sid='lane',updated_at=102");
	expect(
		releaseFailedLaunch(db, {
			project: "project",
			item: "W1",
			sid: "lane",
			revision: 100,
		}),
	).toBe(false);
	expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 2 });
	db.close();
});

test("launch lease serializes dispatch and replaced nonce cannot release winner", () => {
	const db = dbFixture();
	expect(acquireLaunchLease(db, "project", "lane", "old", 0)).toBe(true);
	expect(acquireLaunchLease(db, "project", "lane", "peer", 1)).toBe(false);
	expect(acquireLaunchLease(db, "project", "lane", "new", 600_001)).toBe(true);
	expect(renewLaunchLease(db, "project", "lane", "old")).toBe(false);
	expect(
		releaseFailedLaunch(db, {
			project: "project",
			item: "W1",
			sid: "lane",
			revision: 100,
			nonce: "old",
		}),
	).toBe(false);
	releaseLaunchLease(db, "project", "lane", "old");
	expect(db.query("SELECT nonce FROM lane_launch_leases").get()).toEqual({
		nonce: "new",
	});
	expect(db.query("SELECT state FROM work_items").get()).toEqual({
		state: "CLAIMED",
	});
	db.close();
});

test("failed launch preserves unrelated and shared-scope claims under same owner", () => {
	const db = dbFixture();
	db.run(
		"INSERT INTO work_items VALUES ('project','W2','RUNNING','lane','src',200)",
	);
	db.run(
		"INSERT INTO claims VALUES ('lane','src','W1 mission'),('lane','src','W10 mission'),('lane','src','review unrelated')",
	);
	expect(
		releaseFailedLaunch(db, {
			project: "project",
			item: "W1",
			sid: "lane",
			revision: 100,
		}),
	).toBe(true);
	expect(
		db
			.query("SELECT intent FROM claims WHERE sid='lane' ORDER BY intent")
			.all(),
	).toEqual([
		{ intent: "W10 mission" },
		{ intent: "review unrelated" },
		{ intent: "work-graph" },
	]);
	expect(db.query("SELECT state FROM work_items WHERE id='W2'").get()).toEqual({
		state: "RUNNING",
	});
});
test("same item id in another project prevents ambiguous claim deletion", () => {
	const db = dbFixture();
	db.run(
		"INSERT INTO work_items VALUES ('other-project','W1','CLAIMED','lane','src',200)",
	);
	db.run("INSERT INTO claims VALUES ('lane','src','W1 other project mission')");
	expect(
		releaseFailedLaunch(db, {
			project: "project",
			item: "W1",
			sid: "lane",
			revision: 100,
		}),
	).toBe(true);
	expect(
		db
			.query("SELECT intent FROM claims WHERE sid='lane' ORDER BY intent")
			.all(),
	).toEqual([{ intent: "W1 other project mission" }, { intent: "work-graph" }]);
	expect(
		db
			.query(
				"SELECT state,owner_sid FROM work_items WHERE project='other-project'",
			)
			.get(),
	).toEqual({ state: "CLAIMED", owner_sid: "lane" });
});
