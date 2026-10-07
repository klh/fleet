// Code-only GUI refresh. One committed source revision, one protected publication.
import {
	chmod,
	lstat,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { syncHarness } from "./sync-harness.ts";

const groups = [
	{
		package: "belt/bin",
		destination: "belt",
		files: [
			"dashboard.ts",
			"dashboard-state.ts",
			"health.ts",
			"remotes.ts",
			"inventory-probe.ts",
			"dashboard-observability.js",
			"klh-theme.ts",
			"vendor/lit.js",
		],
	},
	{
		package: "local/bin",
		destination: "local",
		files: [
			"dashboard.ts",
			"dashboard-health.ts",
			"health.ts",
			"klh-local.ts",
			"dns-reconcile.ts",
			"dashboard-page.html",
			"klh-theme.ts",
			"vendor/lit-shared.js",
		],
	},
] as const;
const within = (parent: string, child: string): boolean => {
	const path = relative(parent, child);
	return (
		path === "" ||
		(!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
	);
};
function git(repo: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(`Dashboard source git ${args[0]} failed`);
	return result.stdout.toString().trim();
}
async function capture(
	repo: string,
	revision: string,
	paths: string[],
	destination: string,
): Promise<void> {
	const archive = Bun.spawn(
		["git", "-C", repo, "archive", revision, ...paths],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const unpack = Bun.spawn(["tar", "-x", "-C", destination], {
		stdin: archive.stdout,
		stdout: "ignore",
		stderr: "pipe",
	});
	const [sourceCode, unpackCode] = await Promise.all([
		archive.exited,
		unpack.exited,
		new Response(archive.stderr).text(),
		new Response(unpack.stderr).text(),
	]);
	if (sourceCode !== 0 || unpackCode !== 0)
		throw new Error("Committed dashboard capture failed");
}
export type RefreshOptions = {
	home: string;
	prefix: string;
	packageRoot?: string;
	shimBin?: string;
	dryRun?: boolean;
};
/** Publisher injection exercises transaction failures without changing runtime services. */
export async function refreshDashboards(
	options: RefreshOptions,
	publish: typeof syncHarness = syncHarness,
): Promise<string> {
	const root = await realpath(
		options.packageRoot ?? join(import.meta.dir, "../.."),
	);
	const repo = git(root, ["rev-parse", "--show-toplevel"]);
	const belt = join(options.home, ".claude/local-llm");
	const local = join(options.home, ".local/klh-local/bin");
	const destinations = { belt, local };
	const files = groups.flatMap((group) =>
		group.files.map((file) => ({
			source: join(root, group.package, file),
			target: join(destinations[group.destination], file),
		})),
	);
	for (const destination of [belt, local])
		files.push({
			source: join(root, "local-llm/observation.ts"),
			target: join(destination, "observation.ts"),
		});
	for (const entry of [
		join(belt, "dashboard.ts"),
		join(local, "dashboard.ts"),
		join(options.prefix, "bin/fleet-board.ts"),
	])
		await stat(entry);
	const installed = await realpath(options.prefix);
	for (const destination of [belt, local]) {
		const target = await realpath(destination);
		if (within(installed, target) || within(target, installed))
			throw new Error(
				"Dashboard target overlaps the installed harness generation; refusing writes",
			);
	}
	if (options.dryRun)
		return `Would refresh ${files.length} external dashboard code files and publish a validated harness generation; no config or processes changed.`;
	const lock = `${options.prefix}.refresh-lock`;
	await mkdir(lock); // Exclusive before any backup or target mutation.
	let stage: string | undefined;
	const backups = new Map<string, { data: Buffer; mode: number } | null>();
	try {
		await writeFile(
			join(lock, "owner.json"),
			JSON.stringify({
				pid: process.pid,
				host: hostname(),
				createdAt: Date.now(),
			}),
			{ mode: 0o600 },
		);
		const revision = git(repo, ["rev-parse", "HEAD"]);
		const paths = [
			...new Set(files.map((file) => relative(repo, file.source))),
		];
		if (
			git(repo, [
				"status",
				"--porcelain",
				"--untracked-files=all",
				"--",
				...paths,
			])
		)
			throw new Error(
				"Commit reviewed dashboard sources before refresh; working payload is dirty",
			);
		stage = await mkdtemp(join(dirname(options.prefix), ".dashboard-capture-"));
		await capture(repo, revision, paths, stage);
		for (const file of files) {
			if (!(await lstat(join(stage, relative(repo, file.source)))).isFile())
				throw new Error(
					"Dashboard capture must contain regular files, not mutable symlinks",
				);
		}
		for (const file of files) {
			let old: { data: Buffer; mode: number } | null = null;
			try {
				old = {
					data: await readFile(file.target),
					mode: (await stat(file.target)).mode & 0o777,
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			backups.set(file.target, old);
			await mkdir(dirname(file.target), { recursive: true });
			await copyFile(
				join(stage, relative(repo, file.source)),
				`${file.target}.refreshing`,
			);
			await rename(`${file.target}.refreshing`, file.target);
		}
		for (const entry of [
			join(belt, "dashboard.ts"),
			join(local, "dashboard.ts"),
		]) {
			const result = await Bun.build({ entrypoints: [entry], target: "bun" });
			if (!result.success) throw new Error(result.logs.map(String).join("\n"));
		}
		await publish({
			dryRun: false,
			yes: true,
			json: false,
			verbose: false,
			repo: join(root, "suspenders"),
			prefix: options.prefix,
			llmHome: belt,
			shimBin: options.shimBin ?? join(options.home, ".local/bin"),
			expectedRevision: revision,
		});
		return `Refreshed ${files.length} dashboard code files at ${revision}. Restart com.suspenders.belt-dashboard, com.suspenders.klh-local-bar and com.suspenders.board to activate.`;
	} catch (error) {
		for (const [target, old] of backups) {
			if (old) {
				await writeFile(`${target}.refreshing`, old.data);
				await chmod(`${target}.refreshing`, old.mode);
				await rename(`${target}.refreshing`, target);
			} else await rm(target, { force: true });
			await rm(`${target}.refreshing`, { force: true });
		}
		throw error;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
		await rm(lock, { recursive: true, force: true });
	}
}
if (import.meta.main) {
	const home = process.env.HOME ?? "";
	console.log(
		await refreshDashboards({
			home,
			prefix:
				process.env.SUSPENDERS_PREFIX ?? join(home, ".claude/hooks/suspenders"),
			shimBin: process.env.SUSPENDERS_SHIM_BIN,
			dryRun: process.argv.includes("--dry-run"),
		}),
	);
}
