// scripts/lib/source-closure.ts — W1256.1: the sync-harness payload closure
// (closes the W661 class — a hand-listed ship list drifting from the real
// import graph). The walk shares the belt/bin overlay walker (belt-bin-overlay
// .ts relativeSpecs): static `from`, dynamic import(), side-effect imports.
// The declared payload must COVER the computed closure; anything the graph
// reaches outside the shipped paths fails the install loudly here, naming the
// file, instead of dying dark at runtime (the 2026-10-11 router incident).
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { relativeSpecs } from "../belt-bin-overlay.ts";

export interface PayloadCoverageReport {
	/** Declared entries that do not exist in the working tree. */
	missing: string[];
	/** Closure members outside the declared payload (repo-relative, sorted). */
	outside: string[];
	/** Every closure member visited (repo-relative, sorted) — the evidence. */
	visited: string[];
}

export interface PayloadCoverageInput {
	/** Absolute repo root the walk is bounded at. */
	repoRoot: string;
	/** Import-graph faces (repo-relative, e.g. packages/suspenders/hooks/gate.ts). */
	entries: string[];
	/** The declared payload (the SOURCE_PATHS ship list). */
	payload: string[];
}

/** True when `rel` equals a payload path or sits under a payload dir. */
export function coveredByPayload(rel: string, payload: string[]): boolean {
	return payload.some((p) => rel === p || rel.startsWith(`${p}/`));
}

/** BFS the real import graph from `entries` (the same walk belt/bin's flat
 *  home overlay does), bounded at repoRoot, and report which members the
 *  declared payload fails to cover. Non-existent repo-internal imports are
 *  ignored (dangling specifiers are not payload — bun tolerates some
 *  extensionless/typo'd forms the walk cannot resolve); a MISSING declared
 *  entry, though, is reported — the payload must name faces that exist. */
export async function payloadCoverage(
	input: PayloadCoverageInput,
): Promise<PayloadCoverageReport> {
	const root = resolve(input.repoRoot);
	const seen = new Set<string>();
	const outside = new Set<string>();
	const missing = input.entries.filter(
		(rel) => !existsSync(resolve(root, rel)),
	);
	const queue = input.entries.filter((rel) => !missing.includes(rel));
	while (queue.length > 0) {
		const relEntry = queue.shift() as string;
		if (seen.has(relEntry)) continue;
		seen.add(relEntry);
		const abs = resolve(root, relEntry);
		if (!coveredByPayload(relEntry, input.payload)) {
			outside.add(relEntry);
		}
		const source = await Bun.file(abs).text();
		for (const spec of relativeSpecs(source, dirname(abs))) {
			const rel = relative(root, spec);
			if (rel.startsWith("..") || seen.has(rel)) continue;
			// Dangling specifier — not payload (bun tolerates some
			// extensionless/typo'd forms the walk cannot resolve).
			if (!existsSync(resolve(root, rel))) continue;
			queue.push(rel);
		}
	}
	return {
		missing,
		outside: [...outside].sort(),
		visited: [...seen].sort(),
	};
}
