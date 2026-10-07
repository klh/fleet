// test/project-identity.test.ts — W460: `coord project rekey` migrates the
// board-owned `decisions` table together with the six graph tables (guarded
// when a coord-only store has no decisions table yet), it stays REFUSED when
// the destination holds work items, and the worktree/harvest project
// resolvers derive the canonical identity (git-common-dir realpath) inside
// linked worktrees too. Temp-HOME spawn recipe per test/consult-kb.test.ts;
// never touches a real governor.db.
import { describe, test, expect, afterAll } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-pid-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-pid-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const env = { ...process.env, HOME };
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const wt = join(import.meta.dir, "..", "hooks", "bin", "worktree.ts");
const govdb = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");

// projectIdentity(), mirrored: git-common-dir from inside the temp repo —
// Git walks UP through a scaffolded .git to the parent checkout, so the
// identity is the PARENT repo's .git; seeds must match it exactly
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
const TARGET = `${PROJ}-v2`;
const TS = Date.now();

function run(cwd: string, bin: string, ...args: string[]) {
	const p = Bun.spawnSync(["bun", bin, ...args], {
		cwd,
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

function seedItem(project: string, id: string) {
	const db = new Database(DB);
	db.query(
		"INSERT INTO work_items (project, id, title, created_at, updated_at) VALUES (?, ?, 'rekey seed', ?, ?)",
	).run(project, id, TS, TS);
	db.close();
}

// bootstrap: first CLI open runs the migrations so the seeds have a schema
run(REPO, coord, "kb", "stats");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("coord project rekey (W460)", () => {
	test("moves the board-owned decisions rows together with the graph", () => {
		const db = new Database(DB);
		// board-owned DDL (hooks/board/context.ts) — coord-only stores only get
		// it after a board boot, so the test materializes it like the board does
		db.run(`CREATE TABLE IF NOT EXISTS decisions (
			event_id INTEGER PRIMARY KEY,
			target TEXT NOT NULL,
			project TEXT,
			state TEXT NOT NULL DEFAULT 'OPEN',
			created_at INTEGER NOT NULL
		)`);
		seedItem(PROJ, "W1");
		db.query(
			"INSERT INTO decisions (event_id, target, project, created_at) VALUES (1, 'coord:1 NEED_DECISION', ?, ?)",
		).run(PROJ, TS);
		db.close();

		const r = run(REPO, coord, "project", "rekey", PROJ, TARGET);
		expect(r.code).toBe(0);
		expect(r.out).toContain("decisions");

		const rd = new Database(DB, { readonly: true });
		const dec = rd
			.query("SELECT project FROM decisions WHERE event_id = 1")
			.get() as { project: string };
		const item = rd
			.query("SELECT project FROM work_items WHERE id = 'W1'")
			.get() as { project: string };
		rd.close();
		expect(dec.project).toBe(TARGET);
		expect(item.project).toBe(TARGET);
	});

	test("refused when the destination already holds work items", () => {
		seedItem(PROJ, "W2");
		const r = run(REPO, coord, "project", "rekey", TARGET, PROJ);
		expect(r.code).not.toBe(0);
		expect(`${r.err}${r.out}`).toContain("rekey refused");
		// the occupying row is untouched by the refused rekey
		const rd = new Database(DB, { readonly: true });
		const item = rd
			.query("SELECT project FROM work_items WHERE id = 'W2'")
			.get() as { project: string };
		rd.close();
		expect(item.project).toBe(PROJ);
	});

	test("coord-only store without a decisions table still rekeys", () => {
		const H2 = mkdtempSync(join(tmpdir(), "suspenders-pid2-"));
		const env2 = { ...process.env, HOME: H2 };
		const DB2 = join(H2, ".cache", "claude-governor", "governor.db");
		try {
			const boot = Bun.spawnSync(["bun", coord, "kb", "stats"], {
				cwd: REPO,
				env: env2,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(boot.exitCode).toBe(0);
			// sanity: no board ever booted in this HOME
			const probe = new Database(DB2, { readonly: true });
			const absent = probe
				.query(
					"SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'decisions'",
				)
				.get();
			probe.close();
			expect(absent).toBeNull();

			// that store gets its own graph row on the from-key
			const db2 = new Database(DB2);
			db2
				.query(
					"INSERT INTO work_items (project, id, title, created_at, updated_at) VALUES (?, 'W9', 'fresh store', ?, ?)",
				)
				.run(TARGET, TS, TS);
			db2.close();

			const TARGET2 = `${PROJ}-v3`;
			const p = Bun.spawnSync(
				["bun", coord, "project", "rekey", TARGET, TARGET2],
				{ cwd: REPO, env: env2, stdout: "pipe", stderr: "pipe" },
			);
			expect(p.exitCode).toBe(0);
			// the graph actually moved in THAT store too
			const rd = new Database(DB2, { readonly: true });
			const item = rd
				.query("SELECT project FROM work_items WHERE id = 'W9'")
				.get() as { project: string };
			rd.close();
			expect(item.project).toBe(TARGET2);
		} finally {
			rmSync(H2, { recursive: true, force: true });
		}
	});
});

describe("project identity resolver (W460)", () => {
	test("linked worktree resolves to the parent common dir, not the .git file", () => {
		const R = mkdtempSync(join(tmpdir(), "suspenders-pid-wtrepo-"));
		try {
			const git = (args: string[], cwd = R) =>
				Bun.spawnSync(["git", "-C", cwd, ...args], {
					stdout: "pipe",
					stderr: "pipe",
				});
			expect(git(["init", "-q"]).exitCode).toBe(0);
			writeFileSync(join(R, "f.txt"), "x");
			expect(git(["add", "-A"]).exitCode).toBe(0);
			expect(
				git(["commit", "-q", "-m", "init", "--allow-empty"]).exitCode,
			).toBe(0);
			mkdirSync(join(R, ".worktrees"));
			const link = join(R, ".worktrees", "link");
			expect(git(["worktree", "add", link, "-b", "linkbr"]).exitCode).toBe(0);

			// worktree.ts's derived path must anchor at the PARENT repo root even
			// when the CLI runs from inside a linked worktree (the old nearest-.git
			// walk bound the worktree's .git FILE and nested .worktrees inside it)
			const r = run(link, wt, "path", "WRES");
			expect(r.code).toBe(0);
			// `path` only PRINTS the derived dir (never creates it) — anchor the
			// expectation at realpath(R), the parent repo root
			expect(r.out.trim()).toBe(join(realpathSync(R), ".worktrees", "WRES"));

			// and the canonical identity itself: linked worktree == parent repo
			const idr = Bun.spawnSync(
				[
					"bun",
					"-e",
					`import { projectIdentity } from ${JSON.stringify(govdb)}; console.log(projectIdentity());`,
				],
				{ cwd: link, env, stdout: "pipe", stderr: "pipe" },
			);
			expect(idr.exitCode).toBe(0);
			expect(idr.stdout.toString().trim()).toBe(projectOf(R));
		} finally {
			rmSync(R, { recursive: true, force: true });
		}
	});
});
