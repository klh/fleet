// wisdom.test.ts — the wisdom tier (W469): stub-mint detection (C1),
// bogus done-sha detection (C2), broadcast flood detection (C7), the 24h
// emission budget, and the W470 broadcast note-dedupe. Isolated temp HOME +
// repo, spawns the real CLI (monitor recipe).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-wisdom-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-wisdom-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");

// projectIdentity() mirror: git walks UP through a scaffolded .git to the
// parent checkout — seeds must match the PARENT repo's identity exactly
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

function run(args: string[]) {
	const p = Bun.spawnSync(["bun", coord, ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
}

function seedDb(fn: (d: Database) => void) {
	const d = new Database(DB);
	fn(d);
	d.close();
}

// bootstrap: first CLI open runs the migrations
run(["kb", "stats"]);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

function countWisdom(): number {
	const d = new Database(DB, { readonly: true });
	const r = d
		.query(
			"SELECT COUNT(*) n FROM events WHERE source = 'wisdom' AND kind = 'NEED_DECISION'",
		)
		.get() as { n: number };
	d.close();
	return r.n;
}

function lastWisdomNote(): string {
	const d = new Database(DB, { readonly: true });
	const r = d
		.query(
			"SELECT payload FROM events WHERE source = 'wisdom' AND kind = 'NEED_DECISION' ORDER BY id DESC LIMIT 1",
		)
		.get() as { payload: string };
	d.close();
	return r.payload;
}
describe("wisdom C1", () => {
	test("a title==id stub item is flagged", () => {
		seedDb((d) => {
			d.query(
				"INSERT INTO work_items (project, id, title, state, priority, required, created_at, updated_at) VALUES (?, ?, ?, 'READY', 0, 1, ?, ?)",
			).run(PROJ, "W9001", "W9001", Date.now(), Date.now());
		});
		const r = run(["wisdom"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("flagged");
		expect(lastWisdomNote()).toContain("CLASS C1");
		expect(lastWisdomNote()).toContain("W9001");
	});
});
describe("wisdom C2", () => {
	test("a work.done with an unresolvable sha is flagged", () => {
		seedDb((d) => {
			d.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'tester', 'work.done', NULL, ?, NULL)",
			).run(
				Date.now(),
				JSON.stringify({
					work: "W9002",
					// deliberately unresolvable — and NOT hex-shaped, so gitleaks'
					// generic-secret heuristic never files it as a credential
					sha: "not-a-real-sha-object",
					project: PROJ,
				}),
			);
		});
		run(["wisdom"]);
		const note = lastWisdomNote();
		expect(note).toContain("CLASS C2");
		expect(note).toContain("W9002@not-a-real");
	});
});
describe("wisdom budget", () => {
	test("an immediate re-sweep emits nothing new", () => {
		const before = countWisdom();
		const r = run(["wisdom"]);
		expect(r.code).toBe(0);
		expect(countWisdom()).toBe(before);
		expect(r.out).toContain("0 emitted");
	});
});
describe("wisdom C7", () => {
	test("three same-note broadcasts are flagged", () => {
		const note = `flood-probe-${Date.now()}`;
		seedDb((d) => {
			for (let i = 0; i < 3; i++) {
				d.query(
					"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'tester', 'BROADCAST', NULL, ?, NULL)",
				).run(Date.now() - i, JSON.stringify({ id: `bflood${i}`, note }));
			}
		});
		run(["wisdom"]);
		expect(lastWisdomNote()).toContain("CLASS C7");
	});
});
describe("wisdom clean graph", () => {
	test("a well-formed item stays unflagged", () => {
		seedDb((d) => {
			d.query(
				"INSERT INTO work_items (project, id, title, description, scope, state, priority, required, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'READY', 0, 1, ?, ?)",
			).run(
				PROJ,
				"W9003",
				"proper title here",
				"full description",
				"pkg/x",
				Date.now(),
				Date.now(),
			);
		});
		const before = countWisdom();
		run(["wisdom"]);
		expect(countWisdom()).toBe(before);
	});
});
