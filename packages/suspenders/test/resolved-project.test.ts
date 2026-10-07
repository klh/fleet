// test/resolved-project.test.ts — W459.1: the resolved-project interface.
// `resolveProject()` exposes the logical key and the local paths as SEPARATE
// facts, and `projectRootOf()` is the one key→root strip. Temp-repo recipe
// per test/project-identity.test.ts; never touches a real governor.db.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w459-"));
const env = { ...process.env, HOME };
const govdb = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");

const run = (cwd: string, code: string) =>
	Bun.spawnSync(["bun", "-e", code], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

// one temp repo + one linked worktree, fresh per describe
const R = mkdtempSync(join(tmpdir(), "suspenders-w459-repo-"));
let LINK = "";
const git = (args: string[], cwd = R) =>
	Bun.spawnSync(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
git(["init", "-q"]);
git(["commit", "-q", "-m", "init", "--allow-empty"]);
mkdirSync(join(R, ".worktrees"));
LINK = join(R, ".worktrees", "res");
git(["worktree", "add", LINK, "-b", "resbr"]);

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(R, { recursive: true, force: true });
});

const resolveIn = (cwd: string): Record<string, string> => {
	const r = run(
		cwd,
		`import { resolveProject, projectRootOf } from ${JSON.stringify(govdb)}; console.log(JSON.stringify({ rp: resolveProject(), root: projectRootOf("/enrolled/later/.git"), passthrough: projectRootOf("/plain/dir") }));`,
	);
	expect(r.exitCode).toBe(0);
	return JSON.parse(r.stdout.toString());
};

describe("resolveProject (W459.1)", () => {
	test("main checkout: root/commonDir/cwd are the local paths behind one id", () => {
		const rp = resolveIn(realpathSync(R));
		const root = realpathSync(R);
		expect(rp.rp.id).toBe(join(root, ".git"));
		expect(rp.rp.commonDir).toBe(join(root, ".git"));
		expect(rp.rp.root).toBe(root);
		expect(rp.rp.cwd).toBe(root);
	});

	test("linked worktree: SAME id, distinct cwd, root stays the parent checkout", () => {
		const rp = resolveIn(LINK);
		const root = realpathSync(R);
		expect(rp.rp.id).toBe(join(root, ".git"));
		expect(rp.rp.root).toBe(root);
		expect(rp.rp.cwd).toBe(realpathSync(LINK));
		expect(rp.rp.cwd).not.toBe(rp.rp.root);
	});

	test("non-git dir: every field falls back to the dir itself", () => {
		const D = mkdtempSync(join(tmpdir(), "suspenders-w459-nogit-"));
		try {
			const rp = resolveIn(D);
			const real = realpathSync(D);
			expect(rp.rp.id).toBe(real);
			expect(rp.rp.commonDir).toBe(real);
			expect(rp.rp.root).toBe(real);
			expect(rp.rp.cwd).toBe(real);
		} finally {
			rmSync(D, { recursive: true, force: true });
		}
	});

	test("projectRootOf: the one key→root strip, passthrough otherwise", () => {
		const out = resolveIn(R);
		expect(out.root).toBe("/enrolled/later");
		expect(out.passthrough).toBe("/plain/dir");
	});
});
