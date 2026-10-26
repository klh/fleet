// brief-intel.ts — W254 pointer-grade injection for dispatch briefs: a
// file-map with line anchors + a done-definition digest, derived from the
// item's own mission text at dispatch time. W113 measured where this pays:
// value rides file-level pointer density (injection-final −33% tokens), while
// small self-contained surfaces are a pure tax (+7.6–26.7%) — so the map is
// GATED on repo size and on coverage the mission text already carries.
// Read-only at dispatch: git ls-files + ripgrep, no repo writes.
import { readFileSync } from "node:fs";
import { briefPatchFirstLines, countLinesOf } from "../work/patch-first.ts";

export type BriefIntel = {
	/** rendered `- path:line — matched: <terms>` pointers, relevance-ranked */
	fileMap: string[];
	/** rendered `- <criterion>` lines extracted from the mission text */
	doneDigest: string[];
	/** W744: rendered patch-first directive lines for near-cap .ts files the
	 *  file map surfaced ([] when none) */
	patchFirst?: string[];
	/** set when the file map was gated off — log it, never inject silently */
	skip?: string;
};

/** W113 small-repo tax gate: surfaces this small are held in one head — a
 *  map taxes more than it saves (38-file surface: +27% duration; the 268-file
 *  suspenders repo benefits). 100 tracked files separates them. */
export const SMALL_REPO_FILES = 100;
export const MAX_TERMS = 10;
export const MAX_FILES = 8;
/** a mission that already names this many repo paths carries its own map. */
export const SPEC_PATH_SKIP = 3;

/** mission-text terms worth pointing at: repo paths, file names, identifiers
 *  with code-shaped casing/punctuation (camelCase, kebab/-, snake/_, dotted),
 *  and work-item ids (W113). Prose words never match a shape rule. */
export const missionTerms = (text: string): string[] => {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of text.match(/[A-Za-z0-9][\w+./-]{3,}/g) ?? []) {
		const w = raw.replace(/^[./+-]+|[./+-]+$/g, "");
		if (w.length < 4) continue;
		const isPath = /\//.test(w);
		const isFile = /^\w[\w-]*\.[A-Za-z]{1,4}$/.test(w);
		const camel = /[a-z][A-Z]/.test(w);
		const joined = /\w[-_]\w/.test(w);
		const workId = /^W\d+$/.test(w);
		if (!(isPath || isFile || camel || joined || workId)) continue;
		const key = w.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(w);
		if (out.length >= MAX_TERMS) break;
	}
	return out;
};

const DONE_RE =
	/\b(?:done when|considers? (?:it )?done|definition of done|accept\w*|verif(?:y|ied|ies)|evidence|gates? (?:green|pass\w*)|must (?:land|pass|ship|include)|sign-?off)\b/i;

/** done-definition digest: the mission's own completion-criteria segments
 *  (sentences and bullet lines). No markers → empty — never pad with filler;
 *  the raw mission already rides as MISSION. */
export const doneDigest = (text: string): string[] => {
	const segs = text
		.split("\n")
		.flatMap((l) => l.split(/(?<=[.!?;])\s+/))
		.map((s) => s.replace(/^[-*•\s]+/, "").trim())
		.filter(Boolean);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const s of segs) {
		if (!DONE_RE.test(s)) continue;
		const key = s.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(s.length > 160 ? `${s.slice(0, 157)}...` : s);
		if (out.length >= 5) break;
	}
	return out;
};

const escapeRe = (s: string): string =>
	s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** kebab/snake mission tokens also search their camelCase spelling so prose
 *  like "file-map" finds fileMap in source (case-insensitive rg does most of
 *  the bridging; the variant catches the hump that -i cannot). */
const variantsOf = (w: string): string[] => {
	if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(w)) {
		const camel = w
			.split(/[-_]/)
			.map((s, i) => (i ? s.charAt(0).toUpperCase() + s.slice(1) : s))
			.join("");
		return [w, camel];
	}
	return [w];
};

const run = (cmd: string[], cwd: string): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}`.trim(),
	};
};

/** working-tree line count for a repo-relative path; null when unreadable. */
const workingTreeLines = (repoRoot: string, path: string): number | null => {
	try {
		return countLinesOf(readFileSync(`${repoRoot}/${path}`, "utf8"));
	} catch {
		return null;
	}
};

const trackedFiles = (repoRoot: string): number | null => {
	const r = run(["git", "ls-files"], repoRoot);
	return r.code === 0 ? (r.out ? r.out.split("\n").length : 0) : null;
};

/** the gated pipeline. Returns sections to render into the brief; `skip`
 *  names the gate that fired (dispatchers log it — loud, never silent). */
export const briefIntel = (
	repoRoot: string,
	missionText: string,
	gate?: { smallRepo?: number },
): BriefIntel => {
	const intel: BriefIntel = {
		fileMap: [],
		doneDigest: doneDigest(missionText),
	};
	const min = gate?.smallRepo ?? SMALL_REPO_FILES;
	const n = trackedFiles(repoRoot);
	if (n !== null && n < min) {
		intel.skip = `small repo (${n} tracked files < ${min}) — W113 tax gate`;
		return intel;
	}
	if (!Bun.which("rg")) {
		intel.skip = "rg not on PATH";
		return intel;
	}
	const specPaths = missionText.match(/(?:[\w.-]+\/)+[\w.-]+/g) ?? [];
	if (specPaths.length >= SPEC_PATH_SKIP) {
		intel.skip = `mission already names ${specPaths.length} paths`;
		return intel;
	}
	const terms = missionTerms(missionText);
	if (!terms.length) {
		intel.skip = "no searchable terms in the mission text";
		return intel;
	}
	const byFile = new Map<
		string,
		{ hits: number; line: number; terms: Set<string> }
	>();
	for (const t of terms) {
		const pat = variantsOf(t).map(escapeRe).join("|");
		const out = run(
			["rg", "-n", "-i", "-m", "8", "--no-heading", "-e", pat, "."],
			repoRoot,
		);
		if (out.code !== 0) continue;
		for (const line of out.out.split("\n")) {
			const m = /^([^:]+):(\d+):/.exec(line);
			if (!m) continue;
			const f = m[1].replace(/^\.\//, "");
			const ln = Number(m[2]);
			const cur = byFile.get(f) ?? {
				hits: 0,
				line: ln,
				terms: new Set<string>(),
			};
			cur.hits += 1;
			if (ln < cur.line) cur.line = ln;
			cur.terms.add(t);
			byFile.set(f, cur);
		}
	}
	if (!byFile.size) {
		intel.skip = "no file hits for the mission terms";
		return intel;
	}
	intel.fileMap = [...byFile.entries()]
		.sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0]))
		.slice(0, MAX_FILES)
		.map(
			([f, v]) =>
				`- ${f}:${v.line} — matched: ${[...v.terms].sort().join(", ")}`,
		);
	// W744: the map's .ts files get a working-tree line count; near-cap ones
	// carry the patch-only directive (anchored edits, no whole-file Write).
	intel.patchFirst = briefPatchFirstLines(
		[...byFile.keys()]
			.filter((f) => f.endsWith(".ts"))
			.map((f) => ({ path: f, lines: workingTreeLines(repoRoot, f) })),
	);
	return intel;
};

/** brief lines for the intel sections; [] when there is nothing to say —
 *  pointer discipline: never pad the brief with headers without content. */
export const renderIntel = (intel: BriefIntel | null | undefined): string[] => {
	if (
		!intel ||
		(!intel.fileMap.length &&
			!intel.doneDigest.length &&
			!intel.patchFirst?.length)
	)
		return [];
	const lines: string[] = [];
	if (intel.fileMap.length) {
		lines.push(
			`FILE MAP (pointer-grade, derived from the mission — verify anchors before editing):`,
		);
		for (const l of intel.fileMap) lines.push(`  ${l}`);
	}
	if (intel.doneDigest.length) {
		lines.push(`DONE DEFINITION (digest — the lane's stop condition):`);
		for (const s of intel.doneDigest) lines.push(`  - ${s}`);
	}
	if (intel.patchFirst?.length) lines.push(...intel.patchFirst);
	return lines;
};
