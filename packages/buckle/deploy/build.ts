import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	BASE_IMAGE,
	CommitSchema,
	PlatformSchema,
	SeedVersionSchema,
} from "./seed-contract.ts";

const repository = resolve(import.meta.dir, "../../..");
const BuildArgsSchema = z.strictObject({
	source: CommitSchema,
	version: SeedVersionSchema,
	platforms: z
		.string()
		.transform((value) => value.split(","))
		.pipe(z.array(PlatformSchema).min(1)),
	mode: z.enum(["plan", "build", "publish"]),
	metadata: z.string().min(1),
});
export async function main() {
	const { parseArgs } = await import("node:util");
	const { values } = parseArgs({
		options: {
			source: { type: "string" },
			version: { type: "string" },
			platforms: { type: "string", default: "linux/amd64,linux/arm64" },
			mode: { type: "string", default: "plan" },
			metadata: {
				type: "string",
				default: join(tmpdir(), "fleet-buckle-build-metadata.json"),
			},
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"Usage: bun build.ts --source <40hex> --version <experimental semver> --mode plan|build|publish [--platforms linux/amd64,linux/arm64] [--metadata file]",
		);
		return;
	}
	const args = BuildArgsSchema.parse(values);
	const recipe = (await output(["git", "rev-parse", "HEAD"])).trim();
	await output(["git", "cat-file", "-e", `${args.source}^{commit}`]);
	if (
		(
			await output([
				"git",
				"status",
				"--porcelain",
				"--",
				"packages/buckle/deploy",
			])
		).trim()
	)
		throw new Error("Commit seed recipes before building");
	const image = `ghcr.io/klh/fleet/buckle-seed:${args.version}`;
	console.log(
		JSON.stringify({
			event: "buckle-seed.planned",
			sourceCommit: args.source,
			recipeCommit: recipe,
			image,
			platforms: args.platforms,
			baseImage: BASE_IMAGE,
		}),
	);
	if (args.mode === "plan") return;
	if (args.mode === "publish") {
		const RegistrySchema = z.object({
			visibility: z.literal("private"),
			repository: z.object({ full_name: z.literal("klh/fleet") }),
		});
		RegistrySchema.parse(
			JSON.parse(
				await output([
					"gh",
					"api",
					"/user/packages/container/fleet%2Fbuckle-seed",
				]),
			),
		);
	}
	const staged = await stageContext(args.source, recipe);
	try {
		const child = Bun.spawn(
			[
				"docker",
				"buildx",
				"build",
				"--platform",
				args.platforms.join(","),
				"--tag",
				image,
				"--build-arg",
				`SOURCE_COMMIT=${args.source}`,
				"--build-arg",
				`RECIPE_COMMIT=${recipe}`,
				"--build-arg",
				`SEED_VERSION=${args.version}`,
				"--sbom=true",
				"--provenance=mode=max",
				"--metadata-file",
				args.metadata,
				args.mode === "publish" ? "--push" : "--load",
				".",
			],
			{ cwd: staged.context, stdout: "inherit", stderr: "inherit" },
		);
		if (await child.exited) throw new Error("Container build failed");
	} finally {
		await staged.clean();
	}
}
async function output(args: string[], cwd = repository) {
	const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${err}`);
	return out;
}
export async function stageContext(
	source: string,
	recipe: string,
	repo = repository,
) {
	CommitSchema.parse(source);
	CommitSchema.parse(recipe);
	const context = await mkdtemp(join(tmpdir(), "fleet-buckle-seed-"));
	const clean = () => rm(context, { recursive: true, force: true });
	try {
		await mkdir(join(context, "source"));
		const archive = Bun.spawn(["git", "archive", source], {
			cwd: repo,
			stdout: "pipe",
			stderr: "inherit",
		});
		const extract = Bun.spawn(
			["tar", "-xf", "-", "-C", join(context, "source")],
			{ stdin: archive.stdout, stdout: "ignore", stderr: "inherit" },
		);
		if ((await archive.exited) !== 0 || (await extract.exited) !== 0)
			throw new Error("Committed source archive failed");
		for (const name of ["Dockerfile", "bundle.ts"]) {
			const bytes = await output(
				["git", "show", `${recipe}:packages/buckle/deploy/${name}`],
				repo,
			);
			await Bun.write(join(context, name), bytes);
		}
		return { context, clean };
	} catch (error) {
		await clean();
		throw error;
	}
}
if (import.meta.main)
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : "Seed build failed");
		process.exitCode = 1;
	});
