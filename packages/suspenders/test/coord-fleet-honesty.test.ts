// coord-fleet-honesty.test.ts — W378: the fleet view never paints an
// unevidenced claim as running. Recipe: coord-reads.test.ts (temp HOME,
// every DB open + CLI run in a bun subprocess). Registry joins can't hit
// these synthetic sids (no prefix relation to real registry rows), so each
// claimant rides the W610 claimant probe: fresh governor heartbeat → alive,
// everything else → unknown (never ▶, never ×).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-w378-fleet-test-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const runCli = (args: string[]): { code: number; out: string; err: string } => {
	const p = Bun.spawnSync(["bun", COORD, ...args], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};

const runIn = (code: string): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

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

// the fleet line is ONE line of `glyph label` segments joined by two spaces
const segmentFor = (out: string, needle: string): string | undefined =>
	out
		.trim()
		.split(/\s{2,}/)
		.find((seg) => seg.includes(needle));

describe("coord fleet honesty (W378)", () => {
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
		const seg = segmentFor(out, "W378 stale");
		expect(seg).toBeDefined();
		expect(seg?.trim().startsWith("?")).toBe(true);
		expect(seg?.includes("▶")).toBe(false);
		expect(seg?.includes("×")).toBe(false);
		expect(err).toBe("");
	});

	test("fresh-heartbeat claimant keeps ▶", () => {
		const { code, out } = runCli(["fleet"]);
		expect(code).toBe(0);
		const seg = segmentFor(out, "W378 fresh");
		expect(seg).toBeDefined();
		expect(seg?.trim().startsWith("▶")).toBe(true);
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
