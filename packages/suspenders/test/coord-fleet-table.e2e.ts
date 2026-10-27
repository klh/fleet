// coord-fleet-table.test.ts — W1258: `coord fleet` text face = the
// fixed-width fleet table (hooks/coord/fleet-table.ts — the W892 report
// style), --njson = one lane entry per NDJSON line, --json unchanged.
// Unit face: pure builder + glyph. CLI face: the coord-fleet-honesty
// recipe — temp HOME, every DB open + CLI run in a bun subprocess.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFleetTable, fleetGlyph } from "../hooks/coord/fleet-table.ts";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");
const fx = cliFixture("w1258-fleet-table", {
	env: { GOVERNOR_STORE_URL: "local" },
});

test.afterAll(() => fx.cleanup());

// fleet lesson coord-child-store-binding: spawned coord children inherit
// GOVERNOR_STORE_URL — without the pin a lane env's store URL silently
// rebinds openStore() onto the REAL fleet store despite the temp HOME.
// The fixture env above carries the pin; childEnv covers the standalone
// home2 spawn in the empty-fleet leg.
const childEnv = (h: string): NodeJS.ProcessEnv => ({
	...process.env,
	HOME: h,
	GOVERNOR_STORE_URL: "local",
});

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

const runIn = (code: string): string => fx.seed(code);

const rowFor = (out: string, needle: string): string | undefined =>
	out.split("\n").find((line) => line.includes(needle));

// seed: two RUNNING sessions + claims (one with a W293 name tag), a
// `lane.<sid>.state` fact for the state-glyph branch, and integration.head
const now = Date.now();
runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = ${now};
db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state, tags) VALUES ('w1258-named-lane-aaaa', 'w1258-proj', 'worker', ?, ?, 'RUNNING', '{\\"name\\":\\"w1258 table lane\\"}')").run(now, now);
db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('w1258-plain-lane-bbbb', 'w1258-proj', 'worker', ?, ?, 'RUNNING')").run(now, now);
db.query("INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('w1258-named-lane-aaaa', 'w1258-scope', 'W1258 table render', 0, ?)").run(now);
db.query("INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('w1258-plain-lane-bbbb', 'w1258-scope', 'W1258 second lane doing table work', 0, ?)").run(now);
db.query("INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.w1258-named-lane-aaaa.state', 'PAUSED', 'w1258-test', 1, ?)").run(now);
db.query("INSERT INTO facts (key, value, source, version, ts) VALUES ('integration.head', 'deadbeefcafebabe0123456789abcdef01234567', 'w1258-test', 1, ?)").run(now);
db.close();
`);

test("unit: fleetGlyph vocabulary", () => {
	expect(fleetGlyph("dead", undefined)).toBe("×");
	expect(fleetGlyph("unknown", undefined)).toBe("?");
	expect(fleetGlyph("alive", "PAUSE_REQUESTED")).toBe("◐");
	expect(fleetGlyph("alive", "PAUSED")).toBe("⏸");
	expect(fleetGlyph("alive", "RESUME_READY")).toBe("↻");
	expect(fleetGlyph("alive", "BLOCKED")).toBe("⚠");
	expect(fleetGlyph("alive", undefined)).toBe("▶");
});

test("unit: buildFleetTable pads, caps and rows", () => {
	const long = "a-very-long-lane-label-beyond-the-house-cap";
	const out = buildFleetTable([
		{ lane: long, st: "?", task: "x".repeat(40), sid: "sid-long-xxxxxxxx" },
		{ lane: "short", st: "▶", task: "", sid: "sid2" },
	]);
	const lines = out.split("\n");
	// header row + per-column dash separator, report style
	expect(lines[0].trim().split(/\s{2,}/)).toEqual([
		"LANE",
		"ST",
		"TASK",
		"SID",
	]);
	expect(lines[1].trim()).toMatch(/^-+(\s{2}-+)+$/);
	// every line is fixed-width — programmatic pads, no drift
	expect(new Set(lines.map((l) => l.length)).size).toBe(1);
	// ST glyphs align across rows (same column offset)
	const r1 = rowFor(out, "sid-long") ?? "";
	const r2 = rowFor(out, "[sid=sid2]") ?? "";
	expect(r1.indexOf("?")).toBe(r2.indexOf("▶"));
	// LANE truncates with the ellipsis at the house cap 24
	expect(out).toContain(`${long.slice(0, 23)}…`);
	expect(out).not.toContain(long);
	// TASK slices at the report cap 26, no ellipsis, empty renders "-"
	expect(out).toContain("x".repeat(26));
	expect(out).not.toContain("x".repeat(27));
	expect(r2).toContain(" -");
	// one row per lane, [sid=...] recipient field per row
	expect(r1).toContain("[sid=sid-long-xxxxxxxx]");
	expect(r2).toContain("[sid=sid2]");
});

test("unit: painted glyphs measure by visible width, not escape bytes", () => {
	const ESC = String.fromCharCode(27);
	const painted = `${ESC}[32m▶${ESC}[0m`;
	const out = buildFleetTable([{ lane: "l", st: painted, task: "", sid: "s" }]);
	const lines = out.split("\n");
	// ST column width = header (2), not the escape-inflated length — the
	// separator's ST dash run stays "--" and rows stay VISIBLY aligned
	// (cli-table3 pads ANSI-aware, so raw line lengths differ by the escapes)
	expect(lines[1]).toContain("  --  ");
	const strip = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
	const visible = (s: string): number => s.replace(strip, "").length;
	expect(new Set(lines.map((l) => visible(l))).size).toBe(1);
	expect(rowFor(out, "[sid=s]") ?? "").toContain(painted);
});

test("text face: table with HEAD line, name column, state glyph", () => {
	const { code, out, err } = runCli(["fleet"]);
	expect(code).toBe(0);
	expect(err).toBe("");
	expect(out).toContain("HEAD deadbee");
	const lines = out.trim().split("\n");
	// HEAD, then header, then separator, then one row per lane
	expect(lines[1].trim().split(/\s{2,}/)).toEqual([
		"LANE",
		"ST",
		"TASK",
		"SID",
	]);
	const named = rowFor(out, "[sid=w1258-named-lane-aaaa]") ?? "";
	expect(named).toContain("w1258 table lane"); // LANE = the W293 name
	expect(named).toContain("W1258 table r…"); // TASK = claim intent (cap 14)
	expect(named).toContain("⏸"); // lane.<sid>.state fact = PAUSED
	const plain = rowFor(out, "[sid=w1258-plain-lane-bbbb]") ?? "";
	expect(plain).toContain("W1258 second …"); // LANE = intent fallback
	expect(plain).toContain("▶"); // no state fact, fresh hb → alive
});

test("--njson: one lane entry per line, parity with --json", () => {
	const nj = runCli(["fleet", "--njson"]);
	const js = runCli(["fleet", "--json"]);
	expect(nj.code).toBe(0);
	expect(js.code).toBe(0);
	const nlines = nj.out.trim().split("\n");
	expect(nlines.length).toBe(2);
	const nlanes = nlines.map((l) => JSON.parse(l) as { sid: string });
	expect(nlanes.map((l) => l.sid)).toEqual([
		"w1258-named-lane-aaaa",
		"w1258-plain-lane-bbbb",
	]);
	const jlanes = (JSON.parse(js.out) as { lanes: { sid: string }[] }).lanes;
	expect(nlanes).toEqual(jlanes); // same laneEntry projection
	expect(nj.out).not.toContain("\n\n");
});

test("empty fleet renders the placeholder, never a table", () => {
	// an untouched HOME — openGovernorDb migrates it, cmdFleet prints only
	// the dim placeholder line
	const home2 = mkdtempSync(join(tmpdir(), "suspenders-w1258-empty-"));
	try {
		// openStore() migrates the fresh HOME on demand — cmdFleet prints only
		// the dim placeholder line
		const p = Bun.spawnSync(["bun", COORD, "fleet"], {
			env: childEnv(home2),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.exitCode).toBe(0);
		const out = new TextDecoder().decode(p.stdout);
		expect(out).toContain("(no claimed lanes)");
		expect(out).not.toContain("LANE");
	} finally {
		rmSync(home2, { recursive: true, force: true });
	}
});
