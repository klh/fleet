import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { StepContext, StepResult } from "./install-run.ts";

const SOURCE_PATHS = [
	"packages/suspenders/hooks",
	"packages/suspenders/scripts",
	"packages/suspenders/deploy",
	"packages/suspenders/package.json",
	"packages/belt/bin",
	"packages/belt/package.json",
	"packages/local-llm",
	"packages/blam/src",
	"packages/blam/package.json",
];
const HOOK_ITEMS = [
	"bin",
	"lib",
	"board-html",
	"coord",
	"board",
	"gates",
	"launchd",
	"rules",
	"gate.ts",
	"session-start.ts",
	"session-end.ts",
	"knowledgeworker.md",
];
const ENTRYPOINTS = [
	"hooks/gate.ts",
	"hooks/session-start.ts",
	"hooks/session-end.ts",
	"hooks/bin/coord.ts",
	"hooks/bin/work.ts",
	"hooks/bin/fleet-loop.ts",
	"hooks/bin/morph.ts",
	"scripts/dispatch-next.ts",
	"scripts/supervise.ts",
];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function git(repo: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(`Git source verification failed: ${args[0]}`);
	return result.stdout.toString().trim();
}

async function command(argv: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(argv, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 120_000,
	});
	const [code, output, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(
			`${basename(argv[0])} validation failed: ${(error || output).slice(-1500)}`,
		);
}

async function archive(
	repo: string,
	revision: string,
	destination: string,
): Promise<void> {
	const source = Bun.spawn(
		["git", "-C", repo, "archive", revision, ...SOURCE_PATHS],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const unpack = Bun.spawn(["tar", "-x", "-C", destination], {
		stdin: source.stdout,
		stdout: "ignore",
		stderr: "pipe",
	});
	const [sourceCode, unpackCode] = await Promise.all([
		source.exited,
		unpack.exited,
		new Response(source.stderr).text(),
		new Response(unpack.stderr).text(),
	]);
	if (sourceCode !== 0 || unpackCode !== 0)
		throw new Error("Committed harness archive failed");
}

function link(target: string, destination: string): void {
	rmSync(destination, { recursive: true, force: true });
	symlinkSync(target, destination);
}

async function validate(stage: string): Promise<string> {
	const payload = join(stage, ".harness");
	const suspenders = join(payload, "packages/suspenders");
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const files = [
		...new Bun.Glob("**/*").scanSync({ cwd: payload, onlyFiles: true }),
	];
	const hash = new Bun.CryptoHasher("sha256");
	for (const file of files
		.filter((file) => !file.includes("node_modules/"))
		.sort()) {
		const content = readFileSync(join(payload, file));
		if (file.endsWith(".ts") && !file.endsWith(".d.ts"))
			transpiler.transformSync(content.toString("utf8"));
		hash.update(file).update("\0").update(content).update("\0");
	}
	for (const relative of ENTRYPOINTS) {
		const result = await Bun.build({
			entrypoints: [join(suspenders, relative)],
			target: "bun",
			write: false,
		});
		if (!result.success)
			throw new Error(
				`Staged import graph failed (${relative}): ${result.logs.map(String).join("; ").slice(0, 1500)}`,
			);
	}
	// This import is side-effect-free; CLI entrypoints are built, never executed.
	for (const module of [
		"hooks/board/prompt-transform.ts",
		"hooks/lib/morph.ts",
	])
		await command(
			[
				process.execPath,
				"-e",
				"await import(process.argv[1])",
				join(suspenders, module),
			],
			stage,
		);
	return hash.digest("hex");
}

/** Code-only publication. No runtime home, service manager, model or Caddy operations. */
export async function syncHarness(
	ctx: StepContext & { expectedRevision?: string },
	publish: (source: string, destination: string) => void = renameSync,
): Promise<StepResult> {
	const repo = git(ctx.repo, ["rev-parse", "--show-toplevel"]);
	const revision = git(repo, ["rev-parse", "HEAD"]);
	if (ctx.expectedRevision && ctx.expectedRevision !== revision)
		throw new Error(
			"Source revision changed during dashboard refresh; rerun from a consistent capture",
		);
	if (
		git(repo, [
			"status",
			"--porcelain",
			"--untracked-files=no",
			"--",
			...SOURCE_PATHS,
		])
	)
		throw new Error(
			"Commit reviewed harness changes before code-only sync; working payload is dirty",
		);
	const prefix = resolve(ctx.prefix),
		parent = dirname(prefix);
	if (
		lstatSync(prefix, { throwIfNoEntry: false })?.isSymbolicLink() &&
		!existsSync(prefix)
	)
		throw new Error("Installed prefix symlink is broken; repair before sync");
	if (prefix === repo || prefix.startsWith(`${repo}/`))
		throw new Error("Harness prefix must be outside the source repository");
	mkdirSync(parent, { recursive: true });
	const lock = `${prefix}.sync-lock`;
	let stage: string | undefined;
	const backup = `${prefix}.before-sync-${Date.now()}-${crypto.randomUUID()}`;
	const generation = `${prefix}.generation-${revision.slice(0, 12)}-${crypto.randomUUID()}`;
	let oldLink: string | null = null;
	let backedUp = false,
		published = false;
	const shims: { path: string; old: string | null }[] = [];
	const pointer = `${prefix}.next-${crypto.randomUUID()}`;
	const temporaryShims: string[] = [];
	mkdirSync(lock); // Exclusive directory lock; all subsequent setup is covered by finally.
	try {
		stage = mkdtempSync(join(parent, `.${basename(prefix)}-stage-`));
		oldLink =
			existsSync(prefix) && lstatSync(prefix).isSymbolicLink()
				? readlinkSync(prefix)
				: null;
		if (existsSync(prefix)) {
			const installed = realpathSync(prefix);
			const managed = new Set([
				...HOOK_ITEMS,
				".harness",
				"scripts",
				"local-llm",
				"blam",
				"node_modules",
				"package.json",
				"bun.lock",
				"harness-receipt.json",
			]);
			cpSync(installed, stage, {
				recursive: true,
				dereference: false,
				filter: (source) =>
					!managed.has(relative(installed, source).split(/[\\/]/)[0]),
			});
		}
		const payload = join(stage, ".harness");
		rmSync(payload, { recursive: true, force: true });
		mkdirSync(payload);
		await archive(repo, revision, payload);
		const packageRoot = join(payload, "packages");
		const suspenders = join(packageRoot, "suspenders");
		const manifest = JSON.parse(
			readFileSync(join(suspenders, "package.json"), "utf8"),
		);
		for (const name of ["suspenders", "belt", "local-llm", "blam"]) {
			const path = join(packageRoot, name, "package.json");
			const item = JSON.parse(readFileSync(path, "utf8"));
			delete item.devDependencies;
			delete item.workspaces;
			writeFileSync(path, JSON.stringify(item));
		}
		writeFileSync(
			join(stage, "package.json"),
			JSON.stringify({
				name: "fleet-installed-harness",
				private: true,
				type: "module",
				dependencies: Object.fromEntries(
					Object.entries(manifest.dependencies).filter(
						([_name, version]) =>
							typeof version === "string" && !version.startsWith("workspace:"),
					),
				),
			}),
		);
		rmSync(join(stage, "node_modules"), { recursive: true, force: true });
		rmSync(join(stage, "bun.lock"), { force: true });
		// Bun offline install does not save a lock by default: resolve one first,
		// then require that exact dependency graph for materialization. The root
		// manifest contains production dependencies only; Bun's production +
		// lockfile-only combination can incorrectly return without writing a lock.
		await command(
			[
				process.execPath,
				"install",
				"--offline",
				"--ignore-scripts",
				"--lockfile-only",
				"--save-text-lockfile",
			],
			stage,
		);
		await command(
			[
				process.execPath,
				"install",
				"--production",
				"--offline",
				"--ignore-scripts",
				"--frozen-lockfile",
			],
			stage,
		);
		mkdirSync(join(stage, "node_modules"), { recursive: true });
		link("../.harness/packages/blam", join(stage, "node_modules/blam"));
		for (const item of HOOK_ITEMS) {
			if (!existsSync(join(suspenders, "hooks", item)))
				throw new Error(`Missing harness payload: ${item}`);
			link(join(".harness/packages/suspenders/hooks", item), join(stage, item));
		}
		link(".harness/packages/suspenders/scripts", join(stage, "scripts"));
		link(".harness/packages/local-llm", join(stage, "local-llm"));
		link(".harness/packages/blam", join(stage, "blam"));
		const digest = await validate(stage);
		const dependencyLock = ["bun.lock", "bun.lockb"]
			.map((file) => join(stage, file))
			.find((file) => existsSync(file));
		if (
			!dependencyLock &&
			Object.values(manifest.dependencies as Record<string, string>).some(
				(value) => !value.startsWith("workspace:"),
			)
		)
			throw new Error(
				"Dependency installation did not produce a verifiable lockfile",
			);
		const receipt = {
			schema: "fleet.harness.v1",
			revision,
			source: repo,
			payloadSha256: digest,
			dependencyLockSha256: dependencyLock
				? new Bun.CryptoHasher("sha256")
						.update(readFileSync(dependencyLock))
						.digest("hex")
				: null,
			installedAt: new Date().toISOString(),
			backup: oldLink ?? (existsSync(prefix) ? backup : null),
		};
		writeFileSync(
			join(stage, "harness-receipt.json"),
			JSON.stringify(receipt, null, 2),
			{ mode: 0o600 },
		);
		mkdirSync(ctx.shimBin, { recursive: true });
		for (const name of ["coord", "work", "dispatch"]) {
			const path = join(ctx.shimBin, name);
			if (existsSync(path) && lstatSync(path).isSymbolicLink())
				throw new Error(`Refusing symlink shim: ${name}`);
			shims.push({
				path,
				old: existsSync(path) ? readFileSync(path, "utf8") : null,
			});
		}
		renameSync(stage, generation);
		// Existing symlink replacement is atomic. First directory migration has a
		// short rename gap; every publication error restores the original directory.
		if (existsSync(prefix) && !oldLink) {
			renameSync(prefix, backup);
			backedUp = true;
		}
		symlinkSync(generation, pointer);
		publish(pointer, prefix);
		published = true;
		for (const shim of shims) {
			const name = basename(shim.path);
			const target =
				name === "dispatch"
					? join(prefix, "scripts/dispatch-next.ts")
					: join(prefix, "bin", `${name}.ts`);
			const temp = `${shim.path}.${crypto.randomUUID()}.tmp`;
			temporaryShims.push(temp);
			writeFileSync(
				temp,
				`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(target)} "$@"\n`,
				{ mode: 0o755 },
			);
			publish(temp, shim.path);
		}
		return {
			status: "ok",
			note: `harness code synced at ${revision.slice(0, 12)}; no services restarted`,
			detail: JSON.stringify(receipt),
		};
	} catch (error) {
		if (published) {
			rmSync(prefix, { force: true });
			if (oldLink) symlinkSync(oldLink, prefix);
			else if (backedUp) renameSync(backup, prefix);
			for (const shim of shims) {
				if (shim.old === null) rmSync(shim.path, { force: true });
				else writeFileSync(shim.path, shim.old, { mode: 0o755 });
			}
		} else if (backedUp) renameSync(backup, prefix);
		if (stage) rmSync(stage, { recursive: true, force: true });
		rmSync(generation, { recursive: true, force: true });
		throw error;
	} finally {
		rmSync(pointer, { force: true });
		for (const temp of temporaryShims) rmSync(temp, { force: true });
		rmSync(lock, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const argument = (name: string) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? undefined : process.argv[index + 1];
	};
	const repo = argument("--repo"),
		prefix = argument("--prefix"),
		shimBin = argument("--shim-bin");
	if (!repo || !prefix || !shimBin)
		throw new Error("sync-harness requires --repo, --prefix and --shim-bin");
	console.log(
		(
			await syncHarness({
				repo,
				prefix,
				shimBin,
				llmHome: "",
				dryRun: false,
				yes: true,
				json: false,
				verbose: false,
			})
		).note,
	);
}
