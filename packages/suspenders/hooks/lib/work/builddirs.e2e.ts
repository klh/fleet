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
import { join } from "node:path";
import {
	dependencyInstallArgs,
	installWorktreeDependencies,
	symlinkBuildDirs,
} from "./builddirs.ts";

test("dependency install uses independent file backends on every platform", () => {
	expect(dependencyInstallArgs("darwin")).toContain("--backend=clonefile");
	expect(dependencyInstallArgs("linux")).toContain("--backend=copyfile");
});

test("lane setup keeps package files private to each checkout (injected runner; real overlap proven in builddirs-parallel)", async () => {
	const world = scratchWorld({ prefix: "w2254-dependencies-" });
	try {
		const rootModules = join(world.repo, "node_modules");
		mkdirSync(rootModules);
		writeFileSync(join(rootModules, "sentinel.js"), "root");
		const lanes = [join(world.repo, "lane-a"), join(world.repo, "lane-b")];
		for (const lane of lanes) {
			mkdirSync(lane);
			writeFileSync(join(lane, "package.json"), '{"name":"fixture"}\n');
			writeFileSync(join(lane, "bun.lock"), "fixture lock");
			symlinkBuildDirs(world.repo, lane);
			expect(existsSync(join(lane, "node_modules"))).toBe(false);
		}
		const called: string[] = [];
		const install = (lane: string) =>
			installWorktreeDependencies(world.repo, lane, {
				run: (cwd, argv) => {
					called.push(cwd);
					expect(argv).toEqual(dependencyInstallArgs());
					mkdirSync(join(cwd, "node_modules"));
					writeFileSync(join(cwd, "node_modules", "sentinel.js"), cwd);
					return { exitCode: 0 };
				},
			});
		const results = await Promise.all(lanes.map(async (lane) => install(lane)));
		expect(results.every((result) => result.ok)).toBe(true);
		expect(called).toEqual(lanes);
		const [a, b] = lanes;
		if (!a || !b) throw new Error("fixture lanes missing");
		rmSync(join(a, "node_modules"), { recursive: true });
		install(a);
		expect(readFileSync(join(rootModules, "sentinel.js"), "utf8")).toBe("root");
		expect(readFileSync(join(b, "node_modules", "sentinel.js"), "utf8")).toBe(
			b,
		);
		expect(lstatSync(join(a, "node_modules")).isSymbolicLink()).toBe(false);
	} finally {
		world.clean();
	}
});

test("legacy shared links stay intact and non-fatal whatever the activity", () => {
	const world = scratchWorld({ prefix: "w2254-legacy-link-" });
	try {
		const modules = join(world.repo, "node_modules");
		mkdirSync(modules);
		writeFileSync(join(modules, "sentinel.js"), "root");
		const lane = join(world.repo, "lane");
		mkdirSync(lane);
		writeFileSync(join(lane, "package.json"), '{"name":"fixture"}\n');
		writeFileSync(join(lane, "bun.lock"), "fixture lock");
		symlinkSync(modules, join(lane, "node_modules"));
		let calls = 0;
		// W2254.1: no activity distinction survives — a point-in-time probe
		// cannot prove quiescence, so EVERY legacy link is preserved without
		// an install attempt. The active-checkout race regression lives in
		// builddirs-parallel.e2e.ts.
		const result = installWorktreeDependencies(world.repo, lane, {
			run: () => {
				calls++;
				return { exitCode: 0 };
			},
		});
		expect(result.ok).toBe(true);
		expect(result.note).toContain("preserved");
		expect(calls).toBe(0);
		expect(readlinkSync(join(lane, "node_modules"))).toBe(modules);
		expect(readFileSync(join(modules, "sentinel.js"), "utf8")).toBe("root");
	} finally {
		world.clean();
	}
});

test("an idle Fleet root link is still preserved, never migrated", () => {
	const world = scratchWorld({ prefix: "w2254-idle-migration-" });
	try {
		const rootModules = join(world.repo, "node_modules");
		mkdirSync(rootModules);
		writeFileSync(join(rootModules, "sentinel.js"), "root");
		const lane = join(world.repo, "lane");
		const peer = join(world.repo, "peer");
		mkdirSync(lane);
		mkdirSync(peer);
		writeFileSync(join(lane, "package.json"), '{"name":"fixture"}\n');
		writeFileSync(join(lane, "bun.lock"), "fixture lock");
		symlinkSync(rootModules, join(lane, "node_modules"));
		symlinkSync(rootModules, join(peer, "node_modules"));
		const result = installWorktreeDependencies(world.repo, lane, {
			run: (cwd) => {
				mkdirSync(join(cwd, "node_modules"));
				writeFileSync(join(cwd, "node_modules", "sentinel.js"), "private");
				return { exitCode: 0 };
			},
		});
		// W2254.1: idleness no longer licenses migration — "idle" was the
		// point-in-time verdict the race invalidated. The link stands, the
		// peer's link stands, the shared tree is untouched.
		expect(result.ok).toBe(true);
		expect(result.note).toContain("preserved");
		expect(
			readlinkSync(join(lane, "node_modules")),
		).toBe(rootModules);
		expect(readFileSync(join(rootModules, "sentinel.js"), "utf8")).toBe("root");
		expect(readlinkSync(join(peer, "node_modules"))).toBe(rootModules);
	} finally {
		world.clean();
	}
});

test("unrelated links and missing lockfiles never migrate", () => {
	const world = scratchWorld({ prefix: "w2254-migration-guards-" });
	try {
		const rootModules = join(world.repo, "node_modules");
		const operatorModules = join(world.repo, "operator-modules");
		mkdirSync(rootModules);
		mkdirSync(operatorModules);
		const lane = join(world.repo, "lane");
		mkdirSync(lane);
		writeFileSync(join(lane, "package.json"), '{"name":"fixture"}\n');
		writeFileSync(join(lane, "bun.lock"), "fixture lock");
		const link = join(lane, "node_modules");
		symlinkSync(operatorModules, link);
		let calls = 0;
		const options = {
			run: () => {
				calls++;
				return { exitCode: 0 };
			},
		};
		const foreign = installWorktreeDependencies(world.repo, lane, options);
		expect(foreign.ok).toBe(false);
		expect(foreign.note).toContain("preserved");
		expect(readlinkSync(link)).toBe(operatorModules);
		// The Fleet-root link never migrates either — with or without a lock.
		rmSync(link);
		symlinkSync(rootModules, link);
		const kept = installWorktreeDependencies(world.repo, lane, options);
		expect(kept.ok).toBe(true);
		expect(kept.note).toContain("preserved");
		rmSync(join(lane, "bun.lock"));
		const unlocked = installWorktreeDependencies(world.repo, lane, options);
		expect(unlocked.ok).toBe(true);
		expect(unlocked.note).toContain("preserved");
		expect(readlinkSync(link)).toBe(rootModules);
		expect(calls).toBe(0);
	} finally {
		world.clean();
	}
});

test("a failed private install clears only its incomplete tree for retry", () => {
	const world = scratchWorld({ prefix: "w2254-install-retry-" });
	try {
		const rootModules = join(world.repo, "node_modules");
		mkdirSync(rootModules);
		writeFileSync(join(rootModules, "sentinel.js"), "root");
		const lane = join(world.repo, "lane");
		mkdirSync(lane);
		writeFileSync(join(lane, "package.json"), '{"name":"fixture"}\n');
		writeFileSync(join(lane, "bun.lock"), "fixture lock");
		const failed = installWorktreeDependencies(world.repo, lane, {
			run: (cwd) => {
				mkdirSync(join(cwd, "node_modules"));
				writeFileSync(join(cwd, "node_modules", "partial.js"), "partial");
				return { exitCode: 9 };
			},
		});
		expect(failed.ok).toBe(false);
		expect(existsSync(join(lane, "node_modules"))).toBe(false);
		expect(readFileSync(join(rootModules, "sentinel.js"), "utf8")).toBe("root");
		const retried = installWorktreeDependencies(world.repo, lane, {
			run: (cwd) => {
				mkdirSync(join(cwd, "node_modules"));
				return { exitCode: 0 };
			},
		});
		expect(retried.ok).toBe(true);
	} finally {
		world.clean();
	}
});
