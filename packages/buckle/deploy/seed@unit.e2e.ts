import { expect, test } from "@playwright/test";
import { runCli, scratchWorld } from "@klh/test-kit";
import { ServiceSeedDescriptorV1Schema } from "./seed-contract.ts";

test("service descriptor keeps runtime source, recipe and runtime smoke separate", () => {
	const descriptor = {
		schemaVersion: 1,
		family: "service",
		service: "buckle",
		version: "0.1.0-experimental.w2989",
		image: `ghcr.io/klh/fleet/buckle-seed@sha256:${"a".repeat(64)}`,
		sourceCommit: "b".repeat(40),
		recipeCommit: "c".repeat(40),
		architectures: ["amd64", "arm64"],
		runtimeSmokePlatforms: ["linux/arm64"],
		producer: { name: "fleet", repository: "https://github.com/klh/fleet" },
		build: {
			baseImage: `oven/bun:1.4.4-slim@sha256:${"d".repeat(64)}`,
			tool: "docker-buildx",
			provenance: "verified",
			sbom: "verified",
		},
	};
	expect(ServiceSeedDescriptorV1Schema.safeParse(descriptor).success).toBe(
		true,
	);
	for (const change of [
		{ image: "ghcr.io/klh/fleet/buckle-seed:latest" },
		{ sourceCommit: "HEAD" },
		{ family: "tool" },
		{ architectures: ["arm64"], runtimeSmokePlatforms: ["linux/amd64"] },
	])
		expect(
			ServiceSeedDescriptorV1Schema.safeParse({ ...descriptor, ...change })
				.success,
		).toBe(false);
});

test("staging reads immutable commits and excludes untracked data and git history", async () => {
	const { execFileSync } = await import("node:child_process");
	const { mkdir, access } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { stageContext } = await import("./build.ts");
	const world = scratchWorld();
	let staged: Awaited<ReturnType<typeof stageContext>> | undefined;
	try {
		const recipe = join(world.repo, "packages/buckle/deploy");
		await mkdir(recipe, { recursive: true });
		await Bun.write(join(recipe, "Dockerfile"), "FROM scratch\n\n");
		await Bun.write(join(recipe, "bundle.ts"), "export {};\n");
		await Bun.write(join(world.repo, "source.txt"), "committed\n");
		execFileSync("git", ["-C", world.repo, "add", "."]);
		execFileSync("git", [
			"-C",
			world.repo,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"Pinned inputs",
		]);
		const sha = execFileSync("git", ["-C", world.repo, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
		await Bun.write(join(recipe, "Dockerfile"), "MUTATED\n");
		await Bun.write(join(world.repo, "source.txt"), "MUTATED\n");
		await Bun.write(join(world.repo, "untracked.env"), "not an input\n");
		staged = await stageContext(sha, sha, world.repo);
		expect(await Bun.file(join(staged.context, "Dockerfile")).text()).toBe(
			"FROM scratch\n\n",
		);
		expect(
			await Bun.file(join(staged.context, "source/source.txt")).text(),
		).toBe("committed\n");
		await expect(
			access(join(staged.context, "source/untracked.env")),
		).rejects.toThrow();
		await expect(access(join(staged.context, "source/.git"))).rejects.toThrow();
	} finally {
		await staged?.clean();
		world.clean();
	}
});

test("seed builder help works outside a checkout without contacting Docker", () => {
	const world = scratchWorld();
	try {
		const result = runCli(
			new URL("build.ts", import.meta.url).pathname,
			["--help"],
			{ cwd: world.repo, env: world.env },
		);
		expect(result.code, result.err).toBe(0);
		expect(result.out).toContain("--source");
	} finally {
		world.clean();
	}
});
