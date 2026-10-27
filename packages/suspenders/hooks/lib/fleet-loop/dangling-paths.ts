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
// W1302.2.1 scoping: only reference-form specifiers (dot-prefixed relative
// or @klh/) are judged; targets under runtime dirs (.harness/.worktrees/
// .test-home) and build output (node_modules/dist/build/out) are untracked
// by convention and never judged.
//
// W1302.8 (A22): both probes judge SYNTAX-classified references only
// (dangling-classify.ts) — import specifiers, new URL / import.meta.resolve,
// join(import.meta.dir, ...) and path-valued config keys. A quoted string is
// data until syntax makes it a reference: the literal scan minted 400+
// repairs from fixture names, JSDoc backticks, nested quotes and comment
// apostrophes that desynced it. Test files carry their imports only (a test
// importing a deleted module is a real edge); fixtures, skills, templates
// and prose carry none.
//
// Findings bank into ONE open aggregate repair item per project: one
// `code.dangling-path` event per dependency edge (target, refBy) never
// recorded before. A recorded edge — any event or legacy per-edge item, in
// any state, SUPERSEDED included — never re-mints; only a history whose
// every holder is DONE (repaired) re-banks a re-broken edge. Findings are
// never deleted.
import { join } from "node:path";
import {
	type GovernorStore,
	openStore,
	projectIdentity,
} from "../govdb/govdb.ts";
import { enqueueWorkItem } from "../work/work-enqueue.ts";
import {
	classifyFile,
	quotedStrings,
	type Reference,
	referencesIn,
	TEMPLATE_HOLE,
} from "./dangling-classify.ts";

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

// files whose references get judged: code, JSON config, markup/config text
const JUDGED = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|html?|sh|plist)$/i;
// runtime dirs and build output are untracked by convention — a target under
// them cannot be judged "missing from the tree" by ls-tree
const UNJUDGED_TARGET =
	/(?:^|\/)(?:\.harness|\.worktrees|\.test-home|node_modules|dist|build|out)\//;
// files read whole per probe: a huge reorg merge skips deeper audit
const READ_CAP = 500;

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

/** Probe 2: unresolvable references among the merge's own delta — files
 * added/modified by the merge whose syntax-classified references resolve
 * onto no path in the merged tree. `files` = changed paths from the merge
 * diff; existence is judged against `tree`. */
export function unresolvedSpecifiers(
	repo: string,
	tree: string,
	files: string[],
): DanglingRef[] {
	const usable = files
		.filter((f) => JUDGED.test(f) && classifyFile(f) !== "inert")
		.slice(0, READ_CAP);
	if (!usable.length) return [];
	const listing = git(repo, ["ls-tree", "-r", "--name-only", "-z", tree]);
	if (listing === null) return [];
	const present = new Set(listing.split("\0"));
	for (const f of usable) if (!present.has(f)) return []; // tree input incomplete — never judge
	const findings: DanglingRef[] = [];
	for (const f of usable) {
		const body = git(repo, ["show", `${tree}:${f}`]);
		if (body === null) continue;
		for (const { spec } of referencesIn(f, body)) {
			const target = missingTarget(spec, f, present);
			if (target) findings.push({ target, refBy: f, line: 0, specifier: spec });
		}
	}
	return findings;
}

/** The repo path `spec` (written in `refBy`) names when no candidate of it
 * is in the tree; null when it resolves or cannot be judged — outside the
 * repo or under an untracked dir, ls-tree never lists it. */
function missingTarget(
	spec: string,
	refBy: string,
	present: Set<string>,
): string | null {
	const resolved = resolveLiteral(spec, refBy);
	if (resolved === null || /^\.\.(?:\/|$)/.test(resolved)) return null;
	if (UNJUDGED_TARGET.test(resolved)) return null;
	const candidates = resolutionCandidates(resolved);
	return candidates.some((c) => present.has(c)) ? null : resolved;
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
 * tree for each deleted path's reference forms; a file whose grep lines
 * quote the path's name gets its syntax references resolved, and only one
 * landing on the deleted path (or its extensionless form) with no candidate
 * left in the tree counts — a same-basename file that still exists never
 * misreports, and config keys are covered alongside imports. */
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
	const refsOf = referenceCache(repo, after);
	return deleted.flatMap((p) => findRefsTo(repo, after, p, present, refsOf));
}

/** Per-scan memo of each file's syntax references in `tree`. Unjudged and
 * inert files carry none; past READ_CAP files nothing more is read
 * (bounded fail-open: a huge reorg merge skips deeper audit). */
function referenceCache(repo: string, tree: string) {
	const memo = new Map<string, Reference[]>();
	return (file: string): Reference[] => {
		const cached = memo.get(file);
		if (cached) return cached;
		let refs: Reference[] = [];
		if (memo.size < READ_CAP && JUDGED.test(file)) {
			const body =
				classifyFile(file) === "inert"
					? null
					: git(repo, ["show", `${tree}:${file}`]);
			if (body !== null) refs = referencesIn(file, body);
		}
		memo.set(file, refs);
		return refs;
	};
}

/** Last segments a reference to `p` can end with: the basename, its
 * extensionless form and, for .ts, the ESM .js spelling. */
function quotedNames(p: string): Set<string> {
	const base = p.slice(p.lastIndexOf("/") + 1);
	const stem = base.replace(/\.[^.]+$/, "");
	const names = new Set([base, stem]);
	if (base.endsWith(".ts")) names.add(`${stem}.js`);
	return names;
}

/** All dangling references to one deleted path: one edge per referencing
 * file, validated by syntax and resolution. */
function findRefsTo(
	repo: string,
	tree: string,
	p: string,
	present: Set<string>,
	refsOf: (file: string) => Reference[],
): DanglingRef[] {
	if (present.has(p)) return []; // deleted then re-created in range
	const targets = new Set([p, p.replace(/\.[^./]+$/, "")]);
	const names = quotedNames(p);
	const byFile = new Map<string, GrepHit[]>();
	for (const hit of grepForms(repo, tree, refForms(p))) {
		const quoted = quotedStrings(hit.content);
		if (!quoted.some((s) => names.has(s.slice(s.lastIndexOf("/") + 1))))
			continue; // the line never quotes the path's name
		byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit]);
	}
	const out: DanglingRef[] = [];
	for (const [file, hits] of byFile) {
		const ref = refsOf(file).find((r) => {
			const resolved = resolveLiteral(r.spec, file);
			if (resolved === null) return false;
			const candidates = resolutionCandidates(resolved);
			if (!candidates.some((c) => targets.has(c))) return false;
			return !candidates.some((c) => present.has(c));
		});
		if (!ref) continue;
		const at = hits.find((h) => h.content.includes(ref.spec)) ?? hits[0];
		out.push({
			target: p,
			refBy: file,
			line: at?.line ?? 0,
			specifier: ref.spec,
		});
	}
	return out;
}

const EVENT_KIND = "code.dangling-path";
/** The one open repair item findings bank into; the "Repair dangling path"
 * prefix stays shared with the legacy per-edge items. */
export const AGGREGATE_TITLE =
	"Repair dangling paths found by the post-merge scan";
const LEGACY_TITLE = /^Repair dangling path (.+) referenced by (.+)$/;
const OPEN_STATE = "state NOT IN ('DONE', 'CANCELLED', 'SUPERSEDED')";
const LISTED_EDGES = 20;

export type BankOptions = {
	db?: GovernorStore;
	enqueue?: (title: string, description: string) => string;
};

const edgeKey = (target: string, refBy: string) =>
	JSON.stringify([target, refBy]);

/** Every edge the project already recorded: `code.dangling-path` events
 * (aggregate or legacy per-edge) and legacy per-edge item titles. An edge
 * stays known in any holder state — SUPERSEDED and a missing holder
 * included; only an all-DONE (repaired) history lets it bank again. */
function knownEdges(db: GovernorStore, project: string): Set<string> {
	const states = new Map<string, string[]>();
	const note = (target: unknown, refBy: unknown, state: unknown) => {
		if (typeof target !== "string" || typeof refBy !== "string") return;
		const key = edgeKey(target, refBy);
		const seen = states.get(key) ?? [];
		seen.push(typeof state === "string" ? state : "MISSING");
		states.set(key, seen);
	};
	const events = db
		.query(
			"SELECT json_extract(e.payload, '$.target') AS target, json_extract(e.payload, '$.refBy') AS refBy, w.state AS state FROM events e LEFT JOIN work_items w ON w.project = ? AND w.id = e.scope WHERE e.kind = ? AND json_extract(e.payload, '$.project') = ?",
		)
		.all(project, EVENT_KIND, project) as Record<string, unknown>[];
	for (const r of events) note(r.target, r.refBy, r.state);
	const legacy = db
		.query(
			"SELECT title, state FROM work_items WHERE project = ? AND title LIKE 'Repair dangling path % referenced by %'",
		)
		.all(project) as { title: string; state: string }[];
	for (const r of legacy) {
		const m = LEGACY_TITLE.exec(r.title);
		if (m) note(m[1], m[2], r.state);
	}
	const open = [...states].filter(([, s]) => s.some((x) => x !== "DONE"));
	return new Set(open.map(([key]) => key));
}

/** Mint the aggregate repair item. Its description lists the batch that
 * opened it; the events scoped to it stay the full, growing record. */
function enqueueAggregate(
	repo: string,
	source: string,
	fresh: DanglingRef[],
	mergedSha: string,
	options: BankOptions,
): string {
	const edges = fresh.slice(0, LISTED_EDGES).map((r) => {
		const at = r.line ? `${r.refBy}:${r.line}` : r.refBy;
		return `- ${r.target} <- ${at} (${JSON.stringify(r.specifier)})`;
	});
	if (fresh.length > LISTED_EDGES)
		edges.push(`- ... ${fresh.length - LISTED_EDGES} more`);
	const description = [
		`The post-merge scan found references onto paths missing from the merged tree (first batch: merge ${mergedSha}). Each dependency edge is one ${EVENT_KIND} event scoped to this item (coord events --kinds ${EVENT_KIND} --json); later merges append new edges here instead of minting items.`,
		...edges,
		"Per edge: restore the path or rewrite the reference; verify imports and focused tests, then close this item. An edge re-broken after DONE banks again.",
	].join("\n");
	const work = options.enqueue
		? options.enqueue(AGGREGATE_TITLE, description)
		: enqueueWorkItem(repo, source, AGGREGATE_TITLE, description);
	if (!work) throw new Error("Unable to queue the dangling-path aggregate");
	return work;
}

/** Bank findings into the one open aggregate repair item: one event per
 * edge not yet recorded (knownEdges); returns the newly banked edges. */
export function bankDanglingRefs(
	repo: string,
	source: string,
	refs: DanglingRef[],
	mergedSha: string,
	options: BankOptions = {},
): DanglingRef[] {
	if (!refs.length) return [];
	const db = options.db ?? openStore();
	try {
		const project = projectIdentity(repo);
		const known = knownEdges(db, project);
		const fresh = refs.filter((r) => {
			const key = edgeKey(r.target, r.refBy);
			if (known.has(key)) return false;
			known.add(key); // in-batch duplicates bank once
			return true;
		});
		if (!fresh.length) return [];
		const open = db
			.query(
				`SELECT id FROM work_items WHERE project = ? AND title = ? AND ${OPEN_STATE} LIMIT 1`,
			)
			.get(project, AGGREGATE_TITLE) as { id: string } | null;
		const work =
			open?.id ?? enqueueAggregate(repo, source, fresh, mergedSha, options);
		const insert = db.query(
			"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
		);
		db.transaction(() => {
			for (const ref of fresh) {
				const payload = JSON.stringify({ project, ...ref, mergedSha, work });
				insert.run(Date.now(), source, EVENT_KIND, work, payload);
			}
		})();
		return fresh;
	} finally {
		if (!options.db) db.close();
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
