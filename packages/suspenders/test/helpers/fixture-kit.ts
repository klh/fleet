// test/helpers/fixture-kit.ts — W1275.4: the temp-dir/git primitives behind
// the test fixtures. The work-graph + knowledge suites hand-rolled the same
// three idioms per file (mkdtemp HOME/repo, `git init` (+ the Fixture
// baseline commit), rmSync teardown); this kit is their one source. The
// higher-level faces stay put: cliFixture (cli-e2e-harness.ts) for the CLI
// verb-matrix shape, boardFixture (board-fixture.ts) for a live board.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** mkdtemp under the OS tmpdir — the caller's prefix verbatim so failure
 * output stays greppable. */
export function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** mkdir + `git init -q`; opts.baseline adds the `Fixture baseline` empty
 * commit (work-cli.test.ts doctrine: a bare mkdir .git is NOT a valid
 * gitdir — discovery would walk up into the checkout's own .git). */
export function gitInit(
	dir: string,
	opts: { baseline?: boolean } = {},
): void {
	mkdirSync(dir, { recursive: true });
	const r = Bun.spawnSync(["git", "init", "-q", dir], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (r.exitCode !== 0) throw new Error(`git init failed in ${dir}`);
	if (!opts.baseline) return;
	const b = Bun.spawnSync(
		[
			"git",
			"-C",
			dir,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"-qm",
			"Fixture baseline",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (b.exitCode !== 0)
		throw new Error("Fixture baseline commit failed");
}

/** rmSync recursive+force over the fixture dirs (the afterAll teardown). */
export function cleanupDirs(...dirs: string[]): void {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
