// coord-events.test.ts — W430: `coord events` reads the bus trail through the
// store lib (surface law: no raw sqlite3 against governor.db). Temp HOME under
// the repo (never /tmp); every DB open and CLI run happens in a bun subprocess
// so the parent test process never opens the real governor.db
// (coord-diff.test.ts recipe).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const home = mkdtempSync(join(process.cwd(), ".coord-events-test-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

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

// read rows via a subprocess import — never open the real governor.db here
const sql = <T>(statement: string): T[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all()));
`),
	);

// one subprocess seeds three kinds with distinct payloads; ordering (ids) and
// the note/sha fields drive the newest-first + filtering assertions below
runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = Date.now();
const w = (kind, payload) => db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w430-test', ?, ?)").run(now, kind, payload);
w("w430.alpha", JSON.stringify({ note: "first" }));
w("w430.beta", JSON.stringify({ note: "second", sha: "deadbeef" }));
w("w430.alpha", JSON.stringify({ note: "third" }));
db.close();
`);

describe("coord events — the bus trail read verb", () => {
	test("JSON default: total, parsed payloads, newest-first", () => {
		const p = runCli(["events", "--json"]);
		expect(p.code).toBe(0);
		const j = JSON.parse(p.out) as {
			total: number;
			kinds: string[];
			shown: number;
			events: {
				id: number;
				ts: number;
				source: string;
				kind: string;
				scope: string | null;
				payload: unknown;
			}[];
		};
		const dbTotal = (
			sql<{ n: number }>("SELECT COUNT(*) AS n FROM events")[0] as {
				n: number;
			}
		).n;
		expect(j.total).toBe(dbTotal);
		expect(j.total).toBeGreaterThanOrEqual(3);
		expect(j.kinds).toEqual([]);
		const ids = j.events.map((e) => e.id);
		expect([...ids].sort((a, b) => b - a)).toEqual(ids); // strictly descending
		const beta = j.events.find((e) => e.kind === "w430.beta");
		expect(beta?.payload).toEqual({ note: "second", sha: "deadbeef" });
		expect(beta?.source).toBe("w430-test");
	});

	test("--kinds exact-match filters, csv extends, no trim surprises", () => {
		const a = runCli(["events", "--json", "--kinds", "w430.alpha"]);
		const ja = JSON.parse(a.out) as {
			total: number;
			kinds: string[];
			events: { kind: string }[];
		};
		expect(ja.total).toBe(
			(
				sql<{ n: number }>(
					"SELECT COUNT(*) AS n FROM events WHERE kind = 'w430.alpha'",
				)[0] as { n: number }
			).n,
		);
		expect(ja.kinds).toEqual(["w430.alpha"]);
		expect(ja.events.every((e) => e.kind === "w430.alpha")).toBe(true);
		const both = runCli([
			"events",
			"--json",
			"--kinds",
			"w430.alpha,w430.beta",
		]);
		const jb = JSON.parse(both.out) as {
			total: number;
			events: { kind: string }[];
		};
		expect(jb.total).toBe(3);
		expect(new Set(jb.events.map((e) => e.kind))).toEqual(
			new Set(["w430.alpha", "w430.beta"]),
		);
		const none = runCli(["events", "--json", "--kinds", "w430.nope"]);
		const jn = JSON.parse(none.out) as { total: number; shown: number };
		expect(jn.total).toBe(0);
		expect(jn.shown).toBe(0);
	});

	test("--last caps the tail (newest kept), summary line says so", () => {
		const p = runCli(["events", "--last", "2"]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("w430.beta"); // second-newest row renders
		expect(p.out).toContain("events"); // plural summary
		expect(p.out).toContain("last 2 shown");
		const top2 = sql<{ id: number }>(
			"SELECT id FROM events ORDER BY id DESC LIMIT 2",
		).map((r) => (r as { id: number }).id);
		for (const id of top2) expect(p.out).toContain(`#${id}`);
	});

	test("text mode renders kind, sha and note from the payload", () => {
		const p = runCli(["events", "--kinds", "w430.beta"]);
		expect(p.out).toContain("w430.beta");
		expect(p.out).toContain("@deadbeef"); // sha glyph from formatEventLine
		expect(p.out).toContain("— second"); // em-dash note
		expect(p.out).toContain("1 event of kind w430.beta"); // singular summary
	});

	test("bad --last dies cleanly (exit 2)", () => {
		const zero = runCli(["events", "--last", "0"]);
		expect(zero.code).toBe(2);
		expect(zero.err).toContain("--last");
		const nan = runCli(["events", "--last", "zz"]);
		expect(nan.code).toBe(2);
		expect(nan.err).toContain("--last");
	});
});
