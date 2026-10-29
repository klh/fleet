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

test("parallel lane setup keeps package files private to each checkout", async () => {
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
			installWorktreeDependencies(lane, (cwd, argv) => {
				called.push(cwd);
				expect(argv).toEqual(dependencyInstallArgs());
				mkdirSync(join(cwd, "node_modules"));
				writeFileSync(join(cwd, "node_modules", "sentinel.js"), cwd);
				return { exitCode: 0 };
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

test("standing legacy dependency links are left intact without an install", () => {
	const world = scratchWorld({ prefix: "w2254-legacy-link-" });
	try {
		const modules = join(world.repo, "node_modules");
		mkdirSync(modules);
		const lane = join(world.repo, "lane");
		mkdirSync(lane);
		symlinkSync(modules, join(lane, "node_modules"));
		let calls = 0;
		const result = installWorktreeDependencies(lane, () => {
			calls++;
			return { exitCode: 0 };
		});
		expect(result.ok).toBe(false);
		expect(result.note).toContain("shared");
		expect(calls).toBe(0);
		expect(readlinkSync(join(lane, "node_modules"))).toBe(modules);
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
		const failed = installWorktreeDependencies(lane, (cwd) => {
			mkdirSync(join(cwd, "node_modules"));
			writeFileSync(join(cwd, "node_modules", "partial.js"), "partial");
			return { exitCode: 9 };
		});
		expect(failed.ok).toBe(false);
		expect(existsSync(join(lane, "node_modules"))).toBe(false);
		expect(readFileSync(join(rootModules, "sentinel.js"), "utf8")).toBe("root");
		const retried = installWorktreeDependencies(lane, (cwd) => {
			mkdirSync(join(cwd, "node_modules"));
			return { exitCode: 0 };
		});
		expect(retried.ok).toBe(true);
	} finally {
		world.clean();
	}
});
