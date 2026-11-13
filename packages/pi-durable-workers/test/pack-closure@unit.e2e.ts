import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

test("real package excludes seed development imports while preserving every runtime asset", () => {
	const world = scratchWorld(),
		root = resolve(import.meta.dir, "..");
	const command = (argv: [string, ...string[]], cwd = root) =>
		execFileSync(argv[0], argv.slice(1), {
			cwd,
			timeout: 30000,
			killSignal: "SIGKILL",
			maxBuffer: 4194304,
			encoding: "utf8",
		});
	try {
		const archive = join(world.home, "workers.tgz"),
			unpacked = join(world.home, "unpacked");
		command([
			process.execPath,
			"pm",
			"pack",
			"--ignore-scripts",
			"--filename",
			archive,
		]);
		const files = command(["tar", "-tzf", archive]).trim().split("\n");
		expect(files).not.toContain("package/seed/tool/tool@unit.e2e.ts");
		expect(files).not.toContain("package/seed/tool/playwright.config.ts");
		mkdirSync(unpacked);
		command(["tar", "-xzf", archive, "-C", unpacked]);
		const runtime = command(["git", "ls-files", "--", "src", "seed"])
			.trim()
			.split("\n")
			.filter(
				(p) =>
					!p.endsWith(".e2e.ts") &&
					!p.endsWith("/playwright.config.ts") &&
					!p.endsWith("/.gitignore"),
			);
		expect(runtime).toContain("seed/payload/readiness.ts");
		expect(runtime).toContain("seed/tool/build.ts");
		for (const path of runtime) {
			expect(files, path).toContain(`package/${path}`);
			expect(readFileSync(join(unpacked, "package", path))).toEqual(
				readFileSync(join(root, path)),
			);
		}
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		);
		const devOnly = Object.keys(manifest.devDependencies).filter(
			(p) => !Object.hasOwn(manifest.dependencies, p),
		);
		for (const path of files.filter((p) => /\.(ts|js)$/.test(p))) {
			const code = readFileSync(join(unpacked, path), "utf8").replace(
				/^#![^\n]*(?:\n|$)/,
				"",
			);
			for (const entry of new Bun.Transpiler({ loader: "ts" }).scanImports(
				code,
			))
				expect(
					devOnly.some(
						(p) => entry.path === p || entry.path.startsWith(`${p}/`),
					),
					`${path}: ${entry.path}`,
				).toBe(false);
		}
	} finally {
		world.clean();
	}
});
