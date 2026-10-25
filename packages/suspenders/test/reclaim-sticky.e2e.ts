// W831 kill-path safety — the reclaim sticky marker + gate. A reclaim stamps
// a sticky-until-resume marker (reason user|crash) inside the release
// transaction; the next successful claim clears it (resume convergence). The
// manual reclaim shares the bulk pass's liveness truth: a verifiably-live
// claimant refuses unless forced, and a crash reason demands death evidence.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearReclaimMarker,
	markReclaimed,
	parseReclaimReason,
	readReclaimMarker,
	reclaimGateDecision,
} from "../hooks/lib/lanes/reclaim-sticky.ts";
import { releaseWorkClaim } from "../hooks/lib/work/work-release.ts";
import { assignTask } from "../hooks/lib/work/work-alloc.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
test.describe({ tag: "@unit" }, () => {

const databases: Database[] = [];
const directories: string[] = [];
test.afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// the tables the three modules touch: facts (marker), work_items/claims/
// events (release + claim txs) + work_deps (assignTask's dep gate)
function fixture(): GovernorStore {
	const db = new Database(":memory:");
	databases.push(db);
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, state TEXT, owner_sid TEXT, scope TEXT, updated_at INTEGER, alloc_reason TEXT, origin TEXT, claim_token_hash TEXT, result_sha TEXT, PRIMARY KEY(project, id))",
	);
	db.run(
		"CREATE TABLE claims(sid TEXT, scope TEXT, intent TEXT, hot INTEGER, ts INTEGER, tp TEXT)",
	);
	db.run(
		"CREATE TABLE events(ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	db.run("CREATE TABLE work_deps(work_id TEXT, project TEXT, depends_on TEXT)");
	db.run(
		"INSERT INTO work_items VALUES ('p','W1','CLAIMED','o1','src',100,NULL,NULL,NULL,NULL)",
	);
	return {
		local: true,
		query: (sql) => db.query(sql),
		run: (sql, ...params) => db.run(sql, ...(params as never[])),
		transaction: <T>(fn: () => T) => db.transaction(fn),
		close: () => db.close(),
	};
}

test("parseReclaimReason: user/crash pass, junk and undefined refuse", () => {
	expect(parseReclaimReason("user")).toBe("user");
	expect(parseReclaimReason("crash")).toBe("crash");
	expect(parseReclaimReason("USER")).toBe(null);
	expect(parseReclaimReason("junk")).toBe(null);
	expect(parseReclaimReason(undefined)).toBe(null);
});

test("marker round-trips; latest write wins; corrupted rows read null", () => {
	const s = fixture();
	markReclaimed(s, "p", "W1", "crash", "o1");
	expect(readReclaimMarker(s, "p", "W1")).toEqual({
		reason: "crash",
		from: "o1",
		at: expect.any(Number),
	});
	clearReclaimMarker(s, "p", "W1");
	expect(readReclaimMarker(s, "p", "W1")).toBe(null);
	markReclaimed(s, "p", "W1", "user", "o2");
	markReclaimed(s, "p", "W1", "crash", "o3");
	expect(readReclaimMarker(s, "p", "W1")?.from).toBe("o3");
	s.run("UPDATE facts SET value = '{\"reason\":42}' WHERE key LIKE '%W1'");
	expect(readReclaimMarker(s, "p", "W1")).toBe(null);
});

// the CAS observation the release gateway matches against — owner tracks each
// UPDATE, or the transaction refuses and no marker lands
const obs = (state: string, owner: string, updatedAt: number) => ({
	project: "p",
	id: "W1",
	owner,
	state,
	updatedAt,
});

test("operator-reclaim stamps the user marker; non-matching CAS releases nothing", () => {
	const s = fixture();
	expect(
		releaseWorkClaim(s, obs("CLAIMED", "o1", 100), {
			by: "op",
			reason: "operator-reclaim",
		}),
	).toBe(true);
	expect(readReclaimMarker(s, "p", "W1")?.reason).toBe("user");
	expect(
		releaseWorkClaim(s, obs("CLAIMED", "o1", 100), {
			by: "op",
			reason: "owner-release",
		}),
	).toBe(false);
	expect(readReclaimMarker(s, "p", "W1")?.reason).toBe("user");
});

test("bulk reclaim-all stamps crash with the claimant; owner-release stamps none", () => {
	const s = fixture();
	s.run(
		"UPDATE work_items SET state='CLAIMED', owner_sid='o2', updated_at=101",
	);
	expect(
		releaseWorkClaim(s, obs("CLAIMED", "o2", 101), {
			by: "reclaim-all",
			reason: "reclaim-all",
		}),
	).toBe(true);
	const crash = readReclaimMarker(s, "p", "W1");
	expect(crash?.reason).toBe("crash");
	expect(crash?.from).toBe("o2");
	// the owner's own give-up is not a reclaim — no NEW stamp, but the crash
	// marker from the bulk pass is sticky and survives until a resume
	s.run(
		"UPDATE work_items SET state='CLAIMED', owner_sid='o3', updated_at=102",
	);
	expect(
		releaseWorkClaim(s, obs("CLAIMED", "o3", 102), {
			by: "o3",
			reason: "owner-release",
		}),
	).toBe(true);
	expect(readReclaimMarker(s, "p", "W1")?.reason).toBe("crash");
});

test("reclaim gate: alive refuses unless forced; crash demands dead evidence", () => {
	expect(reclaimGateDecision("alive", "user", false).ok).toBe(false);
	expect(reclaimGateDecision("alive", "user", true).ok).toBe(true);
	expect(reclaimGateDecision("alive", "crash", true).ok).toBe(false);
	expect(reclaimGateDecision("unknown", "user", false).ok).toBe(true);
	expect(reclaimGateDecision("unknown", "crash", false).ok).toBe(false);
	expect(reclaimGateDecision("dead", "crash", false).ok).toBe(true);
	expect(reclaimGateDecision("dead", "user", false).ok).toBe(true);
});

test("resume convergence: the next successful claim clears the marker", () => {
	const s = fixture();
	markReclaimed(s, "p", "W1", "crash", "o1");
	// assignTask needs READY; the reclaimed row is READY with the marker set
	s.run("UPDATE work_items SET state='READY', owner_sid=NULL, updated_at=101");
	const out = assignTask(s, "p", {
		id: "W1",
		sid: "resume-1",
		reason: "manual",
	});
	expect(out.ok).toBe(true);
	expect(readReclaimMarker(s, "p", "W1")).toBe(null);
});

test("CLI: reclaim stamps the user marker; crash reason refuses; re-take clears", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-reclaim-sticky-"));
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
	const added = call("add", "sticky lane item");
	expect(added.exitCode, added.stderr.toString()).toBe(0);
	const id = added.stdout.toString().match(/W\d+/)?.[0] ?? "";
	expect(call("take", id, "--as", "lane-a").exitCode).toBe(0);
	// no lane registry in the fixture cwd → verdict unknown → the attended
	// user reclaim proceeds and stamps the sticky-until-resume marker
	const reclaimed = call("reclaim", id);
	expect(reclaimed.exitCode, reclaimed.stderr.toString()).toBe(0);
	const marker = () => {
		const db = new Database(join(root, ".cache/claude-governor/governor.db"));
		const row = db
			.query(
				"SELECT COUNT(*) AS n FROM facts WHERE key LIKE 'reclaim.reason.%'",
			)
			.get() as { n: number };
		db.close();
		return row.n;
	};
	expect(marker()).toBe(1);
	// the same claim, claimed as a crash: no death evidence → refused, and a
	// refusal must not stamp anything
	expect(call("reclaim", id, "--reason", "crash").exitCode).not.toBe(0);
	expect(marker()).toBe(1);
	// resume convergence end-to-end: the re-take clears the sticky marker
	expect(call("take", id, "--as", "lane-b").exitCode).toBe(0);
	expect(marker()).toBe(0);
});

});
