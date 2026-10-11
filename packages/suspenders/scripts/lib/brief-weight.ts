// scripts/lib/brief-weight.ts — W633 instruction-weight audit: measure the
// per-dispatch instruction injection so brief+protocol weight is reportable
// in coord metrics, and so redundancy trims land without losing a gate.
//
// Three measured surfaces per lane run:
//   brief     composeBrief boilerplate (the constant part of every brief,
//             measured with a one-line mission placeholder)
//   agents    the repo AGENTS.md chain — root + packages/*/AGENTS.md; a lane
//             loads root + its package's file, so per-lane exposure uses the
//             heaviest package file (decision-grade upper bound)
//   harness   ~/.claude/CLAUDE.md + ~/.claude/rules/*.md (machine-local,
//             honest null when absent)
//
// Plus the REAL numbers where they exist: the buckle ledger's router_usage ⋈
// api_keys (usage key = sha256(presented token)[:12]; api_keys.key_hash is
// the full sha256, so the join is substr(key_hash,1,12)) gives per-lane
// in_tok — the first request of a lane carries the whole injection, so the
// median in_tok/req per lane is the empirical injected weight.
//
// Tokens ≈ chars/4 (ASCII prose heuristic — surfaced as an estimate only).
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** ASCII prose heuristic; callers surface it as an estimate, never exact. */
export const approxTok = (s: string): number => Math.ceil(s.length / 4);

export interface PkgAgents {
	/** repo-relative AGENTS.md path, packages/<name>/AGENTS.md */
	file: string;
	tok: number;
}

export interface BriefWeight {
	/** composeBrief boilerplate, approx tokens */
	brief: number;
	/** byte length of the same boilerplate (byte-level trend diffs) */
	briefChars: number;
	/** repo-root AGENTS.md, null when the repo has none */
	rootAgents: number | null;
	/** package AGENTS.md files, heaviest first */
	pkgAgents: PkgAgents[];
	/** CLAUDE.md + rules markdown under the home dotdir, null when none */
	harness: number | null;
	/** brief + root + heaviest package + harness (approx tokens) */
	perLaneStaticTok: number;
}

/** package AGENTS.md paths, heaviest file first (only ones that exist). */
export function pkgAgentFiles(repo: string): string[] {
	const names = lsPackages(repo);
	const files: { file: string; chars: number }[] = [];
	for (const n of names) {
		const p = `packages/${n}/AGENTS.md`;
		if (!existsSync(join(repo, p))) continue;
		files.push({ file: p, chars: readFileSync(join(repo, p), "utf8").length });
	}
	return files.sort((a, b) => b.chars - a.chars).map((f) => f.file);
}

const lsPackages = (repo: string): string[] => {
	try {
		return readdirSync(join(repo, "packages"));
	} catch {
		return [];
	}
};

/** Machine-local harness injection: the global CLAUDE.md + rules markdown
 *  under ~/.claude. null when neither exists (hubs, non-klh machines). */
export function harnessTok(): number | null {
	const home = homedir();
	const claudeMd = join(home, ".claude", "CLAUDE.md");
	const rulesDir = join(home, ".claude", "rules");
	let tok = 0;
	let found = false;
	if (existsSync(claudeMd)) {
		tok += approxTok(readFileSync(claudeMd, "utf8"));
		found = true;
	}
	try {
		for (const f of readdirSync(rulesDir)) {
			if (!f.endsWith(".md")) continue;
			tok += approxTok(readFileSync(join(rulesDir, f), "utf8"));
			found = true;
		}
	} catch {
		// no rules dir — CLAUDE.md alone may still have counted
	}
	return found ? tok : null;
}

/** per-lane REAL token spend row (buckle ledger join) */
export interface LaneTokens {
	lane: string;
	inTok: number;
	outTok: number;
	cacheR: number;
	reqs: number;
}

/** Per-lane REAL token spend from the buckle ledger over a window:
 *  router_usage ⋈ api_keys on substr(key_hash,1,12), windowed by the ISO
 *  hour bucket. Sorted by in_tok desc. Empty on missing db/schema — the
 *  caller omits the real-number half rather than faking zeros. */
export function buckleLaneTokens(
	dbPath: string,
	days: number,
	nowMs = Date.now(),
): LaneTokens[] {
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		const cut = new Date(nowMs - days * 86_400_000).toISOString().slice(0, 13);
		return db
			.query(
				`SELECT ak.name AS lane, SUM(ru.in_tok) AS inTok, SUM(ru.out_tok) AS outTok,
						SUM(ru.cache_r) AS cacheR, SUM(ru.requests) AS reqs
				 FROM router_usage ru
				 JOIN api_keys ak ON ru.key = substr(ak.key_hash, 1, 12)
				 WHERE ru.hour_bucket >= ?
				 GROUP BY ak.name ORDER BY inTok DESC`,
			)
			.all(cut) as unknown as LaneTokens[];
	} catch {
		return [];
	} finally {
		db?.close();
	}
}

/** The composer import is lazy (dynamic) — coord loads this module eagerly
 *  on every verb, and the dispatch graph must not ride along for all of
 *  them. Null on any load failure: metrics just omits the line. */
async function loadComposeBrief(): Promise<ComposeBriefFn | null> {
	try {
		const m = await import("./brief.ts");
		return m.composeBrief;
	} catch {
		return null;
	}
}

type ComposeBriefFn = (o: {
	item: string;
	showOut: string;
	sid: string;
	branch: string;
	worktree: string;
	capsule: null;
	repo: string;
}) => string;

/** Full static-injection measurement for one repo: composes the boilerplate
 *  brief via the REAL composer (lazy import), reads the AGENTS.md chain and
 *  the machine harness surfaces, sums the per-lane exposure. Null when the
 *  composer cannot load (non-fleet metrics runs omit the line). */
export async function measureBriefWeight(
	repo: string,
): Promise<BriefWeight | null> {
	const composeBrief = await loadComposeBrief();
	if (!composeBrief) return null;
	const brief = composeBrief({
		item: "W000",
		showOut: "◐ W000 CLAIMED mission placeholder for the weight probe",
		sid: "brief-weight-probe",
		branch: "brief-weight-probe",
		worktree: "/tmp/brief-weight-probe",
		capsule: null,
		repo,
	});
	const briefTok = approxTok(brief);
	const rootPath = join(repo, "AGENTS.md");
	const rootAgents = existsSync(rootPath)
		? approxTok(readFileSync(rootPath, "utf8"))
		: null;
	const pkgAgents = pkgAgentFiles(repo).map((file) => ({
		file,
		tok: approxTok(readFileSync(join(repo, file), "utf8")),
	}));
	const harness = harnessTok();
	const heaviest = pkgAgents[0]?.tok ?? 0;
	return {
		brief: briefTok,
		briefChars: brief.length,
		rootAgents,
		pkgAgents,
		harness,
		perLaneStaticTok: briefTok + (rootAgents ?? 0) + heaviest + (harness ?? 0),
	};
}
