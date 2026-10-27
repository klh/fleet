// coord-fleet-honesty.test.ts — W378: the fleet view never paints an
// unevidenced claim as running. Recipe: coord-reads.test.ts (temp HOME,
// every DB open + CLI run in a bun subprocess). Registry joins can't hit
// these synthetic sids (no prefix relation to real registry rows), so each
// claimant rides the W610 claimant probe: fresh governor heartbeat → alive,
// everything else → unknown (never ▶, never ×).
import { expect, test } from "./pw";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");
const fx = cliFixture("w378-fleet-honesty");

test.afterAll(() => fx.cleanup());

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

const runIn = (code: string): string => fx.seed(code);

// seed: one stale unregistered claimant (RUNNING, hb 40min old), one fresh
// one, one CLOSED claimant. hb 40min: stale past the 30-min LIVE_HB_MS
// window hbFresh trusts, with no transcript under the temp HOME to rescue.
const now = Date.now();
runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = ${now};
db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('stale-claimant-aaaa', 'w378-proj', 'worker', ?, ?, 'RUNNING')").run(now - 40 * 60_000, now - 40 * 60_000);
db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('fresh-claimant-bbbb', 'w378-proj', 'worker', ?, ?, 'RUNNING')").run(now, now);
db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('closed-claimant-cccc', 'w378-proj', 'worker', ?, ?, 'CLOSED')").run(now - 40 * 60_000, now - 40 * 60_000);
db.query("INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('stale-claimant-aaaa', 'w378-proj', 'W378 stale', 0, ?)").run(now);
db.query("INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('fresh-claimant-bbbb', 'w378-proj', 'W378 fresh', 0, ?)").run(now);
db.query("INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('closed-claimant-cccc', 'w378-proj', 'W378 closed', 0, ?)").run(now);
db.close();
`);

// W1258: the fleet text face is the fixed-width table — one lane per ROW;
// honesty assertions read the row carrying the lane's [sid=...] field
const segmentFor = (out: string, needle: string): string | undefined =>
	out.split("\n").find((line) => line.includes(needle));

test.describe("coord fleet honesty (W378)", () => {
	test("registered work owners and target sessions need no file claim to be discoverable", () => {
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = Date.now();
for (const [sid,state,hb] of [['work-only-owner','RUNNING',now],['session-only-peer','RUNNING',now],['closed-work-owner','CLOSED',now],['stale-work-owner','RUNNING',now-3600000]]) {
 db.query("INSERT INTO sessions (sid,project,role,started_at,hb,state) VALUES (?,'work-project','worker',?,?,?)").run(sid,now,hb,state);
}
for (const [id,sid,project] of [['W41','work-only-owner','work-project'],['W42','closed-work-owner','work-project'],['W43','stale-work-owner','work-project'],['W44','work-only-owner','foreign-project']]) {
 db.query("INSERT INTO work_items(project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,'CLAIMED',?,?,?)").run(project,id,'Owned '+id,sid,now,now);
}
db.close();`);
		const fleet = runCli(["fleet", "--json"]);
		const targets = runCli(["targets", "--json"]);
		expect(fleet.code).toBe(0);
		expect(targets.code).toBe(0);
		const lanes = JSON.parse(fleet.out).lanes;
		const owner = lanes.find(
			(row: { sid: string }) => row.sid === "work-only-owner",
		);
		expect(owner).toBeDefined();
		expect(owner.live).toBe(true);
		expect(owner.fileClaims).toEqual([]);
		expect(owner.workItems.map((row: { id: string }) => row.id)).toEqual([
			"W41",
		]);
		const targetSids = JSON.parse(targets.out).map(
			(row: { sid: string }) => row.sid,
		);
		for (const sid of ["work-only-owner", "session-only-peer"])
			expect(lanes.some((row: { sid: string }) => row.sid === sid)).toBe(
				targetSids.includes(sid),
			);
		for (const sid of ["closed-work-owner", "stale-work-owner"]) {
			const row = lanes.find((entry: { sid: string }) => entry.sid === sid);
			expect(row.live).toBe(false);
			expect(row.verdict).toBe("unknown");
		}
		expect(
			lanes.find((row: { sid: string }) => row.sid === "closed-work-owner")
				.sessionState,
		).toBe("CLOSED");
	});

	test("stale unregistered claimant reads ?, never ▶", () => {
		const { code, out, err } = runCli(["fleet"]);
		expect(code).toBe(0);
		const row = segmentFor(out, "W378 stale");
		expect(row).toBeDefined();
		expect(row?.includes("?")).toBe(true);
		expect(row?.includes("▶")).toBe(false);
		expect(row?.includes("×")).toBe(false);
		expect(err).toBe("");
	});

	test("fresh-heartbeat claimant keeps ▶", () => {
		const { code, out } = runCli(["fleet"]);
		expect(code).toBe(0);
		const row = segmentFor(out, "W378 fresh");
		expect(row).toBeDefined();
		expect(row?.includes("▶")).toBe(true);
	});

	test("--json: tri-state verdict + collapsed live", () => {
		const { code, out } = runCli(["fleet", "--json"]);
		expect(code).toBe(0);
		const parsed = JSON.parse(out) as {
			lanes: { sid: string; verdict: string; live: boolean }[];
		};
		const stale = parsed.lanes.find((l) => l.sid === "stale-claimant-aaaa");
		const fresh = parsed.lanes.find((l) => l.sid === "fresh-claimant-bbbb");
		const closed = parsed.lanes.find((l) => l.sid === "closed-claimant-cccc");
		expect(stale?.verdict).toBe("unknown");
		expect(stale?.live).toBe(false);
		expect(fresh?.verdict).toBe("alive");
		expect(fresh?.live).toBe(true);
		expect(closed?.verdict).toBe("unknown");
		expect(closed?.live).toBe(false);
	});
});
