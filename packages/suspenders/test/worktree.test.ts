// test/worktree.test.ts — W52 per-item worktrees: create/retire lifecycle,
// dirty-keep + live-lane refusals, branch survival, and the symlinked build dirs.
// Follows test/work-cli.test.ts: isolated temp HOME + a real git repo under
// process.cwd() (a /tmp checkout would test nothing — the bash gate exempts
// /tmp paths by design).
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	cpSync,
	appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "claude-worktree-home-"));
const gitInit = (dir: string): void => {
	mkdirSync(dir, { recursive: true });
	Bun.spawnSync(["git", "init", "-q", dir], {
		stdout: "ignore",
		stderr: "ignore",
	});
};
const REPO = mkdtempSync(join(tmpdir(), "suspenders-worktree-repo-"));
gitInit(REPO);
const env = { ...process.env, HOME };
const BIN = join(import.meta.dir, "..", "hooks", "bin");

function run(
	cwd: string,
	bin: string,
	...args: string[]
): { out: string; err: string; code: number } {
	const p = Bun.spawnSync(["bun", join(BIN, bin), ...args], {
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
const work = (...args: string[]) => run(REPO, "work.ts", ...args);
const wt = (...args: string[]) => run(REPO, "worktree.ts", ...args);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("worktree lifecycle", () => {
	test("create → isolated tree, branch, gitignore, symlinks; dirty retire refuses; clean retire removes and keeps the branch", () => {
		// repo needs a commit for worktree add to branch from
		writeFileSync(join(REPO, "README.md"), "x");
		Bun.spawnSync(["git", "-C", REPO, "add", "-A"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(
			["git", "-C", REPO, "commit", "-q", "-m", "init", "--allow-empty"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		mkdirSync(join(REPO, "node_modules"), { recursive: true });
		writeFileSync(join(REPO, "node_modules", "m.js"), "x");

		const added = work("add", "isolated work");
		expect(added.code).toBe(0);
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		expect(
			run(REPO, "coord.ts", "bootstrap", "--as", "wt-lane", "--role", "worker")
				.code,
		).toBe(0);
		expect(work("take", id, "--as", "wt-lane").code).toBe(0);

		// create refused before the claim? no — claim exists, so create works
		const c = wt("create", id);
		expect(c.code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(join(dir, "node_modules"))).toBe(true); // symlinked build dir
		const gi = readFileSync(join(REPO, ".gitignore"), "utf8");
		expect(gi).toContain(".worktrees/");

		// dirty worktree: retire refuses, dir survives
		writeFileSync(join(dir, "wip.txt"), "wip");
		const d = wt("retire", id);
		expect(d.code).toBe(3);
		expect(existsSync(dir)).toBe(true);

		// retire after committing the wip: clean → removed, branch survives
		Bun.spawnSync(["git", "-C", dir, "add", "-A"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", "wip"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const r2 = wt("retire", id);
		expect(r2.code).toBe(0);
		expect(existsSync(dir)).toBe(false);
		const b = Bun.spawnSync(
			["git", "-C", REPO, "rev-parse", "--verify", `suspenders/${id}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(b.exitCode).toBe(0); // branch kept for integration
	});
	test("W123 liveness guard: clean worktree with a live lane inside is kept (exit 4), retired once the lane exits", () => {
		const added = work("add", "liveness guard");
		expect(added.code).toBe(0);
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		expect(
			run(REPO, "coord.ts", "bootstrap", "--as", "wt-live", "--role", "worker")
				.code,
		).toBe(0);
		expect(work("take", id, "--as", "wt-live").code).toBe(0);
		expect(wt("create", id).code).toBe(0);
		const dir = join(REPO, ".worktrees", id);
		// the symlinked node_modules reads untracked → dirty (exit 3) would
		// mask the liveness guard — commit the fresh tree clean first
		Bun.spawnSync(["git", "-C", dir, "add", "-A"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(
			["git", "-C", dir, "commit", "-q", "-m", "w", "--allow-empty"],
			{
				stdout: "ignore",
				stderr: "ignore",
			},
		);

		// fake a live lane: the binary name is the harness contract (ps args
		// match), so a copy of /bin/sleep named "codex" with cwd in the tree
		// reads live
		const fake = join(HOME, "codex");
		cpSync("/bin/sleep", fake);
		const lane = Bun.spawn([fake, "30"], {
			cwd: dir,
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			let r: { out: string; err: string; code: number } | null = null;
			for (let i = 0; i < 10; i++) {
				// fresh pids race ps/lsof enumeration — retry until seen
				r = wt("retire", id);
				if (r.code === 4) break;
				Bun.sleepSync(200);
			}
			expect(r?.code).toBe(4);
			expect(existsSync(dir)).toBe(true);
			expect(r?.err).toContain("live lane");
		} finally {
			lane.kill();
		}

		// once the lane exits, the same retire removes the tree, branch kept
		let r2: { out: string; err: string; code: number } | null = null;
		for (let i = 0; i < 10; i++) {
			r2 = wt("retire", id);
			if (r2.code === 0) break;
			Bun.sleepSync(200);
		}
		expect(r2?.code).toBe(0);
		expect(existsSync(dir)).toBe(false);
	});
});
// ─── W494.2.2 — supported sweep ───
describe("worktree sweep (W494.2.2)", () => {
	const sweep = (
		...args: string[]
	): { out: string; err: string; code: number } => {
		const p = Bun.spawnSync(["bun", join(BIN, "worktree.ts"), ...args], {
			cwd: REPO,
			env: { ...env, WORKTREE_SWEEP_GRACE_MS: "0" },
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: p.stdout.toString(),
			err: p.stderr.toString(),
			code: p.exitCode,
		};
	};
	const gc = (args: string[]): { out: string; err: string; code: number } => {
		const p = Bun.spawnSync(["git", "-C", REPO, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0)
			console.error(
				`git ${args.join(" ")} → ${p.exitCode}: ${p.stderr.toString().trim()}`,
			);
		return {
			out: p.stdout.toString().trim(),
			err: p.stderr.toString().trim(),
			code: p.exitCode,
		};
	};
	// mint an item + session + worktree; returns the ids the sweep reads
	const mintTree = (title: string): { id: string; dir: string } => {
		const added = work("add", title);
		expect(added.code).toBe(0);
		const id = (added.out.match(/W\d+/) ?? [])[0] ?? "";
		expect(id).toBeTruthy();
		const sid = `sw-${id}`;
		expect(
			run(REPO, "coord.ts", "bootstrap", "--as", sid, "--role", "worker").code,
		).toBe(0);
		expect(work("take", id, "--as", sid).code).toBe(0);
		expect(sweep("create", id).code).toBe(0);
		// fresh trees read clean — node_modules is ignored (above), so no
		// typechange dirt; a --allow-empty commit would ADD a patch-id main
		// lacks and read unmerged in cherry
		return { id, dir: join(REPO, ".worktrees", id) };
	};
	// lazy: HEAD is unborn at module load — the init commit lands in test 1
	const MAIN = (): string => gc(["rev-parse", "--abbrev-ref", "HEAD"]).out;
	// node_modules must be ignored BEFORE any tree is minted — the first
	// describe commits it (tracked), and a tracked node_modules defeats the
	// symlink hygiene symlinkBuildDirs assumes
	appendFileSync(join(REPO, ".gitignore"), "node_modules\n");
	test("patch-equiv DONE worktree is swept: patch-id cherry vs main, -D after -d refuses, recovery ref pinned", () => {
		const { id, dir } = mintTree("sweep equiv");
		// one commit on the branch: feat.ts ONLY (a bare `add -A` would stage
		// the node_modules typechange and conflict the cherry-pick)
		writeFileSync(join(dir, "feat.ts"), "export const x = 1;\n");
		expect(gc(["-C", dir, "add", "feat.ts"]).code).toBe(0);
		expect(gc(["-C", dir, "commit", "-m", "feat"]).code).toBe(0);
		const tip = gc(["-C", dir, "rev-parse", "HEAD"]).out;
		// land the SAME patch on main via cherry-pick → patch-id equiv, non-ancestor
		// (REPO must be clean: wt create appended .worktrees/ to .gitignore)
		expect(gc(["-C", REPO, "add", "-A"]).code).toBe(0);
		expect(gc(["-C", REPO, "commit", "-m", "gitignore"]).code).toBe(0);
		expect(gc(["-C", REPO, "cherry-pick", tip]).code).toBe(0);
		// dirty-keep trick: done with junk present → retire exits 3 and keeps
		// the tree; item lands DONE with its worktree still standing (the
		// 2026-10-06 incident state this sweep exists for)
		writeFileSync(join(dir, "junk.txt"), "junk");
		expect(work("done", id, "--sha", tip).code).toBe(0);
		expect(existsSync(dir)).toBe(true);
		rmSync(join(dir, "junk.txt")); // clean again — only debris ever blocked retire
		const s = sweep("sweep", "--main", MAIN());
		expect(s.code).toBe(0);
		expect(
			s.out,
			`sweep err: ${s.err} — main=${MAIN()} cherry=[${gc(["cherry", MAIN(), `suspenders/${id}`]).out}]`,
		).toContain(`SWEPT ${id}`);
		expect(s.out).toContain("patch-equiv");
		expect(existsSync(dir)).toBe(false);
		// branch deleted — only -D could, the branch is non-ancestor
		expect(gc(["rev-parse", "--verify", `suspenders/${id}`]).code).not.toBe(0);
		// recovery ref pinned before the delete (REFERENCE BEFORE DELETE)
		const rec = gc(["for-each-ref", "refs/recover", "--format=%(refname)"]).out;
		expect(rec).toContain(`suspenders-${id}-`);
		// work.tree swept event rides the bus
		const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
		const ev = db
			.query(
				"SELECT payload FROM events WHERE kind = 'work.tree' AND scope = ? AND payload LIKE '%swept%'",
			)
			.get(id);
		expect(ev).toBeTruthy();
		db.close();
	});
	test("unmerged DONE worktree stays with a NEED_DECISION; live claim keeps even a patch-equiv tree", () => {
		const { id, dir } = mintTree("sweep unmerged");
		writeFileSync(join(dir, "orphan.ts"), "export const y = 2;\n");
		expect(gc(["-C", dir, "add", "-A"]).code).toBe(0);
		expect(gc(["-C", dir, "commit", "-m", "orphan"]).code).toBe(0);
		const tip = gc(["-C", dir, "rev-parse", "HEAD"]).out;
		// dirty-keep trick again: item lands DONE, tree stays standing
		writeFileSync(join(dir, "junk.txt"), "junk");
		expect(work("done", id, "--sha", tip).code).toBe(0);
		rmSync(join(dir, "junk.txt"));
		const s = sweep("sweep", "--main", MAIN());
		expect(s.code).toBe(0);
		expect(s.out).toContain(`KEPT ${id}`);
		expect(s.out).toContain("NEED_DECISION emitted");
		expect(existsSync(dir)).toBe(true);
		expect(gc(["rev-parse", "--verify", `suspenders/${id}`]).code).toBe(0);
		const db = new Database(join(HOME, ".cache/claude-governor/governor.db"));
		const ev = db
			.query(
				"SELECT payload FROM events WHERE kind = 'NEED_DECISION' AND scope = ?",
			)
			.get(id);
		expect(ev).toBeTruthy();
		db.close();
	});
	test("live claim keeps its worktree even when the branch is patch-equiv (empty branch)", () => {
		const { id, dir } = mintTree("sweep claimed");
		// fresh tree reads clean — only the CLAIM guard decides; the empty
		// branch is trivially patch-equiv (0 commits not in main)
		const s = sweep("sweep", "--main", MAIN());
		expect(s.out).toContain(`KEPT ${id} — claim live`);
		expect(existsSync(dir)).toBe(true);
	});
});
