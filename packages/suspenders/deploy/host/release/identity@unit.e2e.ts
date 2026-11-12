import { productionDriver } from "./registry.ts";
import type { ReleaseDriver } from "./workflow.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { hostProcess } from "../process.ts";
import { publisherIdentity, PUBLISHER_FILES } from "./identity.ts";
test("publisher pins its OWN committed helpers independently from image recipe and refuses substitution @unit", async () => {
	const world = scratchWorld();
	const run = async (argv: readonly string[], cwd: string) => {
		const result = await hostProcess(argv, {
			cwd,
			timeoutMs: 2000,
			maxBytes: 1024 * 1024,
		});
		if (result.code !== 0 || result.signal)
			throw Error("Fixture git command refused");
		return result.stdout;
	};
	const git = async (args: string[]) =>
		new TextDecoder().decode(await run(["git", ...args], world.home)).trim();
	try {
		await git(["init"]);
		for (const path of PUBLISHER_FILES) {
			const file = join(world.home, path);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, "// committed publisher fixture\n");
		}
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
		const commit = await git(["rev-parse", "HEAD"]);
		await writeFile(
			join(world.home, PUBLISHER_FILES[0]),
			"// replaced object content",
		);
		await git(["add", "."]);
		await git([
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"replacement",
		]);
		const replacement = await git(["rev-parse", "HEAD"]);
		await git(["reset", "--hard", commit]);
		await git(["replace", commit, replacement]);
		expect(await git(["show", `${commit}:${PUBLISHER_FILES[0]}`])).toContain(
			"replaced object",
		);
		const identity = await publisherIdentity(world.home, run);
		expect(identity.publisherCommit).toBe(commit);
		expect(identity.helpers).toHaveLength(PUBLISHER_FILES.length);
		expect(
			identity.helpers.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
		).toBe(true);
		await writeFile(
			join(world.home, PUBLISHER_FILES[0]),
			"// substituted helper",
		);
		await expect(publisherIdentity(world.home, run)).rejects.toThrow(
			"Publisher helper",
		);
	} finally {
		world.clean();
	}
});

test("production stage adapter ignores Gitreplace for source/recipe and original contract compatibility @unit", async () => {
	const world = scratchWorld();
	const repository = resolve(import.meta.dir, "../../../../..");
	const command = async (
		argv: string[],
		cwd: string,
		timeout = 2000,
		signal?: AbortSignal,
	) => {
		const result = await hostProcess(argv, {
			cwd,
			timeoutMs: Math.min(timeout, 2000),
			maxBytes: 8 * 1024 * 1024,
			signal,
		});
		if (result.code !== 0 || result.signal)
			throw Error(
				`Fixture stage command refused: ${argv.slice(0, 3).join(" ")}`,
			);
		return result.stdout;
	};
	const git = async (args: string[]) =>
		new TextDecoder()
			.decode(await command(["git", ...args], world.home))
			.trim();
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
	let staged: Awaited<ReturnType<ReleaseDriver["stage"]>> | undefined;
	try {
		await git(["init"]);
		for (const path of PUBLISHER_FILES) {
			const file = join(world.home, path);
			await mkdir(dirname(file), { recursive: true });
			await Bun.write(
				file,
				await Bun.file(join(repository, path)).arrayBuffer(),
			);
		}
		const host = join(world.home, "packages/suspenders/deploy/host");
		await mkdir(join(host, "../healthcheck"), { recursive: true });
		for (const name of ["Dockerfile", "bundle.ts", "health.ts"])
			await writeFile(join(host, name), `original-${name}`);
		await writeFile(join(host, "../healthcheck/probe.ts"), "original-probe");
		await writeFile(join(world.home, "source-marker"), "original-source");
		const original = await commit();
		await writeFile(join(host, "Dockerfile"), "replacement-Dockerfile");
		await writeFile(join(world.home, "source-marker"), "replacement-source");
		const replacement = await commit();
		await git(["replace", original, replacement]);
		const driver = await productionDriver(
			world.home,
			async () => {
				throw Error("No network in stage test");
			},
			{ command },
		);
		staged = await driver.stage(original, original);
		expect(
			await Bun.file(join(staged.context, "source/source-marker")).text(),
		).toBe("original-source");
		expect(await Bun.file(join(staged.context, "Dockerfile")).text()).toBe(
			"original-Dockerfile",
		);
		expect(staged.recipeFiles).toHaveLength(5);
		await staged.clean();
		staged = undefined;
		await git(["replace", "-d", original]);
		await writeFile(
			join(host, "contract.ts"),
			"// incompatible original recipe",
		);
		const badRecipe = await commit();
		await git(["reset", "--hard", replacement]);
		await git(["replace", badRecipe, replacement]);
		const again = await productionDriver(
			world.home,
			async () => {
				throw Error("No network in stage test");
			},
			{ command },
		);
		await expect(
			again.stage(original, badRecipe).then((value) => {
				staged = value;
				return value;
			}),
		).rejects.toThrow("Image recipe contract");
	} finally {
		await staged?.clean();
		world.clean();
	}
});
