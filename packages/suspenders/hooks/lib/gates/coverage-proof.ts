// coverage-proof.ts — W1262: the Sinai coverage-proof classifier, split out of
// review-lane.ts so the W1258 regression has a unit face. review-lane.ts keeps
// the orchestration (git, scratch worktree, bun test run); this module owns the
// classification: a scratch "Cannot find module" that names a module the diff
// ADDED is the proof itself — the change is what provides the module — so it
// must not classify as an environmental failure. Only a missing import that
// does NOT resolve onto a diff-added module is tooling/dependency noise.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { z } from "zod";

// test paths only: the proof keeps these, reverses everything else
export const TEST_FILE =
	/(^|\/)(tests?|__tests__)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)(test|spec)_/;

type ProofGit = (args: string[]) => { code: number; out: string };

export type ProofRunnerGroup =
	| { runner: "bun"; files: string[] }
	| { runner: "playwright"; config: string; files: string[] };

function proofRunners(
	testFiles: string[],
	tip: Set<string>,
	baseline: Set<string>,
) {
	const bunRunnable = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test|spec)_|_test_/;
	const playwrightEntry = /\.e2e\.[cm]?[jt]sx?$/;
	const isBun = (file: string) =>
		!playwrightEntry.test(file) && bunRunnable.test(file);
	const provable = testFiles.filter(isBun);
	const groups: ProofRunnerGroup[] = provable.length
		? [{ runner: "bun", files: provable }]
		: [];
	const playwright = new Map<string, string[]>();
	const unsupported: string[] = [];
	for (const file of testFiles) {
		if (isBun(file)) continue;
		// Helpers/configs are restored with tests, but are not executable specs.
		if (!playwrightEntry.test(file)) continue;
		const member = file.match(/^packages\/([^/]+)\//);
		const config = member
			? `packages/${member[1]}/test/playwright.config.ts`
			: file.startsWith("tests/")
				? "tests/playwright.config.ts"
				: null;
		if (!config || !tip.has(config) || !baseline.has(config)) {
			unsupported.push(file);
			continue;
		}
		const files = playwright.get(config) ?? [];
		files.push(file);
		playwright.set(config, files);
	}
	for (const [config, files] of playwright)
		groups.push({ runner: "playwright", config, files });
	return { provable, runnerGroups: groups, unsupported };
}

/** Model-facing review text; keep the same exact objects as the proof. */
export function reviewedDiff(
	base: string,
	commit: string,
	git: ProofGit,
): string {
	const result = git(["--no-replace-objects", "diff", `${base}...${commit}`]);
	if (result.code !== 0 || result.out.length > 512_000)
		throw new Error(
			"review-lane: full exact diff unavailable or exceeds review budget; decompose before approval",
		);
	return result.out;
}

/** Exact receipt IDs only: mutable refs must never change the proof input. */
export function coverageProofManifest(
	base: string,
	commit: string,
	git: ProofGit,
) {
	if (![base, commit].every((id) => /^[0-9a-f]{40}$/.test(id)))
		throw new Error("coverage proof requires full immutable commit IDs");
	const read = (...args: string[]): string => {
		const result = git(["--no-replace-objects", ...args]);
		if (result.code !== 0)
			throw new Error(`coverage proof git ${args[0]} failed`);
		return result.out.trim();
	};
	for (const id of [base, commit])
		if (read("cat-file", "-t", id) !== "commit")
			throw new Error("coverage proof object is not a commit");
	const range = `${base}...${commit}`;
	const paths = (...args: string[]) =>
		read(...args)
			.split("\n")
			.filter(Boolean);
	const changed = paths("diff", "--name-only", range);
	const tip = new Set(paths("ls-tree", "-r", "--name-only", commit));
	const testFiles = changed.filter((f) => TEST_FILE.test(f) && tip.has(f));
	const mergeBase = read("merge-base", base, commit);
	const baseline = new Set(paths("ls-tree", "-r", "--name-only", mergeBase));
	const runners = proofRunners(testFiles, tip, baseline);
	const skip = testFiles.length === 0 ? "no test files in diff" : null;
	return {
		base,
		commit,
		range,
		changed,
		testFiles,
		...runners,
		skip,
		mergeBase,
		addedProd: paths("diff", "--name-only", "--diff-filter=A", range).filter(
			(f) => !TEST_FILE.test(f),
		),
	};
}

/** Repo-relative package.json manifests for every packages/<pkg>/ path in a
 *  changed-path list — production files INCLUDED, not just tests. The proof
 *  scratch shares node_modules per manifest; deriving from test paths alone
 *  left a prod file's cross-package import (suspenders script → buckle
 *  source → @klh/telemetry) unresolved in the scratch, erroring reviews
 *  whose content was fine (the W2633 trail). changed = `git diff
 *  --name-only main...branch` output. */
export const changedPackageManifests = (
	changed: readonly string[],
): string[] => [
	...new Set(
		changed
			.filter((path) => /^packages\/[^/]+\//.test(path))
			.map((path) => `${path.split("/").slice(0, 2).join("/")}/package.json`),
	),
];

export type Proof = {
	status: "proved" | "no-coverage" | "skipped" | "error" | "unknown";
	detail: string;
	failed?: number;
	passed?: number;
	/** W1294.9.1.1: true when every changed path is a test file — the
	 *  no-coverage status is tautological and rides as advisory only. */
	purePort?: boolean;
};

/** W1294.9.1.1: a diff whose changed paths are ALL test files (renames and
 *  deletions included) is a pure test port — the change IS the test files,
 *  so "tests pass without the change" is true by construction and the
 *  no-coverage signal carries no information. The classifier keeps the
 *  status; the review verdict demotes it to advisory only under this
 *  predicate. changed = `git diff --name-only main...branch` output. */
export const pureTestDiff = (changed: readonly string[]): boolean =>
	changed.length > 0 && changed.every((f) => TEST_FILE.test(f));

// one missing import: bun prints the specifier verbatim (extensionless
// relative specs stay extensionless) plus the importer's absolute path
// (`error: Cannot find module './x' from '/abs/dir/y.test.ts'`), first
// unresolvable import per file.
export type MissingImport = { spec: string; importer: string };
export type AddedWorkspaceDependency = { packageDir: string; name: string };

// Reversing a branch also reverses newly declared workspace links. A restored
// test may then fail to resolve a package that the branch explicitly supplies.
export const addedWorkspaceDependencies = (
	beforeJson: string,
	afterJson: string,
	manifestPath: string,
): AddedWorkspaceDependency[] => {
	if (!/^packages\/[^/]+\/package\.json$/.test(manifestPath)) return [];
	try {
		const before = JSON.parse(beforeJson) as Record<string, unknown>;
		const after = JSON.parse(afterJson) as Record<string, unknown>;
		const deps = (
			manifest: Record<string, unknown>,
		): Record<string, unknown> => ({
			...(manifest.dependencies as Record<string, unknown> | undefined),
			...(manifest.devDependencies as Record<string, unknown> | undefined),
		});
		const oldDeps = deps(before);
		return Object.entries(deps(after))
			.filter(
				([name, version]) =>
					version === "workspace:*" && !Object.hasOwn(oldDeps, name),
			)
			.map(([name]) => ({ packageDir: posix.dirname(manifestPath), name }));
	} catch {
		return [];
	}
};

const MISSING_LINE =
	/^error: Cannot find (?:package|module) ['"]([^'"]+)['"](?: from ['"](.+?)['"])?/;

export const missingImports = (output: string): MissingImport[] => {
	const hits: MissingImport[] = [];
	for (const line of output.split(/\r?\n/)) {
		const m = line.match(MISSING_LINE);
		if (m) hits.push({ spec: m[1] ?? "", importer: m[2] ?? "" });
	}
	return hits;
};

// TS resolution extension variants: bun prints the specifier verbatim, so an
// extensionless relative spec must try the file extensions too.
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const scratchRelativeImporter = (
	importer: string,
	scratchRoot: string | undefined,
): string => {
	if (
		!scratchRoot ||
		!posix.isAbsolute(scratchRoot) ||
		!posix.isAbsolute(importer)
	)
		return "";
	const canonical = (path: string, depth = 0): string | null => {
		if (depth > 32) return null;
		let cursor = posix
			.normalize(path)
			.replace(/^\/private(?=\/(?:var|tmp)(?:\/|$))/, "");
		const tail: string[] = [];
		try {
			for (;;) {
				const stat = lstatSync(cursor, { throwIfNoEntry: false });
				if (stat) {
					if (stat.isSymbolicLink())
						return canonical(
							posix.resolve(
								posix.dirname(cursor),
								readlinkSync(cursor),
								...tail,
							),
							depth + 1,
						);
					return posix.join(realpathSync(cursor), ...tail);
				}
				const parent = posix.dirname(cursor);
				if (parent === cursor) return null;
				tail.unshift(posix.basename(cursor));
				cursor = parent;
			}
		} catch {
			return null;
		}
	};
	const root = canonical(scratchRoot),
		file = canonical(importer);
	if (!root || !file) return "";
	const relative = posix.relative(root, file);
	return relative &&
		relative !== ".." &&
		!relative.startsWith("../") &&
		!posix.isAbsolute(relative)
		? relative
		: "";
};

// a missing import is explained when its specifier, resolved against the
// importer's repo-relative directory, lands on a diff-ADDED module. The
// importer is a restored test (or test helper) file — anchor its repo-relative
// path by suffix against the diff's test paths, because the scratch root
// prefix varies (/var vs /private/var). Absolute specs (dynamic
// import(join(dir, ...)) inside a restored test) match by path-boundary suffix.
const explainsMissing = (
	spec: string,
	importer: string,
	added: Set<string>,
	testPaths: string[],
	addedWorkspaceDeps: AddedWorkspaceDependency[],
	scratchRoot?: string,
): boolean => {
	if (scratchRoot) {
		const importerPath = scratchRelativeImporter(importer, scratchRoot);
		if (!importerPath) return false;
		if (
			!spec.startsWith(".") &&
			!posix.isAbsolute(spec) &&
			addedWorkspaceDeps.some(
				({ packageDir, name }) =>
					importerPath.startsWith(`${packageDir}/`) &&
					(spec === name ||
						(spec.startsWith(`${name}/`) &&
							spec
								.slice(name.length + 1)
								.split("/")
								.every((part) => part !== "." && part !== ".."))),
			)
		)
			return true;
		const absolute = posix.isAbsolute(spec)
			? spec
			: /^\.\.?(?:\/|$)/.test(spec)
				? posix.resolve(scratchRoot, posix.dirname(importerPath), spec)
				: null;
		if (!absolute) return false;
		const target = scratchRelativeImporter(absolute, scratchRoot);
		return (
			!!target &&
			RESOLVE_EXTS.some((extension) => added.has(target + extension))
		);
	}
	for (const p of added) {
		if (spec.endsWith(`/${p}`)) return true;
	}
	const hit = testPaths
		.filter((f) => importer.endsWith(f))
		.reduce((a, b) => (b.length > a.length ? b : a), "");
	if (
		hit &&
		addedWorkspaceDeps.some(
			({ packageDir, name }) =>
				hit.startsWith(`${packageDir}/`) &&
				(spec === name || spec.startsWith(`${name}/`)),
		)
	)
		return true;
	// The first missing import can come from a production module reached by a
	// restored test, rather than from the test itself. Anchor that importer to
	// the scratch root before resolving its relative specifier.
	const importerPath = scratchRelativeImporter(importer, scratchRoot) || hit;
	const dir = importerPath ? posix.dirname(importerPath) : "";
	for (const ext of RESOLVE_EXTS) {
		const candidate = posix.normalize(
			dir ? `${dir}/${spec}${ext}` : `${spec}${ext}`,
		);
		if (added.has(candidate)) return true;
	}
	return false;
};

// the W1262 gate: true when EVERY missing import in the output resolves onto a
// diff-added module (the failure is the proof); false on any unexplained one
// (a genuinely missing dependency/tooling problem — environmental).
export const missingImportsExplained = (
	output: string,
	added: string[],
	testPaths: string[],
	addedWorkspaceDeps: AddedWorkspaceDependency[] = [],
	scratchRoot?: string,
): boolean => {
	if (missingImports(output).length === 0) return true;
	const addedSet = new Set(added);
	for (const { spec, importer } of missingImports(output)) {
		if (
			!explainsMissing(
				spec,
				importer,
				addedSet,
				testPaths,
				addedWorkspaceDeps,
				scratchRoot,
			)
		)
			return false;
	}
	return true;
};

/** Share the repo node_modules with a proof scratch (W2199): the ROOT
 *  closure AND every package-local packages/<pkg>/node_modules — workspace
 *  deps resolve through the package-local links a fresh git worktree
 *  lacks; without them provable tests importing one die as Cannot-find-
 *  module and the review errors as environmental (the W2198 trail).
 *  manifestPaths are repo-relative <pkg>/package.json paths naming the
 *  packages whose files changed in the diff — tests AND production: a
 *  changed prod file's cross-package import needs the sibling package's
 *  local links too (W2633 trail). See changedPackageManifests(). */

const WorkspaceIdentitySchema = z.object({
	name: z.string().min(1).optional(),
});

export function shareNodeModules(
	repo: string,
	scratch: string,
	manifestPaths: readonly string[],
): void {
	const names = new Map<string, string>();
	const targets = new Map<string, string>();
	// Called before reversal: identities come from the exact candidate scratch,
	// never mutable package manifests in the dependency-cache checkout.
	const packages = join(scratch, "packages");
	if (existsSync(packages)) {
		for (const entry of readdirSync(packages, { withFileTypes: true })) {
			const directory = join(packages, entry.name);
			const manifest = join(directory, "package.json");
			if (!entry.isDirectory() || !existsSync(manifest)) continue;
			const identity = WorkspaceIdentitySchema.safeParse(
				JSON.parse(readFileSync(manifest, "utf8")),
			);
			if (!identity.success)
				throw new Error("Invalid workspace package identity");
			const destination = join(scratch, "packages", entry.name);
			const sourceDirectory = join(repo, "packages", entry.name);
			if (existsSync(sourceDirectory))
				targets.set(realpathSync(sourceDirectory), destination);
			if (identity.data.name) {
				if (names.has(identity.data.name))
					throw new Error("Ambiguous workspace identity");
				names.set(identity.data.name, destination);
			}
		}
	}
	const workspaceTarget = (target: string): string => {
		for (const [sourceRoot, scratchRoot] of targets) {
			const suffix = posix.relative(sourceRoot, target);
			if (
				suffix !== ".." &&
				!suffix.startsWith("../") &&
				!posix.isAbsolute(suffix)
			)
				return join(scratchRoot, suffix);
		}
		return target;
	};
	const share = (source: string, destination: string): void => {
		if (!existsSync(source)) return;
		if (lstatSync(destination, { throwIfNoEntry: false }))
			throw new Error("Proof dependencies already exist");
		mkdirSync(destination, { recursive: true });
		const link = (src: string, dst: string, name?: string): void => {
			// Internal aliases point at this reversed scratch, even if the new
			// workspace is absent there. They must never borrow the candidate.
			const named = name ? names.get(name) : undefined;
			const target = named ?? workspaceTarget(realpathSync(src));
			symlinkSync(target, dst);
		};
		for (const entry of readdirSync(source)) {
			const src = join(source, entry),
				dst = join(destination, entry);
			if (entry.startsWith("@") || entry === ".bin") {
				mkdirSync(dst);
				for (const member of readdirSync(src))
					link(
						join(src, member),
						join(dst, member),
						entry === ".bin" ? undefined : [entry, member].join("/"),
					);
			} else link(src, dst, entry);
		}
	};
	share(join(repo, "node_modules"), join(scratch, "node_modules"));
	for (const manifest of manifestPaths)
		share(
			join(repo, dirname(manifest), "node_modules"),
			join(scratch, dirname(manifest), "node_modules"),
		);
}
