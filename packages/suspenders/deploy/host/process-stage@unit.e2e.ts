import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { stageContext } from "./build.ts";
import { hostProcess } from "./process.ts";

test("shared stageContext routes archive/extract/metadata through trusted bounded runner and cleans @unit", async () => {
	const world = scratchWorld();
	const calls: string[][] = [];
	const run = async (argv: readonly string[], cwd: string) => {
		calls.push([...argv]);
		const result = await hostProcess(argv, {
			cwd,
			timeoutMs: 2000,
			maxBytes: 1024 * 1024,
		});
		if (result.code !== 0 || result.signal)
			throw new Error("Fixture HOST command refused");
		return result.stdout;
	};
	const git = async (args: string[]) =>
		new TextDecoder().decode(await run(["git", ...args], world.home)).trim();
	const commit = async () => {
		await git(["add", "."]);
		await git([
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"fixture",
		]);
		return git(["rev-parse", "HEAD"]);
	};
	let staged: Awaited<ReturnType<typeof stageContext>> | undefined;
	try {
		await git(["init"]);
		await writeFile(join(world.home, "marker"), "committed-source");
		const source = await commit();
		const recipeDir = join(world.home, "packages/suspenders/deploy/host");
		await mkdir(recipeDir, { recursive: true });
		await mkdir(join(recipeDir, "../healthcheck"), { recursive: true });
		for (const name of ["Dockerfile", "bundle.ts", "contract.ts", "health.ts"])
			await writeFile(join(recipeDir, name), `committed-${name}`);
		await writeFile(
			join(recipeDir, "../healthcheck/probe.ts"),
			"committed-probe",
		);
		const recipe = await commit();
		await writeFile(join(world.home, "marker"), "replacement-source");
		await writeFile(join(recipeDir, "Dockerfile"), "replacement-Dockerfile");
		const replacement = await commit();
		await git(["replace", source, replacement]);
		await git(["replace", recipe, replacement]);
		await writeFile(join(world.home, "private-untracked"), "never-stage");
		await writeFile(join(recipeDir, "Dockerfile"), "LIVE-MUTATION");
		calls.length = 0;
		staged = await stageContext(source, recipe, world.home, { run });
		expect(calls[0].slice(0, 5)).toEqual([
			"git",
			"--no-replace-objects",
			"archive",
			"--format=tar",
			"--output",
		]);
		expect(calls.some((argv) => argv[0] === "tar")).toBe(true);
		expect(calls.filter((argv) => argv[2] === "ls-tree")).toHaveLength(5);
		expect(calls.filter((argv) => argv[2] === "show")).toHaveLength(5);
		expect(await Bun.file(join(staged.context, "source/marker")).text()).toBe(
			"committed-source",
		);
		expect(await Bun.file(join(staged.context, "Dockerfile")).text()).toBe(
			"committed-Dockerfile",
		);
		expect(existsSync(join(staged.context, "source/.git"))).toBe(false);
		expect(existsSync(join(staged.context, "source/private-untracked"))).toBe(
			false,
		);
		expect(existsSync(join(staged.context, "source.tar"))).toBe(false);
		const streamed = await stageContext(source, recipe, world.home);
		try {
			expect(
				await Bun.file(join(streamed.context, "source/marker")).text(),
			).toBe("committed-source");
			expect(await Bun.file(join(streamed.context, "Dockerfile")).text()).toBe(
				"committed-Dockerfile",
			);
		} finally {
			await streamed.clean();
		}
		const context = staged.context;
		await staged.clean();
		staged = undefined;
		expect(existsSync(context)).toBe(false);
		let failedContext: string | undefined;
		await expect(
			stageContext(source, recipe, world.home, {
				run: async (argv) => {
					if (argv[0] === "git" && argv[2] === "archive")
						failedContext = join(String(argv[5]), "..");
					throw new Error("injected bounded stage failure");
				},
			}),
		).rejects.toThrow("injected bounded stage failure");
		expect(failedContext).toBeDefined();
		expect(existsSync(String(failedContext))).toBe(false);
	} finally {
		await staged?.clean();
		world.clean();
	}
});
