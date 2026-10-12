import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { readLaneRegistry, safeToRetire } from "../hooks/lib/lane-registry.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	lanesFileFor,
	loadLanes,
	saveLanes,
	type Lane,
} from "../scripts/lib/lane.ts";

const roots: string[] = [];
function repo() {
	const root = mkdtempSync(join(tmpdir(), "w553-registry-"));
	roots.push(root);
	expect(
		Bun.spawnSync(["git", "init", root], { stderr: "pipe", stdout: "pipe" })
			.exitCode,
	).toBe(0);
	mkdirSync(join(root, "packages", "control"), { recursive: true });
	return root;
}
const lane = (sid: string, attempt = 1, launchedAt = 1): Lane => ({
	sid,
	item: sid,
	pid: 1,
	branch: sid,
	worktree: "/unused",
	launchedAt,
	attempt,
});
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("package and root share one Git common directory registry", () => {
	const root = repo();
	expect(lanesFileFor(join(root, "packages", "control", ".fleet"))).toBe(
		lanesFileFor(join(root, ".fleet")),
	);
});

test("stale snapshots preserve newer generations and unseen lanes", () => {
	const root = repo();
	const fleet = join(root, ".fleet");
	saveLanes([lane("a", 1, 10)], fleet);
	const stale = loadLanes(fleet);
	saveLanes([lane("a", 3, 30), lane("b")], fleet);
	saveLanes([...stale, lane("c")], fleet);
	const result = loadLanes(fleet);
	expect(result.map((l) => l.sid).sort()).toEqual(["a", "b", "c"]);
	expect(result.find((l) => l.sid === "a")?.attempt).toBe(3);
	saveLanes([lane("a", 3, 20)], fleet);
	expect(loadLanes(fleet).find((l) => l.sid === "a")?.launchedAt).toBe(30);
});

test("independent processes cannot overwrite simultaneous launches", async () => {
	const root = repo();
	const fleet = join(root, ".fleet");
	const helper = join(root, "writer.ts");
	writeFileSync(
		helper,
		`import { loadLanes, saveLanes } from ${JSON.stringify(join(import.meta.dir, "..", "scripts", "lib", "lane.ts"))};
const fleet=process.argv[2], sid=process.argv[3]; const snapshot=loadLanes(fleet); await Bun.sleep(150); saveLanes([...snapshot,{sid,item:sid,pid:1,branch:sid,worktree:"/unused",launchedAt:Date.now(),attempt:1}],fleet);`,
	);
	const children = Array.from({ length: 12 }, (_, i) =>
		Bun.spawn([process.execPath, helper, fleet, `p${i}`], {
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	expect(await Promise.all(children.map((p) => p.exited))).toEqual(
		Array(12).fill(0),
	);
	expect(loadLanes(fleet)).toHaveLength(12);
});

test("retirement refuses missing/corrupt registry, unknown probes and active claims", () => {
	const root = repo();
	expect(readLaneRegistry(root).known).toBe(false);
	mkdirSync(join(root, ".fleet"));
	writeFileSync(join(root, ".fleet", "lanes.json"), "truncated {");
	expect(readLaneRegistry(root).known).toBe(false);
	expect(() => saveLanes([lane("a")], join(root, ".fleet"))).toThrow(
		"unreadable",
	);
	const known = {
		registryKnown: true,
		claimKnown: true,
		claimed: false,
		recentlyLaunched: false,
		live: false as boolean | null,
	};
	expect(safeToRetire(known)).toBe(true);
	expect(safeToRetire({ ...known, registryKnown: false })).toBe(false);
	expect(safeToRetire({ ...known, claimKnown: false })).toBe(false);
	expect(safeToRetire({ ...known, claimed: true })).toBe(false);
	expect(safeToRetire({ ...known, recentlyLaunched: true })).toBe(false);
	expect(safeToRetire({ ...known, live: null })).toBe(false);
});

test("package retirement preserves a claimed zero-commit root worktree", () => {
	const root = repo(),
		packageDir = join(root, "packages", "control"),
		wt = join(root, ".worktrees", "W1");
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", root, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
	expect(
		git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"base",
		).exitCode,
	).toBe(0);
	expect(git("worktree", "add", "-b", "suspenders/W1", wt).exitCode).toBe(0);
	const home = join(root, ".test-home");
	const env = {
		...process.env,
		HOME: home,
		GOVERNOR_STORE_URL: "",
		FLEET_UNTRACKED_GRACE_MS: "0",
	};
	const work = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
	expect(
		Bun.spawnSync([process.execPath, work, "list"], {
			cwd: packageDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode,
	).toBe(0);
	const db = new Database(
		join(home, ".cache", "claude-governor", "governor.db"),
	);
	db.query(
		"INSERT INTO work_items (project,id,title,state,owner_sid,created_at,updated_at) VALUES (?, 'W1', 'in progress', 'CLAIMED', 'lane-w1', ?, ?)",
	).run(realpathSync(join(root, ".git")), Date.now(), Date.now());
	db.close();
	saveLanes(
		[
			{
				...lane("lane-w1"),
				item: "W1",
				branch: "suspenders/W1",
				worktree: wt,
				launchedAt: 1,
			},
		],
		join(root, ".fleet"),
	);
	const loop = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
	const result = Bun.spawnSync(
		[
			process.execPath,
			loop,
			"ship",
			"--repo",
			packageDir,
			"--branch",
			"suspenders/W1",
		],
		{ cwd: packageDir, env, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).toBe(0);
	expect(existsSync(wt)).toBe(true);
	expect(git("branch", "--list", "suspenders/W1").stdout.toString()).toContain(
		"suspenders/W1",
	);
});

test("linked worktrees resolve to the primary checkout registry", () => {
	const root = repo(),
		linked = join(root, "linked");
	expect(
		Bun.spawnSync(
			[
				"git",
				"-C",
				root,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"--allow-empty",
				"-m",
				"base",
			],
			{ stdout: "pipe", stderr: "pipe" },
		).exitCode,
	).toBe(0);
	expect(
		Bun.spawnSync(
			["git", "-C", root, "worktree", "add", "-b", "linked", linked],
			{ stdout: "pipe", stderr: "pipe" },
		).exitCode,
	).toBe(0);
	expect(lanesFileFor(join(linked, ".fleet"))).toBe(
		lanesFileFor(join(root, ".fleet")),
	);
});

test("a failed process roster is unknown, not proof that retirement is safe", () => {
	const root = repo(),
		bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });
	const modulePath = join(
		import.meta.dir,
		"..",
		"hooks",
		"lib",
		"lane-registry.ts",
	);
	const result = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			`import { retirementProcessLive } from ${JSON.stringify(modulePath)}; console.log(retirementProcessLive("/unused"));`,
		],
		{ env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe" },
	);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString().trim()).toBe("null");
});

test("package-local operator dispatch templates preserve their working directory", () => {
	const root = repo(),
		packageDir = join(root, "packages", "control");
	saveLanes([], join(root, ".fleet"));
	mkdirSync(join(packageDir, "scripts"));
	writeFileSync(
		join(packageDir, "scripts", "dispatch-local.ts"),
		`await Bun.write("dispatch-was-here", process.cwd());`,
	);
	const loop = join(import.meta.dir, "..", "hooks", "bin", "fleet-loop.ts");
	const result = Bun.spawnSync(
		[
			process.execPath,
			loop,
			"once",
			"--repo",
			packageDir,
			"--glob",
			"never-match/*",
			"--dispatch-cmd",
			"bun scripts/dispatch-local.ts",
		],
		{
			cwd: root,
			env: {
				...process.env,
				HOME: join(root, ".test-home"),
				GOVERNOR_STORE_URL: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(result.exitCode).toBe(0);
	expect(existsSync(join(packageDir, "dispatch-was-here"))).toBe(true);
	expect(existsSync(join(root, "dispatch-was-here"))).toBe(false);
});

test("work lanes preserves an explicit custom registry filename", () => {
	const root = repo(),
		file = join(root, "custom-registry.json");
	writeFileSync(
		file,
		JSON.stringify([{ ...lane("custom-lane"), item: "W77" }]),
	);
	const work = join(import.meta.dir, "..", "hooks", "bin", "work.ts");
	const result = Bun.spawnSync(
		[process.execPath, work, "lanes", "--fleet", file, "--json"],
		{
			cwd: root,
			env: {
				...process.env,
				HOME: join(root, ".test-home"),
				GOVERNOR_STORE_URL: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout.toString())[0]?.sid).toBe("custom-lane");
});
