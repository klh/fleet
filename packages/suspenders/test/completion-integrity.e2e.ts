import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchWorld, type ScratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";
import { canonicalProjectRoot } from "../hooks/lib/lanes/lane-registry.ts";

const BIN = join(import.meta.dir, "../hooks/bin/completion-integrity.ts");
const GOVDB = join(import.meta.dir, "../hooks/lib/govdb/govdb.ts");

const git = (world: ScratchWorld, args: string[]): string => {
	const p = Bun.spawnSync(["git", "-C", world.repo, ...args], {
		env: world.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
};

// fixture identity must equal the bin's: canonicalProjectRoot collapses the
// /var/folders → /private/var/folders symlink the way the bin does before
// projectIdentity() reads the gitdir
const projectOf = (world: ScratchWorld): string =>
	projectIdentity(canonicalProjectRoot(world.repo));

// insert a DONE work_items row (child process: the scratch store is
// env-pinned via GOVERNOR_STORE_URL=local + scratch HOME)
const seed = (world: ScratchWorld, id: string, resultSha: string): void => {
	const script = [
		`const { openStore } = await import(${JSON.stringify(GOVDB)});`,
		"const store = openStore();",
		"store.query(\"INSERT INTO work_items (project, id, title, state, result_sha, created_at, updated_at) VALUES (?, ?, 'fixture', 'DONE', ?, ?, ?)\")",
		".run(process.env.W2949_PROJECT, process.env.W2949_ID, process.env.W2949_SHA, Date.now(), Date.now());",
		"store.close();",
	].join("\n");
	const p = Bun.spawnSync(["bun", "-e", script], {
		env: {
			...world.env,
			W2949_PROJECT: projectOf(world),
			W2949_ID: id,
			W2949_SHA: resultSha,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`seed ${id}: ${p.stderr.toString()}`);
};

// probe event kinds banked for an item scope (child process, same store)
const events = (world: ScratchWorld, scope: string): string[] => {
	const script = [
		`const { openStore } = await import(${JSON.stringify(GOVDB)});`,
		"const store = openStore();",
		'const rows = store.query("SELECT kind FROM events WHERE scope = ?").all(process.env.W2949_SCOPE);',
		"console.log(JSON.stringify(rows.map((r) => r.kind)));",
	].join("\n");
	const p = Bun.spawnSync(["bun", "-e", script], {
		env: { ...world.env, W2949_SCOPE: scope },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0) throw new Error(`events probe: ${p.stderr.toString()}`);
	return JSON.parse(p.stdout.toString().trim()) as string[];
};

const statePath = (world: ScratchWorld): string =>
	join(world.repo, ".fleet", "completion-integrity.json");
const stateRead = (
	world: ScratchWorld,
): Record<string, unknown> | undefined => {
	if (!existsSync(statePath(world))) return undefined;
	return JSON.parse(readFileSync(statePath(world), "utf8")) as Record<
		string,
		unknown
	>;
};

const run = (
	world: ScratchWorld,
	args: string[],
): { code: number; out: string } => {
	const r = runCli(BIN, [...args, "--repo", world.repo], {
		env: world.env,
		cwd: join(import.meta.dir, ".."),
	});
	return { code: r.code, out: r.out };
};

// tree-identical child commit on top of parent — a descendant tip for the
// drift branch without touching any worktree
const commitChild = (
	world: ScratchWorld,
	parent: string,
	msg: string,
): string => {
	const tree = git(world, ["rev-parse", `${parent}^{tree}`]);
	return git(world, [
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit-tree",
		tree,
		"-p",
		parent,
		"-m",
		msg,
	]);
};

// WDRF: DONE item banked at the baseline, branch moved to a descendant tip
const seedDrift = (world: ScratchWorld, id: string): string => {
	const base = git(world, ["rev-parse", "HEAD"]);
	git(world, ["branch", `suspenders/${id}`, base]);
	seed(world, id, base);
	const child = commitChild(world, base, "w2949 fixture drift commit");
	git(world, ["branch", "-f", `suspenders/${id}`, child]);
	return child;
};

test("clean world exits 0 @unit", () => {
	const world = scratchWorld({ prefix: "w2949-clean-" });
	try {
		const r = run(world, []);
		expect(r.code).toBe(0);
		expect(r.out).toContain("clean");
		expect(stateRead(world)).toBeUndefined();
	} finally {
		world.clean();
	}
});

test("dry-run detects descendant drift without writing state @unit", () => {
	const world = scratchWorld({ prefix: "w2949-dry-" });
	try {
		const child = seedDrift(world, "WDRF");
		const r = run(world, []);
		expect(r.code).toBe(1);
		expect(r.out).toContain("WDRF");
		expect(r.out).toContain("descendant");
		expect(r.out).toContain(child.slice(0, 8));
		expect(stateRead(world)).toBeUndefined();
		expect(events(world, "WDRF")).toHaveLength(0);
	} finally {
		world.clean();
	}
});

test("--act banks the episode and emits drift + NEED_DECISION @unit", () => {
	const world = scratchWorld({ prefix: "w2949-act-" });
	try {
		const child = seedDrift(world, "WDRF");
		const r = run(world, ["--act"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("(acted)");
		const kinds = events(world, "WDRF");
		expect(kinds).toContain("work.completion_drift");
		expect(kinds).toContain("NEED_DECISION");
		const st = stateRead(world);
		expect(st).toBeDefined();
		const episode = st?.WDRF;
		expect(episode).toBeDefined();
		expect((episode as { head: string }).head).toBe(child);
	} finally {
		world.clean();
	}
});

test("second --act on an unchanged head is silent @unit", () => {
	const world = scratchWorld({ prefix: "w2949-idem-" });
	try {
		seedDrift(world, "WDRF");
		const first = run(world, ["--act"]);
		expect(first.code).toBe(0);
		expect(events(world, "WDRF")).toHaveLength(2);
		const second = run(world, ["--act"]);
		expect(second.code).toBe(0);
		expect(second.out).toContain("clean");
		expect(events(world, "WDRF")).toHaveLength(2);
	} finally {
		world.clean();
	}
});

test("healing the branch drops the episode from state @unit", () => {
	const world = scratchWorld({ prefix: "w2949-heal-" });
	try {
		const child = seedDrift(world, "WDRF");
		expect(run(world, ["--act"]).code).toBe(0);
		expect(stateRead(world)?.WDRF).toBeDefined();
		// operator heals: re-anchor the branch to the banked sha
		const base = git(world, ["rev-parse", `${child}^`]);
		git(world, ["branch", "-f", "suspenders/WDRF", base]);
		const after = run(world, ["--act"]);
		expect(after.code).toBe(0);
		expect(stateRead(world)?.WDRF).toBeUndefined();
	} finally {
		world.clean();
	}
});

test("divergent history classifies as divergent @unit", () => {
	const world = scratchWorld({ prefix: "w2949-div-" });
	try {
		const base = git(world, ["rev-parse", "HEAD"]);
		const banked = commitChild(world, base, "banked tip");
		const rewritten = commitChild(world, base, "rewritten tip");
		git(world, ["branch", "suspenders/WDIV", rewritten]);
		seed(world, "WDIV", banked);
		const r = run(world, []);
		expect(r.code).toBe(1);
		expect(r.out).toContain("WDIV");
		expect(r.out).toContain("divergent");
	} finally {
		world.clean();
	}
});

test("absent branch is skipped silently @unit", () => {
	const world = scratchWorld({ prefix: "w2949-abs-" });
	try {
		seedDrift(world, "WDRF"); // drives the exit-1
		seed(world, "WABS", git(world, ["rev-parse", "HEAD"])); // no branch ever
		const r = run(world, []);
		expect(r.code).toBe(1);
		expect(r.out).toContain("WDRF");
		expect(r.out).not.toContain("WABS");
	} finally {
		world.clean();
	}
});
