// consult-expiry.test.ts — W611 (W436 item 4): consults carry a deadline; an
// OPEN consult past it flips EXPIRED and emits consult.expired at the asker
// (the lane's gate drain delivers the news mid-work). The new INSERT stamps
// deadline_at; NULL (pre-W611 rows) falls back to created_at + TTL; live
// consults are untouched. Temp HOME under the repo (never /tmp); every DB
// open happens in a bun subprocess so the parent test process never opens
// the real governor.db (w451-event-indexes recipe).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXPIRY = join(import.meta.dir, "..", "hooks", "lib", "consult-expiry.ts");
const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-w611-consult-expiry-"));
const REPO = mkdtempSync(
	join(tmpdir(), "suspenders-w611-consult-expiry-repo-"),
);
import { mkdirSync, realpathSync } from "node:fs";
mkdirSync(join(REPO, ".git"), { recursive: true });
// projectIdentity(), mirrored (consult-kb recipe): git-common-dir from inside
// the temp repo — the identity is the scaffolded .git dir, resolved absolute
function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
const ASKER = "asker-sess-11111111";
const EXPERT = "expert-sess-22222222";

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const runIn = (code: string): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		cwd: REPO,
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

const json = (v: unknown) => JSON.stringify(v);

function seed(): void {
	runIn(`
const { openGovernorDb } = await import(${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb.ts"))});
const db = openGovernorDb();
const now = Date.now();
for (const sid of [${json(ASKER)}, ${json(EXPERT)}])
	db.query("INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'lane', ?, ?, 'RUNNING')")
		.run(sid, ${json(PROJ)}, now, now);
const ins = db.query("INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at, deadline_at) VALUES (?, ?, ?, ?, 'hooks', 'OPEN', ?, ?)");
// past a stamped deadline, past a NULL (legacy) deadline, within deadline
ins.run(${json(PROJ)}, ${json(ASKER)}, ${json(EXPERT)}, "stale stamped", now - 7_200_000, now - 3_600_000);
ins.run(${json(PROJ)}, ${json(ASKER)}, ${json(EXPERT)}, "stale legacy", now - 7_200_000, null);
ins.run(${json(PROJ)}, ${json(ASKER)}, ${json(EXPERT)}, "fresh", now, now + 3_600_000);
db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'coord', 'consult', ?, ?, ?)")
	.run(now, "hooks", JSON.stringify({ consult: "C999", q: "stale stamped" }), ${json(EXPERT)});
`);
}

describe("consult-expiry (W611)", () => {
	test("open consults stamp a deadline on creation (CLI path)", () => {
		seed();
		const p = Bun.spawnSync(
			[
				"bun",
				COORD,
				"consult",
				EXPERT,
				"does the gate drain advance only past shown?",
				"--scope",
				"hooks/gates",
				"--version",
				"test-version",
				"--no-kb",
				"--as",
				ASKER,
			],
			{
				cwd: REPO,
				env: { ...process.env, HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(p.exitCode).toBe(0);
		const out = runIn(`
const { openGovernorDb } = await import(${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb.ts"))});
const db = openGovernorDb();
const r = db.query("SELECT created_at, deadline_at FROM consults WHERE question LIKE 'does the gate drain%'").get();
console.log(JSON.stringify(r));
`);
		const row = JSON.parse(out) as { created_at: number; deadline_at: number };
		expect(row.deadline_at - row.created_at).toBe(3_600_000);
	});

	test("expireConsults flips past-deadline rows and emits consult.expired at the asker", () => {
		const out = runIn(`
const { openGovernorDb } = await import(${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb.ts"))});
const { expireConsults } = await import(${JSON.stringify(EXPIRY)});
const db = openGovernorDb();
const n = expireConsults(db);
const states = db.query("SELECT question, state FROM consults ORDER BY id").all();
const evs = db.query("SELECT kind, target, payload FROM events WHERE kind = 'consult.expired'").all();
console.log(JSON.stringify({ n, states, evs }));
`);
		const r = JSON.parse(out) as {
			n: number;
			states: { question: string; state: string }[];
			evs: { kind: string; target: string; payload: string }[];
		};
		expect(r.n).toBe(2); // stale stamped + stale legacy; fresh survives
		const byQ = Object.fromEntries(
			r.states.map((s) => [s.question, s.state]),
		) as Record<string, string>;
		expect(byQ["stale stamped"]).toBe("EXPIRED");
		expect(byQ["stale legacy"]).toBe("EXPIRED"); // NULL deadline → TTL fallback
		expect(byQ.fresh).toBe("OPEN");
		expect(r.evs.length).toBe(2);
		for (const e of r.evs) {
			expect(e.kind).toBe("consult.expired");
			expect(e.target).toBe(ASKER);
			expect(JSON.parse(e.payload)).toHaveProperty("consult");
		}
	});

	test("second sweep is a no-op (already expired)", () => {
		const out = runIn(`
const { openGovernorDb } = await import(${JSON.stringify(join(import.meta.dir, "..", "hooks", "lib", "govdb.ts"))});
const { expireConsults } = await import(${JSON.stringify(EXPIRY)});
const db = openGovernorDb();
console.log(JSON.stringify(expireConsults(db)));
`);
		expect(JSON.parse(out)).toBe(0);
	});
});
