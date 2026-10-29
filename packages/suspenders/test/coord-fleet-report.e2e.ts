// coord-fleet-report.e2e.ts — W1242 (merged W2214): `coord fleet` renders
// the ONE supervisor table through the W892 library (hooks/lib/work/ — the
// same renderer `work report` rides, so the CLI face cannot drift),
// --project <path|name> selects the graph by coord project identity, --json
// stays the machine face (fleet-watch W522 parses lanes[]), and the W1258
// fleet-table lane projection stays honest beneath the table.
// Recipe: coord-fleet-table.e2e.ts / coord-fleet-honesty.e2e.ts (cliFixture:
// temp HOME, every DB open + CLI run in a bun subprocess; the fixture env
// pins GOVERNOR_STORE_URL=local so the operator's real store knob never
// leaks into the fixture).
import { expect, test } from "@playwright/test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";
test.describe("@unit", () => {

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");
const fx = cliFixture("w1242-fleet-report", {
	env: { GOVERNOR_STORE_URL: "local" },
});

test.afterAll(() => fx.cleanup());

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

const runIn = (code: string): string => fx.seed(code);

// table rows start at column 0 (borderless W976 table)
const rowFor = (out: string, id: string): string | undefined =>
	out.split("\n").find((l) => l.startsWith(`${id} `));
const FLEET_COLS = ["ITEM", "ST", "TASK"];

// cwd project = the repo's git-common-dir (realpath'd — tmpdir() hands back
// /var/... while the CLI resolves /private/var/...); a second graph keyed by
// a bare name exercises --project <name> without a second repo on disk.
const PROJECT = `${realpathSync(fx.REPO)}/.git`;
const now = Date.now();
runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = ${now};
db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('w1242-rider-aaaa', ?, 'worker', ?, ?, 'RUNNING')").run(${JSON.stringify(PROJECT)}, now, now);
for (const [id, state, owner] of [
	['W1242A', 'CLAIMED', 'w1242-rider-aaaa'],
	['W1242B', 'READY', null],
	['W1242C', 'DONE', null],
	['W1242D', 'DONE', null],
]) db.query("INSERT INTO work_items (project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(${JSON.stringify(PROJECT)}, id, 'Fleet ' + id, state, owner, now, now);
db.query("INSERT INTO work_items (project,id,title,state,owner_sid,created_at,updated_at) VALUES ('other-project', 'W9001', 'Other fleet item', 'CLAIMED', null, ?, ?)").run(now, now);
db.close();
`);

test("default face: W892 table for the cwd project + fleet-table lanes", () => {
	const { code, out, err } = runCli(["fleet"]);
	expect(code).toBe(0);
	expect(err).toBe("");
	for (const col of FLEET_COLS) expect(out).toContain(col);
	for (const id of ["W1242A", "W1242B", "W1242C", "W1242D"])
		expect(rowFor(out, id), id).toBeDefined();
	expect(rowFor(out, "W9001")).toBeUndefined();
	// attribution absent → the W892 degradation cells (no fake numbers)
	const row = rowFor(out, "W1242A");
	expect(row).toContain("Fleet W1242A");
	// attribution-absent columns stay hidden (unknown ≠ measured 0) — the row
	// carries no fake TOKENS/CACHE spend cells
	expect(row).not.toMatch(/0\s+0m/);
	// the W1258 lane projection (fleet-table SID field) stays beneath the table
	expect(out).toContain("[sid=w1242-rider-aaaa]");
});

test("--project <name> filters the table to that graph", () => {
	const { code, out } = runCli(["fleet", "--project", "other-project"]);
	expect(code).toBe(0);
	expect(rowFor(out, "W9001")).toBeDefined();
	// the lane table stays store-global (W1242 kept the lane line beneath);
	// the REPORT table is what filters — DONE items are report-only
	expect(rowFor(out, "W1242C")).toBeUndefined();
});

test("--project <path> resolves through project identity", () => {
	const { code, out } = runCli(["fleet", "--project", fx.REPO]);
	expect(code).toBe(0);
	expect(rowFor(out, "W1242A")).toBeDefined();
	expect(rowFor(out, "W9001")).toBeUndefined();
});

test("--project dies loud on unknown name and missing path", () => {
	const unknown = runCli(["fleet", "--project", "nosuchproj"]);
	expect(unknown.code).not.toBe(0);
	expect(unknown.err).toContain("no project");
	const missing = runCli([
		"fleet",
		"--project",
		join(fx.REPO, "nope"),
	]);
	expect(missing.code).not.toBe(0);
	expect(missing.err).toContain("no such path");
});

test("--json keeps the machine face (lanes projection)", () => {
	const { code, out } = runCli(["fleet", "--json"]);
	expect(code).toBe(0);
	const parsed = JSON.parse(out) as {
		head: string | null;
		lanes: { sid: string }[];
	};
	expect(Array.isArray(parsed.lanes)).toBe(true);
	expect(parsed.lanes.some((l) => l.sid === "w1242-rider-aaaa")).toBe(true);
});

test("the table matches `work report --format tty` (one renderer)", () => {
	const fleet = runCli(["fleet"]);
	const work = fx.run("work.ts", ["report", "--format", "tty"]);
	expect(work.code).toBe(0);
	expect(fleet.code).toBe(0);
	// one renderer: the report-table rows carry the SAME id + ST glyph in
	// both faces (trailing pad may differ; the lane table rows after the
	// report table are fleet-only)
	const rowsOf = (out: string): string[] =>
		out
			.split("\n")
			.filter((l) => /^[A-Z]\w*[0-9.]+\s+[·◐✓⊘✗–?]/.test(l))
			.map((l) => l.replace(/\s+/g, " ").trim());
	expect(rowsOf(fleet.out)).toEqual(rowsOf(work.out));
});
});
