// hooks/lib/fixture-isolation.ts — W1187: bounded reusable fixture/probe
// isolation. Two proven leak vectors, one recipe:
//  (1) Git context: a lane/hook env carrying GIT_DIR/GIT_WORK_TREE (codex
//      dispatch pins them, commit hooks run under them) re-points every
//      `git -C <fixture>` call at the OWNER repo's git dir — a fixture
//      `git config` write then lands in the owner's common config
//      (historical: 370134b5 Test identity commit 2026-10-19; 9b98d661
//      stripped GIT_* in .githooks/post-commit as the first mitigation).
//  (2) Store: govdb REG() = $HOME/.cache/claude-governor — an unpinned
//      fixture/probe process registers fixture projects into the REAL work
//      graph (W1121 probe: .klh-probe/repo/.git became live READY W1).
// The recipe: tmp HOME (store binding via REG) + GIT_* strip + git config
// pinned inside the fixture (GIT_CONFIG_GLOBAL/SYSTEM) + identity via env,
// and a pre-mutation scope guard (assertGitScope) that refuses to run a git
// command whose resolved git dir escapes the fixture root.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

// every env key starting with GIT_ is dropped (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, GIT_CONFIG*, GIT_AUTHOR_*, GIT_COMMITTER_*, GIT_SSH*,
// GIT_TRACE*, ...). The prefix rule is the incident-proven bound: the same
// strip 9b98d661 landed in .githooks/post-commit, now shared here.
export function stripGitEnv(base: Env = process.env): Env {
	const clean: Env = {};
	for (const key of Object.keys(base)) {
		if (key.startsWith("GIT_")) continue;
		clean[key] = base[key];
	}
	return clean;
}

// temp HOME + clean Git context + local store binding, from one object.
// Refuses to build against the real user home — a fixture whose HOME
// resolves to the real home is not a fixture.
export function fixtureEnv(opts: {
	home: string;
	identity?: { name: string; email: string };
	base?: Env;
}): Env {
	const home = resolve(opts.home);
	const real = resolve(homedir());
	if (home === real) {
		throw new Error(
			`fixture-isolation: HOME ${home} is the real user home — fixtureEnv refuses (store binding would hit the production governor.db)`,
		);
	}
	const env: Env = {
		...stripGitEnv(opts.base ?? process.env),
		HOME: home,
		// git must read/write config ONLY inside the fixture: global config is
		// a fixture file, system config is /dev/null — identity can never be
		// inherited from (or leaked to) the real ~/.gitconfig.
		GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
		GIT_CONFIG_SYSTEM: "/dev/null",
		// store binding: "" forces openStore() in-process on REG(), and REG()
		// resolves under HOME → the fixture's own governor.db, never a
		// machine-level store.url binding or the production store.
		GOVERNOR_STORE_URL: "",
	};
	if (opts.identity) {
		// identity rides env, not config: git never touches any config file to
		// learn who the fixture is, so no scope outside the fixture is written.
		env.GIT_AUTHOR_NAME = opts.identity.name;
		env.GIT_AUTHOR_EMAIL = opts.identity.email;
		env.GIT_COMMITTER_NAME = opts.identity.name;
		env.GIT_COMMITTER_EMAIL = opts.identity.email;
	}
	return env;
}

// pre-mutation scope guard: resolve the git dir `cwd` would touch and refuse
// when it escapes `root`. Pre-init (rev-parse fails) passes — nothing is
// scoped yet — and the GIT_* strip is what keeps it that way.
export function assertGitScope(
	root: string,
	cwd: string,
	env: Env = process.env,
): void {
	const scoped = resolve(root);
	const resolved = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--absolute-git-dir"], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (resolved.exitCode !== 0) return; // pre-init: no git dir to guard
	const gitDir = resolved.stdout.toString().trim();
	const inside =
		isAbsolute(gitDir) &&
		(gitDir === scoped || gitDir.startsWith(`${scoped}/`));
	if (!inside) {
		throw new Error(
			`fixture-isolation: git dir ${gitDir} escapes fixture root ${scoped} — refusing mutation outside the fixture`,
		);
	}
}

export interface GitFixture {
	root: string;
	home: string;
	env: Env;
	git(args: string[], cwd?: string): { code: number; out: string; err: string };
	dispose(): void;
}

// the one fixture constructor: tmp root + tmp HOME + isolated env, every git
// call scope-guarded and env-clean. Probes/fixtures run work-graph CLIs with
// `env` and never touch the production store (test/fixture-isolation.test.ts
// pins the full recipe).
export function createGitFixture(
	label: string,
	opts: { identity?: { name: string; email: string } } = {},
): GitFixture {
	const root = mkdtempSync(join(tmpdir(), `fleet-fixture-${label}-`));
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const env = fixtureEnv({ home, identity: opts.identity });
	const git = (args: string[], cwd = root) => {
		assertGitScope(root, cwd, env);
		const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: r.exitCode ?? 1,
			out: r.stdout.toString(),
			err: r.stderr.toString(),
		};
	};
	return {
		root,
		home,
		env,
		git,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}
