// builddirs.ts — non-package build dirs may be shared with a fresh lane.
// node_modules must be installed inside each checkout: a shared symlink lets
// `bun install --force` in one lane delete dependencies used by every lane.
// W2254.1: a legacy shared node_modules link is NEVER unlinked automatically.
// No point-in-time probe proves an idle checkout — a process can start between
// the verdict and the unlink, and non-harness users are invisible to it — so
// migration stays an explicit operator action.
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export interface DependencyInstallOptions {
	run?: DependencyInstallRunner;
}

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
	repo: string,
	into: string,
	options: DependencyInstallOptions = {},
): DependencyInstallResult {
	const modules = join(into, "node_modules");
	const standing = lstatSync(modules, { throwIfNoEntry: false });
	const hasLock =
		existsSync(join(into, "package.json")) &&
		existsSync(join(into, "bun.lock"));
	if (standing?.isSymbolicLink()) {
		const target = resolve(dirname(modules), readlinkSync(modules));
		if (target !== resolve(repo, "node_modules"))
			return {
				ok: false,
				note: "operator node_modules link preserved; it names a tree outside the Fleet root",
			};
		// W2254.1: legacy shared links are NEVER migrated automatically. The
		// removed probe (worktreeProcessIdentity) was point-in-time: a process
		// can start between a false verdict and the unlink, and non-harness
		// users are invisible to it — no probe proves quiescence. Unlinking a
		// link an active checkout still reads would break that checkout, so
		// the link stands; the checkout keeps working on the shared tree.
		// Migration is an explicit operator action on a provably idle tree:
		// rm <link> && bun install --frozen-lockfile (never automated).
		return {
			ok: true,
			note: `legacy shared node_modules link preserved (W2254.1: automatic migration removed); operator migrates an idle checkout manually: rm ${modules} && ${dependencyInstallArgs().join(" ")}`,
		};
	}
	if (standing?.isDirectory())
		return { ok: true, note: "existing private node_modules kept" };
	if (standing && !standing.isSymbolicLink())
		return { ok: false, note: "node_modules exists but is not a directory" };
	if (!hasLock)
		return {
			ok: true,
			note: "no Bun manifest and lockfile; dependencies not installed",
		};
	const installArgs = dependencyInstallArgs();
	const run: DependencyInstallRunner =
		options.run ??
		((cwd, argv) =>
			Bun.spawnSync(argv, {
				cwd,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				timeout: 300_000,
			}));
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
