// test/fixture-isolation.test.ts — W1187 regression: the two proven leak
// vectors get reusable guards, so diagnostic fixtures/probes cannot leak
// project registrations or Git identity into the fleet.
//  (1) Git identity: GIT_DIR/GIT_WORK_TREE inherited from a lane/hook env
//      re-points `git -C <fixture>` at the owner repo's git dir — fixture
//      `git config` rewrote the OWNER's common config (370134b5 Test
//      identity commit, 2026-10-19; 9b98d661 stripped GIT_* in the
//      post-commit contract gate as the first mitigation). The linked-
//      worktree repro below is that incident as a committed regression.
//  (2) Store: govdb REG() = $HOME/.cache/claude-governor — an unpinned
//      probe registered a fixture project into the live work graph (W1121:
//      .klh-probe/repo/.git became live READY W1). The store-binding probe
//      pins HOME + GOVERNOR_STORE_URL into a tmp fixture home and proves
//      graph registrations stay inside it.
// Temp-HOME spawn recipe per coord-capsule-project-scope.test.ts; never
// touches a real governor.db.
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	assertGitScope,
	createGitFixture,
	fixtureEnv,
	stripGitEnv,
} from "../hooks/lib/fixture-isolation.ts";

const hooks = join(import.meta.dir, "../hooks");

// the REAL global gitconfig must be byte-identical after the whole suite —
// read-only machine snapshot, no fixture depends on its content.
const realGitconfig = join(process.env.HOME ?? "", ".gitconfig");
let realGitconfigBytes: string | null = null;
try {
	realGitconfigBytes = readFileSync(realGitconfig, "utf8");
} catch {
	realGitconfigBytes = null; // absent global config is a valid baseline too
}

test.afterAll(() => {
	if (realGitconfigBytes === null) return;
	expect(readFileSync(realGitconfig, "utf8")).toBe(realGitconfigBytes);
});

const identity = { name: "W1187 Fixture", email: "w1187@example.invalid" };

test.describe("stripGitEnv", () => {
	test("drops every GIT_* key, keeps the rest", () => {
		const out = stripGitEnv({
			HOME: "/somewhere",
			GIT_DIR: "/owner/.git",
			GIT_WORK_TREE: "/owner",
			GIT_CONFIG_GLOBAL: "/owner/.gitconfig",
			GIT_AUTHOR_EMAIL: "leak@example.invalid",
		});
		expect(out.GIT_DIR).toBeUndefined();
		expect(out.GIT_WORK_TREE).toBeUndefined();
		expect(out.GIT_CONFIG_GLOBAL).toBeUndefined();
		expect(out.GIT_AUTHOR_EMAIL).toBeUndefined();
		expect(out.HOME).toBe("/somewhere");
	});
});

test.describe("fixtureEnv", () => {
	test("binds HOME, git config and store into the fixture home", () => {
		const fx = createGitFixture("env-bind", { identity });
		try {
			expect(fx.env.HOME).toBe(fx.home);
			expect(fx.env.GIT_CONFIG_GLOBAL).toBe(join(fx.home, ".gitconfig"));
			expect(fx.env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
			expect(fx.env.GOVERNOR_STORE_URL).toBe("");
			expect(fx.env.GIT_AUTHOR_EMAIL).toBe(identity.email);
			expect(fx.env.GIT_COMMITTER_NAME).toBe(identity.name);
			expect(fx.env.GIT_DIR).toBeUndefined();
			expect(fx.env.GIT_WORK_TREE).toBeUndefined();
		} finally {
			fx.dispose();
		}
	});

	test("refuses the real user home", () => {
		expect(() => fixtureEnv({ home: homedir() })).toThrow(/real user home/);
	});
});

test.describe("git identity isolation", () => {
	test("bare inherited GIT_DIR re-points fixture config at the owner repo (the leak)", () => {
		const fx = createGitFixture("gitdir-repro", { identity });
		try {
			// the incident's shape: owner repo + linked lane worktree whose
			// GIT_DIR/GIT_WORK_TREE ride the env a fixture call would inherit
			const owner = join(fx.root, "owner");
			const lane = join(fx.root, "lane");
			mkdirSync(owner);
			fx.git(["init"], owner);
			fx.git(["config", "user.email", "owner@example.invalid"], owner);
			fx.git(["commit", "--allow-empty", "-qm", "base"], owner);
			fx.git(["worktree", "add", "-q", "-b", "lane", lane], owner);
			const gitdir = fx
				.git(["rev-parse", "--absolute-git-dir"], lane)
				.out.trim();
			expect(gitdir).toContain(join(owner, ".git"));
			const fixture = join(fx.root, "fixture-repo");
			mkdirSync(fixture);
			const contaminated = { ...fx.env, GIT_DIR: gitdir, GIT_WORK_TREE: lane };
			const bare = (args: string[]) => {
				const r = Bun.spawnSync(["git", "-C", fixture, ...args], {
					env: contaminated,
					stdout: "pipe",
					stderr: "pipe",
				});
				return { code: r.exitCode ?? 1 };
			};
			bare(["init"]);
			bare(["config", "user.email", "test@example.invalid"]);
			expect(
				fx.git(["config", "--local", "--get", "user.email"], owner).out.trim(),
			).toBe("test@example.invalid"); // the leak, reproduced
		} finally {
			fx.dispose();
		}
	});

	test("the fixture runner (GIT_* strip + scope guard) protects the owner", () => {
		const fx = createGitFixture("gitdir-guard", { identity });
		try {
			// identical contamination available in the wild — but every call now
			// goes through the fixture runner (GIT_* stripped, scope-guarded)
			const owner = join(fx.root, "owner");
			mkdirSync(owner);
			fx.git(["init"], owner);
			fx.git(["config", "user.email", "owner@example.invalid"], owner);
			fx.git(["commit", "--allow-empty", "-qm", "base"], owner);
			const fixture = join(fx.root, "fixture-repo");
			mkdirSync(fixture);
			fx.git(["init"], fixture);
			fx.git(["config", "user.email", identity.email], fixture);
			expect(
				fx.git(["config", "--local", "--get", "user.email"], owner).out.trim(),
			).toBe("owner@example.invalid");
			expect(
				fx
					.git(["config", "--local", "--get", "user.email"], fixture)
					.out.trim(),
			).toBe(identity.email);
		} finally {
			fx.dispose();
		}
	});

	test("fixture commits carry the fixture identity, never the operator's", () => {
		const fx = createGitFixture("identity", { identity });
		try {
			fx.git(["init"]);
			writeFileSync(join(fx.root, "f.txt"), "x\n");
			fx.git(["add", "f.txt"]);
			fx.git(["commit", "-qm", "fixture base"]);
			expect(fx.git(["log", "-1", "--format=%ae"]).out.trim()).toBe(
				identity.email,
			);
			expect(fx.git(["log", "-1", "--format=%an"]).out.trim()).toBe(
				identity.name,
			);
			// config writes are pinned INSIDE the fixture: the global config the
			// fixture env points at is the fixture's own file
			fx.git(["config", "--global", "fixture.probe", "1"]);
			expect(
				fx.git(["config", "--global", "--get", "fixture.probe"]).out.trim(),
			).toBe("1");
			expect(readFileSync(join(fx.home, ".gitconfig"), "utf8")).toContain(
				"[fixture]",
			);
		} finally {
			fx.dispose();
		}
	});
});

test.describe("store binding", () => {
	test("a probe registration lands in the fixture store, partitioned per HOME", () => {
		const fx = createGitFixture("store-bind");
		try {
			fx.git(["init"]);
			const cli = (...args: string[]) => {
				const p = Bun.spawnSync(
					[process.execPath, join(hooks, "bin", "work.ts"), ...args],
					{ cwd: fx.root, env: fx.env, stdout: "pipe", stderr: "pipe" },
				);
				return {
					code: p.exitCode ?? 1,
					out: p.stdout.toString(),
					err: p.stderr.toString(),
				};
			};
			storeProbe(fx, cli);
		} finally {
			fx.dispose();
		}
	});
});

// the W1121 probe shape: a work-graph registration from a fixture process
// must land in the fixture's own store, invisible across HOME bindings
function storeProbe(
	fx: ReturnType<typeof createGitFixture>,
	cli: (...args: string[]) => { code: number; out: string; err: string },
): void {
	const added = cli("add", "fixture isolation probe");
	expect(added.code).toBe(0);
	const id = added.out.match(/W\d+/)?.[0] ?? "";
	expect(id).toBeTruthy();
	expect(
		existsSync(join(fx.home, ".cache", "claude-governor", "governor.db")),
	).toBe(true);
	expect(JSON.parse(cli("show", id, "--json").out)).toMatchObject({
		title: "fixture isolation probe",
	});
	const otherHome = join(fx.root, "other-home");
	mkdirSync(otherHome);
	const p = Bun.spawnSync(
		[process.execPath, join(hooks, "bin", "work.ts"), "list", "--json"],
		{
			cwd: fx.root,
			env: fixtureEnv({ home: otherHome }),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(p.stdout.toString()).not.toContain(`"id":"${id}"`);
}

test.describe("assertGitScope", () => {
	test("refuses a git dir that escapes the fixture root", () => {
		const fx = createGitFixture("scope-bad");
		const other = createGitFixture("scope-other");
		try {
			fx.git(["init"]);
			other.git(["init"]);
			// a foreign fixture's git dir, injected via GIT_DIR — the hijack the
			// strip is supposed to prevent, guarded as defense in depth
			const outside = other.git(["rev-parse", "--absolute-git-dir"]).out.trim();
			const hijacked = { ...fx.env, GIT_DIR: outside };
			expect(() => assertGitScope(fx.root, fx.root, hijacked)).toThrow(
				/escapes fixture root/,
			);
		} finally {
			fx.dispose();
			other.dispose();
		}
	});

	test("passes for git dirs inside the fixture", () => {
		const fx = createGitFixture("scope-ok");
		try {
			// every fx.git() call already ran the guard — this pins it directly
			fx.git(["init"]);
			expect(() => assertGitScope(fx.root, fx.root, fx.env)).not.toThrow();
			// pre-init cwd: nothing scoped yet, the guard stays silent
			expect(() =>
				assertGitScope(fx.root, join(fx.root, "uninitialized"), fx.env),
			).not.toThrow();
		} finally {
			fx.dispose();
		}
	});
});
