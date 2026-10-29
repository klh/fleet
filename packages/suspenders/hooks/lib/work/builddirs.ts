// builddirs.ts — non-package build dirs may be shared with a fresh lane.
// node_modules must be installed inside each checkout: a shared symlink lets
// `bun install --force` in one lane delete dependencies used by every lane.
import { existsSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function symlinkBuildDirs(repo: string, into: string): void {
	for (const d of [".venv", "vendor", "target"]) {
		const src = join(repo, d);
		const dst = join(into, d);
		if (existsSync(src) && !existsSync(dst)) {
			try {
				symlinkSync(src, dst, "dir");
			} catch {
				// best effort — a missing symlink just means a local install
			}
		}
	}
}

export interface DependencyInstallResult {
	ok: boolean;
	note: string;
}

export type DependencyInstallRunner = (
	cwd: string,
	argv: string[],
) => { exitCode: number };

export const dependencyInstallArgs = (
	platform = process.platform,
): string[] => [
	"bun",
	"install",
	"--frozen-lockfile",
	`--backend=${platform === "darwin" ? "clonefile" : "copyfile"}`,
];

/** Build a private dependency tree after checkout. macOS clonefile shares
 * disk blocks without sharing writable package inodes; other platforms use
 * copies. The lockfile stays unchanged and no worker installs through a link. */
export function installWorktreeDependencies(
	into: string,
	run: DependencyInstallRunner = (cwd, argv) =>
		Bun.spawnSync(argv, {
			cwd,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			timeout: 300_000,
		}),
): DependencyInstallResult {
	const modules = join(into, "node_modules");
	const standing = lstatSync(modules, { throwIfNoEntry: false });
	if (standing?.isSymbolicLink())
		return {
			ok: false,
			note: "shared node_modules link preserved; pause this checkout and replace the link with a private frozen install before launch",
		};
	if (standing?.isDirectory())
		return { ok: true, note: "existing private node_modules kept" };
	if (standing)
		return { ok: false, note: "node_modules exists but is not a directory" };
	if (
		!existsSync(join(into, "package.json")) ||
		!existsSync(join(into, "bun.lock"))
	)
		return {
			ok: true,
			note: "no Bun manifest and lockfile; dependencies not installed",
		};
	const installArgs = dependencyInstallArgs();
	const result = run(into, installArgs);
	if (result.exitCode !== 0) {
		// A failed first install can leave an incomplete private tree. Clear only
		// that new directory so a later claim/launch can retry from bun.lock.
		if (lstatSync(modules, { throwIfNoEntry: false })?.isDirectory())
			rmSync(modules, { recursive: true, force: true });
		return {
			ok: false,
			note: `private dependency install exited ${result.exitCode}; rerun ${installArgs.join(" ")} inside ${into}`,
		};
	}
	if (!lstatSync(modules, { throwIfNoEntry: false })?.isDirectory())
		return {
			ok: false,
			note: "private dependency install returned success without a node_modules directory",
		};
	return { ok: true, note: "private node_modules installed from bun.lock" };
}
