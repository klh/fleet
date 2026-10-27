// dangling-paths.ts — W1302.2 (A6): the post-merge dangling-path scan. Two
// complementary probes over the merged tree, both fail-open at the call site
// (a scan error never un-merges or blocks the landed state):
//
// 1. deleted-path references — a path the merge deleted is still referenced
//    by a live file (import or config string) in the merged tree. The W1276
//    reorg integration (8db8b5cc) deleted paths live code still imported;
//    the dangling edges surfaced only as runtime breakage needing the
//    dbe18cee follow-up. This probe finds them at merge time.
// 2. unresolvable specifiers — a file the merge touched carries a path-like
//    literal (import specifier or runtime path string such as
//    `new URL("../bin/review-lane.ts", import.meta.url)`) that resolves onto
//    no path in the merged tree. The reorg also moved review-scheduler.ts
//    into hooks/lib/gates/ while keeping a specifier written for the old
//    depth; the reference pointed at nonexistent hooks/lib/bin/ until a
//    runtime failure exposed it (W1304, 2026-10-25).
//
// W1302.2.1 scoping: probe 2 judges only reference-form specifiers (dot-
// prefixed relative or @klh/) in NON-fixture files — a test file's or
// staging script's path-like strings denote synthetic trees (tmpdir fixture
// repos, staged harness roots), never the repo tree; bare `dir/name.ext`
// strings are data (staged-file lists, fixture names), not references.
// Targets under runtime dirs (.harness/.worktrees/.test-home) are untracked
// by convention and never judged. Probe 1 keeps whole-tree grep — a test
// importing a deleted module is a real dangling edge.
//
// Findings mint deduplicated repair work items + `code.dangling-path`
// events, mirroring the decomposition soft-cap pattern, so a dangling edge
// is actionable in the graph instead of a log line.
import { join } from "node:path";
import { openStore, projectIdentity } from "../govdb/govdb.ts";

export type DanglingRef = {
	/** path that does not exist in the merged tree (deleted or never real) */
	target: string;
	/** file in the merged tree carrying the dangling reference */
	refBy: string;
	/** 1-based line for deleted-path hits; 0 when unknown (full-file scan) */
	line: number;
	/** the literal that resolves onto the missing target */
	specifier: string;
};

const SOURCE = /\.(?:[cm]?[jt]sx?|json|jsonc)$/i;
const EXCLUDED = /(?:^|\/)(?:node_modules|vendor|generated|dist|build)\//;
const PATH_LIKE =
	/^(?:\.{1,2}\/|@klh\/)|\.(?:[cm]?[jt]sx?|json|jsonc|css|txt|md)$/i;
const TEMPLATE_HOLE = /\$\{/;
// quoted string bodies, longest-first alternation so adjacent quotes cannot
// shadow one another
const LITERAL = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
// W1302.2.1: probe-2 specifier scope. Real ESM relative imports and runtime
// path strings are dot-prefixed; package imports ride @klh/. Bare
// `dir/name.ext` strings are data, not references — the W1356 / W1302.4.1.1
// merges minted 160+ per-literal repairs from sync-harness and merge-guard
// fixture strings before this scope landed. `...` marks a doc ellipsis.
const REFERENCE_FORM = /^(?:\.{1,2}\/|@klh\/)/;
const PLACEHOLDER = /\.\.\./;
// Test/fixture files: their path-like strings denote synthetic trees (tmpdir
// fixture repos, staged harness roots), never the repo tree.
const FIXTURE_FILE =
	/(?:^|\/)(?:test|tests|__tests__)\/|(?:\.test|\.spec|\.e2e)\.[cm]?[jt]sx?$/i;
// Runtime dirs are untracked by convention — targets under them cannot be
// judged "missing from the tree" by ls-tree.
const RUNTIME_DIR = /(?:^|\/)(?:\.harness|\.worktrees|\.test-home)\//;

const git = (repo: string, args: string[]): string | null => {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0 ? p.stdout.toString() : null;
};

/** Candidate on-disk paths a specifier may resolve to (extensionless and
 * .js→.ts ESM forms included); a hit on any counts as resolving. */
export function resolutionCandidates(resolved: string): string[] {
	const list = [resolved];
	if (!/\.[cm]?[jt]sx?$/.test(resolved)) {
		list.push(
			`${resolved}.ts`,
			`${resolved}.tsx`,
			`${resolved}.js`,
			`${resolved}.jsx`,
			`${resolved}.mjs`,
			`${resolved}.cjs`,
			`${resolved}.json`,
			`${resolved}/index.ts`,
			`${resolved}/index.js`,
		);
	} else if (resolved.endsWith(".js")) {
		list.push(`${resolved.slice(0, -3)}.ts`);
	}
	return list;
}

/** Probe 2: unresolvable path-like literals among the merge's own delta —
 * files added/modified by the merge whose relative or @klh specifiers
 * resolve onto no path in the merged tree. `files` = changed source paths
 * from the merge diff; existence is judged against `tree`. */
export function unresolvedSpecifiers(
	repo: string,
	tree: string,
	files: string[],
): DanglingRef[] {
	const usable = files
		.filter((f) => SOURCE.test(f) && !EXCLUDED.test(f) && !FIXTURE_FILE.test(f))
		.slice(0, 500); // bounded fail-open: a huge reorg merge skips deeper audit
	if (!usable.length) return [];
	const listing = git(repo, ["ls-tree", "-r", "--name-only", "-z", tree]);
	if (listing === null) return [];
	const present = new Set(listing.split("\0"));
	for (const f of usable) if (!present.has(f)) return []; // tree input incomplete — never judge
	const findings: DanglingRef[] = [];
	for (const f of usable) {
		const body = git(repo, ["show", `${tree}:${f}`]);
		if (body === null) continue;
		for (const spec of pathLiterals(body)) {
			if (!REFERENCE_FORM.test(spec) || PLACEHOLDER.test(spec)) continue;
			const resolved = resolveLiteral(spec, f);
			if (resolved === null || RUNTIME_DIR.test(resolved)) continue;
			if (resolutionCandidates(resolved).some((c) => present.has(c))) continue;
			findings.push({ target: resolved, refBy: f, line: 0, specifier: spec });
		}
	}
	return findings;
}

/** Reference forms to grep a deleted path by: full path, extensionless full
 * path, last-two-segment forms (relative imports from sibling dirs), and
 * the basename (hits get validated by resolution, so a same-basename file
 * that still exists never misreports). */
export function refForms(p: string): string[] {
	const ext = p.match(/\.[^./]+$/)?.[0] ?? "";
	const stem = ext ? p.slice(0, -ext.length) : p;
	const segs = p.split("/");
	const base = segs.at(-1) ?? p;
	const forms = new Set([
		p,
		stem,
		base,
		ext ? base.slice(0, -ext.length) : base,
	]);
	if (segs.length >= 2) {
		const tail2 = segs.slice(-2).join("/");
		forms.add(tail2);
		if (ext) forms.add(tail2.slice(0, -ext.length));
	}
	return [...forms].filter((f) => f.length >= 4);
}

type GrepHit = { file: string; line: number; content: string };

/** Split `tree:file\0line\0content` grep rows (git grep --null -n shape). */
export function parseGrepRows(out: string): GrepHit[] {
	const hits = new Map<string, GrepHit>();
	for (const row of out.split("\n")) {
		if (!row) continue;
		const nul = row.indexOf("\0");
		if (nul < 0) continue;
		const head = row.slice(0, nul); // "tree:file"
		const colon = head.indexOf(":");
		const file = colon >= 0 ? head.slice(colon + 1) : head;
		const rest = row.slice(nul + 1); // "line\0content"
		const nul2 = rest.indexOf("\0");
		if (nul2 < 0) continue;
		const line = Number(rest.slice(0, nul2));
		if (!file || !Number.isSafeInteger(line) || line <= 0) continue;
		const key = `${file}:${line}`;
		if (!hits.has(key))
			hits.set(key, { file, line, content: rest.slice(nul2 + 1) });
	}
	return [...hits.values()];
}

/** `git grep -F` the tree for every form in one spawn; unique file:line
 * hits, tree-prefixed output stripped back to repo-relative paths. */
function grepForms(repo: string, tree: string, forms: string[]): GrepHit[] {
	const out = git(repo, [
		"grep",
		"-I",
		"-n",
		"--null",
		"-F",
		...forms.flatMap((f) => ["-e", f]),
		tree,
	]);
	return out === null ? [] : parseGrepRows(out);
}

/** Probe 1: live references to paths the merge deleted. Greps the merged
 * tree for each deleted path's reference forms, then keeps only hits whose
 * resolved literal lands on the deleted path (or its extensionless form) —
 * a same-basename file that still exists never misreports, and config
 * strings are covered alongside imports. */
export function danglingReferences(
	repo: string,
	before: string,
	after: string,
): DanglingRef[] {
	const d = git(repo, [
		"diff",
		"--name-only",
		"-z",
		"--diff-filter=D",
		before,
		after,
	]);
	if (d === null) return [];
	const deleted = d.split("\0").filter(Boolean);
	if (!deleted.length) return [];
	const listing = git(repo, ["ls-tree", "-r", "--name-only", "-z", after]);
	if (listing === null) return [];
	const present = new Set(listing.split("\0"));
	return deleted.flatMap((p) => findRefsTo(repo, after, p, present));
}

/** All dangling references to one deleted path, validated by resolution. */
function findRefsTo(
	repo: string,
	tree: string,
	p: string,
	present: Set<string>,
): DanglingRef[] {
	if (present.has(p)) return []; // deleted then re-created in range
	const targets = new Set([p, p.replace(/\.[^./]+$/, "")]);
	const out: DanglingRef[] = [];
	for (const hit of grepForms(repo, tree, refForms(p))) {
		for (const spec of pathLiterals(hit.content)) {
			const resolved = resolveLiteral(spec, hit.file);
			if (resolved === null) continue;
			if (!resolutionCandidates(resolved).some((c) => targets.has(c))) continue;
			out.push({ target: p, refBy: hit.file, line: hit.line, specifier: spec });
			break;
		}
	}
	return out;
}

const EVENT_KIND = "code.dangling-path";

/** The repair-item description minted for one finding. False-positive
 * closures append a row to the ONE indexed disposition record instead of
 * minting a new per-item doc (W2173.6). */
export function repairDescription(ref: DanglingRef, mergedSha: string): string {
	const where = ref.line
		? `${ref.refBy}:${ref.line}`
		: `${ref.refBy} (${ref.specifier})`;
	return `The merge that produced ${mergedSha} left ${ref.target} missing while ${where} still references it (${JSON.stringify(ref.specifier)}). Restore the path, rewrite the reference, or supersede this item with the reason. Verify imports and focused tests after the repair. If the finding is a false positive, close as a no-op and append one row to docs/design/dangling-path-false-positives.md — do not mint a new per-item record.`;
}

/** Bank one finding in the graph: deduped by title against still-open items. */
export function bankDanglingRef(
	repo: string,
	source: string,
	ref: DanglingRef,
	mergedSha: string,
): void {
	const db = openStore();
	try {
		const project = projectIdentity(repo);
		const title = `Repair dangling path ${ref.target} referenced by ${ref.refBy}`;
		const existing = db
			.query(
				"SELECT id FROM work_items WHERE project = ? AND title = ? AND state NOT IN ('DONE', 'SUPERSEDED') LIMIT 1",
			)
			.get(project, title) as { id: string } | null;
		if (existing) return; // already queued — idempotent across retries
		const description = repairDescription(ref, mergedSha);
		const bin =
			process.env.SUSPENDERS_PREFIX ??
			join(process.env.HOME ?? "", ".claude/hooks/suspenders");
		const result = Bun.spawnSync(
			[
				process.execPath,
				join(bin, "bin/work.ts"),
				"add",
				title,
				"--desc",
				description,
				"--by",
				source,
			],
			{ cwd: repo, stdout: "pipe", stderr: "pipe" },
		);
		const work = result.stdout.toString().match(/\bW\d+(?:\.\d+)*\b/)?.[0];
		if (!work)
			throw new Error(`Unable to queue dangling-path repair: ${ref.target}`);
		db.query(
			"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
		).run(
			Date.now(),
			source,
			EVENT_KIND,
			work,
			JSON.stringify({ project, ...ref, mergedSha, work }),
		);
	} finally {
		db.close();
	}
}

/** Resolve a path-like literal to a repo-root-relative path, or null for
 * forms this scanner deliberately does not judge (template holes, absolute
 * and URL-like specifiers, bare package tokens). */
export function resolveLiteral(
	specifier: string,
	refBy: string,
): string | null {
	if (TEMPLATE_HOLE.test(specifier)) return null;
	if (/^(?:[a-z]+:)?\//i.test(specifier)) return null;
	if (specifier.startsWith("@klh/")) {
		const rest = specifier.slice("@klh/".length);
		const slash = rest.indexOf("/");
		return slash > 0
			? join("packages", rest.slice(0, slash), rest.slice(slash + 1))
			: null;
	}
	const dir = refBy.includes("/")
		? refBy.slice(0, refBy.lastIndexOf("/"))
		: ".";
	return join(dir, specifier);
}

/** Every path-like string literal in the file body, in order. */
export function pathLiterals(body: string): string[] {
	const out: string[] = [];
	for (const m of body.matchAll(LITERAL)) {
		const spec = m[2];
		if (!spec || TEMPLATE_HOLE.test(spec) || !PATH_LIKE.test(spec)) continue;
		out.push(spec);
	}
	return out;
}
