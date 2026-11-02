// builddirs-parallel.e2e.ts — W2254.1: the REAL parallel-install proof.
// builddirs.e2e.ts exercises the injected runner (single-threaded, no real
// overlap). Here two real git worktrees run the REAL frozen private install
// concurrently in Workers, overlap is asserted from wall-clock intervals,
// trees are proven independent by inode, and one tree's destruction leaves
// the peer and the root untouched. The final regression pins the
// active-checkout race: a non-harness process with cwd inside a checkout is
// invisible to any point-in-time probe, so a legacy shared link must never
// be unlinked automatically (deterministic failure on the W2254 migration).
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { installWorktreeDependencies } from "./builddirs.ts";

const fixtureDep = (root) => {
	const dep = join(root, "local", "left-pad");
	mkdirSync(dep, { recursive: true });
	writeFileSync(
		join(dep, "package.json"),
		'{"name":"left-pad","version":"1.0.0","main":"index.js"}',
	);
	writeFileSync(
		join(dep, "index.js"),
		'module.exports.stamp = () => "left-pad-1.0.0";',
	);
	return dep;
};

const manifestFor = (name, dep) =>
	JSON.stringify({
		name: `fixture-${name}`,
		version: "1.0.0",
		dependencies: { "left-pad": `file:${dep}` },
	});

// A real git worktree pair with identical manifest+lock (lock minted once in
// a throwaway template so both lanes start empty and install for real).
const worktreePair = (world) => {
	const dep = fixtureDep(world.repo);
	const template = join(world.repo, "template");
	mkdirSync(template);
	writeFileSync(join(template, "package.json"), manifestFor("tpl", dep));
	const gen = Bun.spawnSync(["bun", "install"], { cwd: template });
	if (gen.exitCode !== 0 || !existsSync(join(template, "bun.lock")))
		throw new Error(`template lock generation failed: ${gen.exitCode}`);
	const lanes = ["a", "b"].map((name) => {
		const wt = join(world.repo, `lane-${name}`);
		const add = Bun.spawnSync([
			"/usr/bin/git",
			"-C",
			world.repo,
			"worktree",
			"add",
			wt,
			"-b",
			`fixture/${name}`,
		]);
		if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add}`);
		writeFileSync(join(wt, "package.json"), manifestFor(name, dep));
		writeFileSync(
			join(wt, "bun.lock"),
			readFileSync(join(template, "bun.lock")),
		);
		return wt;
	});
	return { dep, lanes };
};

// A real `bun` child process runs the REAL install (default runner) inside
// its worktree. Both children rendezvous on marker files before installing,
// so the two real `bun install --frozen-lockfile` runs genuinely overlap.
const runInstallProcess = (wt, modulePath) => {
	const repo = dirname(wt);
	const name = basename(wt);
	const resultFile = join(wt, "install-result.json");
	const ready = join(repo, `ready-${name}`);
	const other = join(
		repo,
		name.endsWith("a") ? "ready-lane-b" : "ready-lane-a",
	);
	const script = `const { existsSync, writeFileSync } = await import("node:fs");
const m = await import(${JSON.stringify(modulePath)});
writeFileSync(${JSON.stringify(ready)}, "1");
while (!existsSync(${JSON.stringify(other)})) await Bun.sleep(2);
const start = Date.now();
const result = m.installWorktreeDependencies(${JSON.stringify(repo)}, ${JSON.stringify(wt)});
await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ start, end: Date.now(), result }));`;
	writeFileSync(join(wt, "install-runner.mjs"), script);
	return Bun.spawn(["bun", join(wt, "install-runner.mjs")], {
		stdout: "ignore",
		stderr: "ignore",
	});
};

test("two real worktrees install frozen dependencies concurrently and independently", async () => {
	const world = scratchWorld({ prefix: "w2254-parallel-" });
	try {
		const { dep, lanes } = worktreePair(world);
		const [a, b] = lanes;
		// two REAL bun child processes, rendezvous on markers, then both run
		// the REAL `bun install --frozen-lockfile` at the same time
		const procs = lanes.map((wt) =>
			runInstallProcess(wt, import.meta.resolve("./builddirs.ts")),
		);
		const exits = await Promise.all(procs.map((p) => p.exited));
		expect(exits).toEqual([0, 0]);
		const ra = JSON.parse(readFileSync(join(a, "install-result.json")));
		const rb = JSON.parse(readFileSync(join(b, "install-result.json")));
		expect(ra.result.ok).toBe(true);
		expect(rb.result.ok).toBe(true);
		// overlap: each install's interval intersects the other's
		expect(Math.max(ra.start, rb.start)).toBeLessThanOrEqual(
			Math.min(ra.end, rb.end),
		);
		// independent trees: distinct inodes, real content, both readable
		const ia = lstatSync(join(a, "node_modules", "left-pad"));
		const ib = lstatSync(join(b, "node_modules", "left-pad"));
		expect(`${ia.dev}:${ia.ino}`).not.toBe(`${ib.dev}:${ib.ino}`);
		for (const wt of lanes) {
			const stamp = Bun.file(join(wt, "node_modules", "left-pad", "index.js"));
			expect(await stamp.text()).toContain("left-pad-1.0.0");
		}
		// destroying one private tree leaves the peer and the root intact
		rmSync(join(a, "node_modules"), { recursive: true, force: true });
		expect(existsSync(join(a, "node_modules"))).toBe(false);
		expect(existsSync(join(b, "node_modules", "left-pad", "index.js"))).toBe(
			true,
		);
		expect(existsSync(join(dep, "index.js"))).toBe(true);
	} finally {
		world.clean();
	}
});

test("legacy link to the shared root survives an active invisible-user checkout", async () => {
	const world = scratchWorld({ prefix: "w2254-race-" });
	try {
		const rootModules = join(world.repo, "node_modules");
		mkdirSync(rootModules);
		writeFileSync(join(rootModules, "sentinel.js"), "root");
		const lane = join(world.repo, "lane");
		mkdirSync(lane);
		writeFileSync(join(lane, "package.json"), '{"name":"fixture"}');
		writeFileSync(join(lane, "bun.lock"), "fixture lock");
		symlinkSync(rootModules, join(lane, "node_modules"));
		// A real process with cwd inside the checkout that no harness probe
		// can see. On the W2254 migration (3e9c34a2) this unlink raced a live
		// user deterministically: the probe returned false, the link vanished
		// mid-use, and the checkout's dependency reads broke.
		const user = Bun.spawn(["sleep", "30"], { cwd: lane });
		const result = installWorktreeDependencies(world.repo, lane);
		expect(result.ok).toBe(true);
		expect(result.note).toContain("preserved");
		expect(readlinkSync(join(lane, "node_modules"))).toBe(rootModules);
		// the active checkout keeps working through the preserved link
		expect(
			readFileSync(join(lane, "node_modules", "sentinel.js"), "utf8"),
		).toBe("root");
		expect(readFileSync(join(rootModules, "sentinel.js"), "utf8")).toBe(
			"root",
		);
		user.kill();
	} finally {
		world.clean();
	}
});
