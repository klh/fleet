// hooks/lib/work/patch-first.ts — W744: formalize the patch-first contract for
// near-cap .ts files. The content gate (mutation-size 40-line cap, the 1500
// hard limit) already forces patching de facto; this makes both halves
// explicit: dispatch briefs for near-cap files carry a patch-only directive,
// and `work done` verifies the diff shape — churn beyond the budget on a
// near-cap file refuses closure unless the item IS a decomposition.
import { spawnSync } from "node:child_process";

/** a .ts file at or past this line count is near-cap (the 1500 hard cap
 *  minus working headroom). */
export const PATCH_FIRST_THRESHOLD = 1200;
/** max added+removed lines per near-cap file in a closing diff. */
export const PATCH_FIRST_CHURN_BUDGET = 300;

/** wc -l semantics on in-memory text (trailing \n opens no extra line). */
export const countLinesOf = (s: string): number =>
	s === "" ? 0 : s.replace(/\n$/, "").split("\n").length;

const gitOut = (repo: string, args: string[]): string | null => {
	const p = spawnSync("git", ["-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.status === 0 ? `${p.stdout ? p.stdout.toString() : ""}` : null;
};

/** line count of a path AT a commit; null when the path is not a readable
 *  file blob there (deleted, moved, or never existed). */
export const lineCountAt = (
	repo: string,
	sha: string,
	path: string,
): number | null => {
	const out = gitOut(repo, ["cat-file", "blob", `${sha}:${path}`]);
	return out === null ? null : countLinesOf(out);
};

/** added+removed for one path between baseline and sha (numstat; baseline
 *  null = the single closing commit via diff-tree --root). */
export const diffChurn = (
	repo: string,
	baseline: string | null,
	sha: string,
	path: string,
): { added: number; removed: number } | null => {
	const args =
		baseline !== null
			? ["diff", "--numstat", baseline, sha, "--", path]
			: [
					"diff-tree",
					"--root",
					"--no-commit-id",
					"--numstat",
					"-r",
					sha,
					"--",
					path,
				];
	const out = gitOut(repo, args);
	if (out === null) return null;
	const row = out.split("\n").find((l) => l.trim() !== "");
	if (!row) return null;
	const [added, removed] = row.split("\t");
	return { added: Number(added) || 0, removed: Number(removed) || 0 };
};

/** the decomposition exemption: an item whose title or description declares
 *  it (the soft post-merge cap mints "DRY and decompose <path>" items; W740
 *  was "decompose fleet-loop.ts ..."). */
export const isDecompositionItem = (
	title?: string | null,
	desc?: string | null,
): boolean => /decompos/i.test(`${title ?? ""} ${desc ?? ""}`);

export type PatchFirstVerdict = {
	ok: boolean;
	why?: string;
	/** near-cap .ts files the closing diff touched (empty when clean/disabled) */
	violations?: {
		path: string;
		lines: number;
		churn: number;
		budget: number;
	}[];
};

/** the done-gate verdict: near-cap .ts paths in the closing diff must be
 *  patched, not rewritten — per-file churn beyond the budget refuses closure
 *  unless the item IS a decomposition. Fails open: missing evidence, unreadable
 *  blobs, and disabled knobs never block a closure. */
export const patchFirstVerdict = (o: {
	repo: string;
	/** U0 whole-diff evidence — only the path list is consumed here */
	paths: string[];
	baseline: string | null;
	sha: string;
	title?: string | null;
	desc?: string | null;
	threshold?: number;
	budget?: number;
	disabled?: boolean;
}): PatchFirstVerdict => {
	const disabled = o.disabled ?? process.env.SUSPENDERS_PATCH_FIRST === "0";
	if (disabled) return { ok: true };
	if (isDecompositionItem(o.title, o.desc)) return { ok: true };
	const threshold = o.threshold ?? PATCH_FIRST_THRESHOLD;
	const budget = o.budget ?? PATCH_FIRST_CHURN_BUDGET;
	const violations: NonNullable<PatchFirstVerdict["violations"]> = [];
	for (const path of o.paths.filter((p) => p.endsWith(".ts"))) {
		const lines = lineCountAt(o.repo, o.sha, path);
		if (lines === null || lines <= threshold) continue;
		const churn = diffChurn(o.repo, o.baseline, o.sha, path);
		if (!churn) continue; // fail open on unreadable evidence
		const total = churn.added + churn.removed;
		if (total > budget) violations.push({ path, lines, churn: total, budget });
	}
	if (!violations.length) return { ok: true };
	const v = violations[0];
	return {
		ok: false,
		why:
			`patch-first (W744): ${v.path} is ${v.lines} lines (near-cap, threshold ${threshold}) ` +
			`and the closing diff churns ${v.churn} added+removed lines (budget ${v.budget}). ` +
			`Patch it: anchored edits against read anchors, new content in its own file — ` +
			`or close via a decomposition item (title/description must declare it). ` +
			`Escape hatch: SUSPENDERS_PATCH_FIRST=0.`,
	};
};

/** the brief directive: near-cap .ts paths (working tree) get the patch-only
 *  instruction. Returns rendered lines ([] when nothing is near-cap). */
export const briefPatchFirstLines = (
	files: { path: string; lines: number | null }[],
	threshold = PATCH_FIRST_THRESHOLD,
): string[] => {
	const near = files.filter((f) => f.lines !== null && f.lines > threshold);
	if (!near.length) return [];
	const header = `PATCH-FIRST (W744): some file-map files are within ${1500 - threshold} lines of the 1500 hard cap — the on-write gate blocks ALL edits past it:`;
	const body = near.map(
		(f) =>
			`  - ${f.path} is ${f.lines} lines. Patch only: anchored Edits against read anchors; NO whole-file Write; ` +
			`new content goes to its own file; work done verifies the diff shape (churn > ${PATCH_FIRST_CHURN_BUDGET} ` +
			`on this file refuses closure unless the item IS a decomposition).`,
	);
	return [header, ...body];
};
