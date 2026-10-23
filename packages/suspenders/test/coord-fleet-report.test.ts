// test/coord-fleet-report.test.ts — W1242: `coord fleet` renders the ONE
// supervisor table through the W892 library (hooks/lib/work-report.ts — the
// same renderer `work report` rides, so the CLI face cannot drift),
// --project <path|name> selects the graph by coord project identity, --json
// stays the machine face (fleet-watch W522 parses lanes[]), and the W378
// lane projection line stays honest beneath the table.
// Recipe: coord-reads.test.ts / coord-fleet-honesty.test.ts (temp HOME, DB
// reads + CLI runs in bun subprocesses) with the test-env-leak pins
// (GOVERNOR_STORE_URL=local, a missing BUCKLE_DB) so the operator's real
// store/ledger knobs never leak into the fixture.
import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w1242-fleet-report-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-w1242-report-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const WORK = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const runCli = (bin: string, args: string[]) => {
	const p = Bun.spawnSync(["bun", bin, ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: new TextDecoder().decode(p.stdout),
		err: new TextDecoder().decode(p.stderr),
	};
};
// table rows start at column 0 (borderless W976 table)
const rowFor = (out: string, id: string): string | undefined =>
	out.split("\n").find((l) => l.startsWith(`${id} `));
const FLEET_COLS = [
	"ITEM",
	"ST",
	"TASK",
	"TOKENS",
	"CACHE",
	"OUT/MIN",
	"AGENT",
	"MODEL",
	"EFFORT",
	"CONSULT",
];

describe("coord fleet renders the W892 table (W1242)", () => {
	test("default face: table for the cwd project + honest lane line", () => {
		const { code, out, err } = runCli(BIN, ["fleet"]);
		expect(code).toBe(0);
		expect(err).toBe("");
		for (const col of FLEET_COLS) expect(out).toContain(col);
		expect(rowFor(out, "W1242A")).toBeDefined();
		expect(rowFor(out, "W1242B")).toBeDefined();
		expect(rowFor(out, "W1242C")).toBeDefined();
		expect(rowFor(out, "W1242D")).toBeDefined();
		expect(rowFor(out, "W9001")).toBeUndefined();
		// attribution absent → the W892 degradation cells (no fake numbers)
		expect(rowFor(out, "W1242A")).toMatch(
			/W1242A\s+R\s+Fleet W1242A\s+-\s+-\s+0\s+0m\s+-\s+-\s+N/,
		);
		// the W378 lane projection line stays beneath the table
		expect(out).toContain("[sid=w1242-rider-aaaa]");
	});

	test("--project <name> filters the table to that graph", () => {
		const { code, out } = runCli(BIN, ["fleet", "--project", "other-project"]);
		expect(code).toBe(0);
		expect(rowFor(out, "W9001")).toBeDefined();
		expect(rowFor(out, "W1242A")).toBeUndefined();
	});

	test("--project <path> resolves through project identity", () => {
		const { code, out } = runCli(BIN, ["fleet", "--project", REPO]);
		expect(code).toBe(0);
		expect(rowFor(out, "W1242A")).toBeDefined();
		expect(rowFor(out, "W9001")).toBeUndefined();
	});

	test("--project dies loud on unknown name and missing path", () => {
		const unknown = runCli(BIN, ["fleet", "--project", "nosuchproj"]);
		expect(unknown.code).not.toBe(0);
		expect(unknown.err).toContain("no project");
		const missing = runCli(BIN, ["fleet", "--project", join(REPO, "nope")]);
		expect(missing.code).not.toBe(0);
		expect(missing.err).toContain("no such path");
	});

	test("--json keeps the machine face (lanes projection)", () => {
		const { code, out } = runCli(BIN, ["fleet", "--json"]);
		expect(code).toBe(0);
		const parsed = JSON.parse(out) as {
			head: string | null;
			lanes: { sid: string }[];
		};
		expect(Array.isArray(parsed.lanes)).toBe(true);
		expect(parsed.lanes.some((l) => l.sid === "w1242-rider-aaaa")).toBe(true);
	});

	test("the table matches `work report` byte-for-byte (one renderer)", () => {
		const fleet = runCli(BIN, ["fleet"]);
		const work = runCli(WORK, ["report"]);
		expect(work.code).toBe(0);
		expect(fleet.code).toBe(0);
		expect(fleet.out).toContain(work.out.trim());
	});
});
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO], {
	stdout: "ignore",
	stderr: "ignore",
});
writeFileSync(join(REPO, "README.md"), "seed\n");
Bun.spawnSync(["git", "-C", REPO, "add", "README.md"], {
	stdout: "ignore",
	stderr: "ignore",
});
Bun.spawnSync(["git", "-C", REPO, "commit", "-q", "-m", "init"], {
	stdout: "ignore",
	stderr: "ignore",
});

const env = {
	...process.env,
	HOME,
	NO_COLOR: "1",
	// hermetic: never the operator's real store/ledger knobs
	GOVERNOR_STORE_URL: "local",
	BUCKLE_DB: join(HOME, "missing-buckle.db"),
};

// cwd project = the repo's git-common-dir (realpath'd — tmpdir() hands back
// /var/... while the CLI resolves /private/var/...); a second graph keyed by
// a bare name exercises --project <name> without a second repo on disk.
const PROJECT = `${realpathSync(REPO)}/.git`;
const now = Date.now();
Bun.spawnSync(
	[
		"bun",
		"-e",
		`
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
`,
	],
	{ env, stdout: "ignore", stderr: "inherit" },
);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});
