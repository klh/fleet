// hooks/lib/import-law.ts — W1302.4: the W1249 import-law ratchet as a
// done-gate verdict. The repo-root guard test (tests/fleet.import-law.guard.test.ts)
// runs the FULL-tree ratchet against a pinned edge set at CI; this verdict
// runs the same detector (ONE scanner — hooks/lib/import-graph.ts) over the
// closing diff only: relative reach-in edges ADDED by the branch refuse
// closure, so the package boundary drifts at the lane, never at CI/merge
// (the W1286.1 drift surfaced only at merge). Inherited edges at the ratchet
// base pass; SUSPENDERS_IMPORT_LAW=0 disables.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { edgeKey, edgesOfContent, type ImportEdge } from "./import-graph.ts";

const gitOut = (repo: string, args: string[]): string | null => {
	const p = spawnSync("git", ["-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.status === 0 ? `${p.stdout ? p.stdout.toString() : ""}` : null;
};

/** reach-in edge keys of one blob's content, resolved against its
 * packages/<pkg>/ home; null when the blob is unreadable or unparseable —
 * the caller refuses on a null CLOSING blob (fail-closed) and treats a
 * null BASE blob as an empty inherited set (the edge cannot be proven
 * inherited). */
const reachInsOf = (
	repo: string,
	ref: string,
	path: string,
	pkg: string,
	file: string,
): string[] | null => {
	const src = gitOut(repo, ["cat-file", "blob", `${ref}:${path}`]);
	if (src === null) return null;
	let edges: ImportEdge[];
	try {
		edges = edgesOfContent(
			src,
			pkg,
			file,
			join(repo, "packages", pkg),
			join(repo, "packages"),
		);
	} catch {
		return null;
	}
	return edges
		.filter((e) => e.kind === "reachin")
		.map((e) => edgeKey(e))
		.sort();
};

export interface ImportLawVerdict {
	ok: boolean;
	why?: string;
	/** reach-in edges the closing diff adds (empty when clean/disabled) */
	newEdges?: string[];
}

/** the done-gate verdict: .ts files under packages/<pkg>/ in the closing
 * diff must not ADD relative reach-in edges against the ratchet base —
 * unparseable closing blobs refuse (fail-closed); an unreadable base blob
 * treats the base edge set as empty (the edge cannot be proven inherited).
 * Fails open only for paths outside packages/ and disabled knobs. */
export const importLawVerdict = (o: {
	repo: string;
	paths: string[];
	/** the ratchet base ref (claim baseline / branch merge-base / sha^) */
	baseRef: string | null;
	sha: string;
	disabled?: boolean;
}): ImportLawVerdict => {
	const disabled = o.disabled ?? process.env.SUSPENDERS_IMPORT_LAW === "0";
	if (disabled) return { ok: true };
	const violations: { path: string; edge: string }[] = [];
	for (const path of o.paths) {
		const m = /^packages\/([^/]+)\/(.+\.ts)$/.exec(path);
		if (!m) continue;
		const [, pkg, file] = m;
		if (file.includes("node_modules") || file.includes("vendor/")) continue;
		const closing = reachInsOf(o.repo, o.sha, path, pkg, file);
		if (closing === null) {
			violations.push({
				path,
				edge: `(unparseable at ${o.sha} — the W1249 guard asserts zero parse fails)`,
			});
			continue;
		}
		if (!closing.length) continue;
		const base = new Set(
			o.baseRef ? (reachInsOf(o.repo, o.baseRef, path, pkg, file) ?? []) : [],
		);
		for (const edge of closing)
			if (!base.has(edge)) violations.push({ path, edge });
	}
	if (!violations.length) return { ok: true };
	const rows = violations
		.slice(0, 10)
		.map((v) => `  ${v.path}: ${v.edge}`)
		.join("\n");
	return {
		ok: false,
		why: `import-law (W1302.4): the closing diff adds ${violations.length} new relative reach-in edge(s) — fix the import (declare + import the @klh/<pkg> name, never relative) or drop it:\n${rows}${violations.length > 10 ? `\n  … ${violations.length - 10} more` : ""}\nEscape hatch: SUSPENDERS_IMPORT_LAW=0.`,
		newEdges: violations.map((v) => `${v.path}: ${v.edge}`),
	};
};
