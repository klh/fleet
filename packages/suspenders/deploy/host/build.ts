import { resolve } from "node:path";
import { z } from "zod";
import {
	defineVerb,
	parseVerb,
	renderVerbHelp,
} from "../../hooks/lib/verb-kit.ts";
import { CommitSchema, PlatformSchema, VersionSchema } from "./contract.ts";

export const BuildOptionsSchema = z.strictObject({
	source: CommitSchema,
	recipe: CommitSchema,
	version: VersionSchema,
	platform: PlatformSchema,
});
export function buildPlan(raw: unknown) {
	const options = BuildOptionsSchema.parse(raw);
	return {
		...options,
		localOnly: true,
		continuity: "unverified",
		image: `fleet-supervisor-seed:${options.version}-${options.platform.split("/")[1]}`,
	};
}

export async function command(argv: string[], cwd?: string) {
	const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${argv[0]} ${argv[1]} failed: ${err}`);
	return out;
}
export type StageRunner = (
	argv: readonly string[],
	cwd: string,
) => Promise<Uint8Array>;

const CommitEpochSchema = z
	.string()
	.regex(/^(0|[1-9]\d{0,11})$/)
	.transform(Number)
	.pipe(z.number().int().nonnegative().max(253402300799));
/** OCI label time is the later immutable committer epoch, never wall-clock fallback. */
export async function imageCreated(
	source: string,
	recipe: string,
	repository: string,
	run?: StageRunner,
) {
	try {
		CommitSchema.parse(source);
		CommitSchema.parse(recipe);
		const read: StageRunner =
			run ??
			(async (argv, cwd) => {
				const { hostProcess } = await import("./process.ts");
				const result = await hostProcess(argv, {
					cwd,
					timeoutMs: 10000,
					maxBytes: 4096,
				});
				if (result.code !== 0 || result.signal !== null)
					throw new Error("Commit read failed");
				return result.stdout;
			});
		const text = async (argv: string[]) =>
			new TextDecoder("utf-8", { fatal: true })
				.decode(await read(argv, repository))
				.trim();
		const epoch = async (commit: string) => {
			if (
				(await text([
					"git",
					"--no-replace-objects",
					"cat-file",
					"-t",
					commit,
				])) !== "commit"
			)
				throw new Error("Commit object required");
			return CommitEpochSchema.parse(
				await text([
					"git",
					"--no-replace-objects",
					"show",
					"-s",
					"--format=%ct",
					commit,
				]),
			);
		};
		const [sourceEpochSeconds, recipeEpochSeconds] = await Promise.all([
			epoch(source),
			epoch(recipe),
		]);
		const epochSeconds = Math.max(sourceEpochSeconds, recipeEpochSeconds);
		return {
			created: new Date(epochSeconds * 1000).toISOString(),
			epochSeconds,
			sourceEpochSeconds,
			recipeEpochSeconds,
		};
	} catch {
		throw new Error("Immutable commit timestamp unavailable");
	}
}

export async function stageContext(
	source: string,
	recipe: string,
	repository: string,
	options: { run?: StageRunner } = {},
): Promise<{
	context: string;
	clean(): Promise<void>;
}> {
	CommitSchema.parse(source);
	CommitSchema.parse(recipe);
	const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const context = await mkdtemp(join(tmpdir(), "fleet-host-build-"));
	const clean = () => rm(context, { recursive: true, force: true });
	const runCommand = async (argv: string[], cwd: string) =>
		options.run
			? new TextDecoder("utf-8", { fatal: true }).decode(
					await options.run(argv, cwd),
				)
			: command(argv, cwd);
	try {
		await mkdir(join(context, "source"));
		await mkdir(join(context, "recipe"));
		if (options.run) {
			const archivePath = join(context, "source.tar");
			await options.run(
				[
					"git",
					"--no-replace-objects",
					"archive",
					"--format=tar",
					"--output",
					archivePath,
					source,
				],
				repository,
			);
			await options.run(
				["tar", "-xf", archivePath, "-C", join(context, "source")],
				repository,
			);
			await rm(archivePath);
		} else {
			const archive = Bun.spawn(
				["git", "--no-replace-objects", "archive", source],
				{
					cwd: repository,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const extract = Bun.spawn(
				["tar", "-xf", "-", "-C", join(context, "source")],
				{ stdin: archive.stdout, stdout: "ignore", stderr: "pipe" },
			);
			const [a, b, ae, be] = await Promise.all([
				archive.exited,
				extract.exited,
				new Response(archive.stderr).text(),
				new Response(extract.stderr).text(),
			]);
			if (a || b)
				throw new Error(`Committed source staging failed: ${ae}${be}`);
		}
		for (const name of [
			"Dockerfile",
			"bundle.ts",
			"contract.ts",
			"health.ts",
			"probe.ts",
		]) {
			const path =
				name === "probe.ts"
					? "packages/suspenders/deploy/healthcheck/probe.ts"
					: `packages/suspenders/deploy/host/${name}`;
			const entry = await runCommand(
				["git", "--no-replace-objects", "ls-tree", "-z", recipe, "--", path],
				repository,
			);
			if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry))
				throw new Error("Recipe must be a committed regular file");
			const bytes = await runCommand(
				["git", "--no-replace-objects", "show", `${recipe}:${path}`],
				repository,
			);
			await Bun.write(
				join(context, name === "Dockerfile" ? name : `recipe/${name}`),
				bytes,
			);
		}
		return { context, clean };
	} catch (error) {
		await clean();
		throw error;
	}
}

const verb = defineVerb({
	name: "build",
	usage:
		"build.ts --source COMMIT --recipe COMMIT --version EXPERIMENTAL --platform linux/amd64|linux/arm64 [--plan]",
	flags: ["--source", "--recipe", "--version", "--platform"],
	reqFlags: ["--source", "--recipe", "--version", "--platform"],
	switches: ["--plan"],
});
if (import.meta.main) {
	const parsed = parseVerb(verb, process.argv.slice(2));
	if (!parsed.ok) {
		console.error(renderVerbHelp(verb));
		process.exit(2);
	}
	const plan = buildPlan({
		source: parsed.parsed.flag("--source"),
		recipe: parsed.parsed.flag("--recipe"),
		version: parsed.parsed.flag("--version"),
		platform: parsed.parsed.flag("--platform"),
	});
	const repository = resolve(import.meta.dir, "../../../..");
	for (const name of ["build.ts", "contract.ts"]) {
		const committed = await command(
			[
				"git",
				"--no-replace-objects",
				"show",
				`${plan.recipe}:packages/suspenders/deploy/host/${name}`,
			],
			repository,
		);
		if (committed !== (await Bun.file(resolve(import.meta.dir, name)).text()))
			throw new Error("Build helper must match committed recipe");
	}
	const imageMetadata = {
		...(await imageCreated(plan.source, plan.recipe, repository)),
		derivation: "max(sourceCommit.committerEpoch,recipeCommit.committerEpoch)",
	};
	if (parsed.parsed.flag("--plan")) {
		console.log(JSON.stringify({ ...plan, imageMetadata }, null, 2));
		process.exit(0);
	}
	const staged = await stageContext(plan.source, plan.recipe, repository);
	try {
		const argv = [
			"docker",
			"buildx",
			"build",
			"--platform",
			plan.platform,
			"--load",
			"--provenance=mode=max",
			"--sbom=true",
			"--build-arg",
			`SOURCE_COMMIT=${plan.source}`,
			"--build-arg",
			`RECIPE_COMMIT=${plan.recipe}`,
			"--build-arg",
			`VERSION=${plan.version}`,
			"--build-arg",
			`CREATED=${imageMetadata.created}`,
			"--tag",
			plan.image,
			"--metadata-file",
			`${staged.context}/metadata.json`,
			".",
		];
		const child = Bun.spawn(argv, {
			cwd: staged.context,
			stdout: "inherit",
			stderr: "inherit",
		});
		if ((await child.exited) !== 0) throw new Error("Local HOST build failed");
		console.log(
			JSON.stringify({
				...plan,
				imageMetadata,
				argv,
				metadata: await Bun.file(`${staged.context}/metadata.json`).json(),
			}),
		);
	} finally {
		await staged.clean();
	}
}
