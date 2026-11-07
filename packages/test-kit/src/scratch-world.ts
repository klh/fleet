// src/scratch-world.ts — scratchWorld(): isolated HOME + git repo fixture
// (W1135.1.3). Verbatim semantics of the audited idioms: mkdtemp HOME+REPO
// under os.tmpdir(), a REAL `git init` + empty baseline commit on the repo
// (test/work-cli.test.ts gitInit — an empty mkdir'd .git is NOT a valid
// gitdir, and discovery would walk up into the checkout's own .git), env
// spread with the audit's pins, rmSync teardown.
//
// W2573: the env pins OFFLINE advisory services by default. A scratch HOME
// does NOT de-network the spawned CLIs: kevUrl() falls back to
// 127.0.0.1:8912 even with no settings file, so capsule set / work done
// each blocked a full 8s curation timeout against whatever lives there
// (the completion-native-transcript 20s timeouts). The dead-port pin makes
// the miss instant; a suite that WANTS live-kev behavior passes its own
// SUSPENDERS_KEV_URL (the scratch repo defaults, never the machine's).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScratchWorld {
	/** Scratch HOME — governor.db lives at `<home>/.cache/claude-governor/`. */
	home: string;
	/** Scratch git repo (real `git init` + baseline commit). */
	repo: string;
	/** Spawn env: process.env spread + the audit's pins. */
	env: Record<string, string | undefined>;
	/** rmSync teardown (recursive + force, idempotent). */
	clean(): void;
}

export function scratchWorld(opts?: {
	/** mkdtemp prefix (default "klh-test-kit-"). */
	prefix?: string;
	/** mkdtemp parent (default os.tmpdir()). */
	dir?: string;
}): ScratchWorld {
	const prefix = opts?.prefix ?? "klh-test-kit-";
	const parent = opts?.dir ?? tmpdir();
	const home = mkdtempSync(join(parent, `${prefix}home-`));
	const repo = mkdtempSync(join(parent, `${prefix}repo-`));
	const init = Bun.spawnSync(["git", "init", "-q", repo], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (init.exitCode !== 0) throw new Error(`git init failed in ${repo}`);
	const baseline = Bun.spawnSync(
		[
			"git",
			"-C",
			repo,
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
	if (baseline.exitCode !== 0)
		throw new Error("Fixture baseline commit failed");
	return {
		home,
		repo,
		env: {
			...process.env,
			HOME: home,
			GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
			GIT_CONFIG_SYSTEM: join(home, ".gitconfig-system"),
			GOVERNOR_STORE_URL: "local",
			// offline advisories (W2573): port 9 (discard) refuses instantly
			// on loopback; SUSPENDERS_KEV_URL="" would NOT (the reader ignores
			// empty values and falls back to the :8912 default)
			SUSPENDERS_KEV_URL: "http://127.0.0.1:9",
		},
		clean(): void {
			// Bun/macOS rmSync(force, recursive) can silently leave <repo>/.git
			// behind right after a git write (repro 95/300, error swallowed):
			// a bounded second pass clears the remnant.
			for (const dir of [home, repo]) {
				for (let i = 0; i < 3 && existsSync(dir); i++) {
					rmSync(dir, { recursive: true, force: true });
				}
			}
		},
	};
}
