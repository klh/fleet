// coverage-proof.ts — W1262: the Sinai coverage-proof classifier, split out of
// review-lane.ts so the W1258 regression has a unit face. review-lane.ts keeps
// the orchestration (git, scratch worktree, bun test run); this module owns the
// classification: a scratch "Cannot find module" that names a module the diff
// ADDED is the proof itself — the change is what provides the module — so it
// must not classify as an environmental failure. Only a missing import that
// does NOT resolve onto a diff-added module is tooling/dependency noise.
import { posix } from "node:path";

// test paths only: the proof keeps these, reverses everything else
export const TEST_FILE =
	/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test|spec)_/;

export type Proof = {
	status: "proved" | "no-coverage" | "skipped" | "error";
	detail: string;
	failed?: number;
	passed?: number;
};

// one missing import: bun prints the specifier verbatim (extensionless
// relative specs stay extensionless) plus the importer's absolute path
// (`error: Cannot find module './x' from '/abs/dir/y.test.ts'`), first
// unresolvable import per file.
export type MissingImport = { spec: string; importer: string };

const MISSING_LINE =
	/Cannot find (?:package|module) ['"]([^'"]+)['"](?: from ['"](.+?)['"])?/;

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
): boolean => {
	for (const p of added) {
		if (spec.endsWith(`/${p}`)) return true;
	}
	const hit = testPaths
		.filter((f) => importer.endsWith(f))
		.reduce((a, b) => (b.length > a.length ? b : a), "");
	const dir = hit ? posix.dirname(hit) : "";
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
): boolean => {
	if (missingImports(output).length === 0) return true;
	const addedSet = new Set(added);
	for (const { spec, importer } of missingImports(output)) {
		if (!explainsMissing(spec, importer, addedSet, testPaths)) return false;
	}
	return true;
};
