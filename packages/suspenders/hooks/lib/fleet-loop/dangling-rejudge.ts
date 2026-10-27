// dangling-rejudge.ts — W1762: the dangling-path classifier's rejudge face.
// The flood (415 open "Repair dangling path" items, 0 confirmed dangling
// edges — W1714 audit @ b7d773f0) came from merges landing through scanner
// generations OLDER than the merged W1302.2.1 scoping rules: items minted by
// rules the installed scanner no longer applies. One verb re-runs the
// CURRENT classifier rules over every open item's banked evidence and
// supersedes the rejects in one transaction — survivors keep their items
// and their code.dangling-path edges.
//
// The second half is the prevention rule W1473 got wrong: a classifier fix
// holds REPAIR dispatch keyed on the INSTALLED harness receipt revision
// containing the fix sha — never on a work item's DONE. A merge that lands
// commits touching the classifier bank a `code.dangling-fix` event; the
// dispatch pool skips dangling-path repairs while any banked fix sha is not
// an ancestor of the installed revision (explicit `dispatch --item` stays
// operator-explicit and is never held).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	FIXTURE_FILE,
	RUNTIME_DIR,
	REFERENCE_FORM,
} from "./dangling-paths.ts";
import { projectIdentity } from "../govdb/govdb.ts";

export const DANGLING_REPAIR_TITLE = /^Repair dangling path /;
const CLASSIFIER_PATH =
	"packages/suspenders/hooks/lib/fleet-loop/dangling-paths.ts";

const git = (repo: string, args: string[]): string | null => {
	const p = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0 ? p.stdout.toString() : null;
};

/** object existence probe — cat-file -e prints nothing, so the exit code
 * is the answer (the stdout-only git() helper cannot express it). */
const objectExists = (repo: string, sha: string): boolean =>
	Bun.spawnSync(["git", "-C", repo, "cat-file", "-e", sha], {
		stdout: "pipe",
		stderr: "pipe",
	}).exitCode === 0;

/** sha of the last commit that touched the classifier — the revision the
 * rejudge cites as its reason, and the sha a fix-hold keys on. A tree with
 * no commit touching the classifier (fresh fixture) cites its HEAD. */
export function classifierRevision(repo: string): string | null {
	const log = git(repo, ["log", "-1", "--format=%H", "--", CLASSIFIER_PATH]);
	if (log?.trim()) return log.trim();
	return git(repo, ["rev-parse", "HEAD"])?.trim() ?? null;
}

export type DanglingEvidence = {
	target: string;
	refBy: string;
	specifier: string;
	line: number;
};

/** Apply the CURRENT (W1302.2.1) classifier rules to one banked finding.
 * Returns the reject reason, or null when the finding survives. Probe 1
 * (line > 0) keeps whole-tree grep — a test file importing a deleted module
 * is a real dangling edge — so only runtime-dir targets reject there.
 * Probe 2 (line = 0) judges only reference-form specifiers in non-fixture
 * files against tracked targets. */
export function judgeDanglingEvidence(ref: DanglingEvidence): string | null {
	if (ref.line > 0)
		return RUNTIME_DIR.test(ref.target) ? "runtime-dir target" : null;
	if (!REFERENCE_FORM.test(ref.specifier)) return "non-reference-form specifier";
	if (FIXTURE_FILE.test(ref.refBy)) return "fixture-file reference";
	if (RUNTIME_DIR.test(ref.target)) return "runtime-dir target";
	return null;
}

type DanglingStore = {
	query(sql: string): {
		get(...v: unknown[]): unknown;
		all(...v: unknown[]): unknown[];
	};
	run(sql: string, ...v: unknown[]): unknown;
};

export type RejudgeResult = {
	superseded: { id: string; reason: string }[];
	kept: number;
	unevidenced: number;
	classifier: string;
};

/** The ONE rejudge pass: open dangling-path repairs × their banked
 * code.dangling-path evidence, judged by the current rules. Rejected items
 * flip to SUPERSEDED with the classifier sha as the recorded by/why —
 * batched in ONE transaction, never a per-item CLI loop. */
export function rejudgeDangling(
	store: DanglingStore,
	repo: string,
	opts: { dryRun?: boolean } = {},
): RejudgeResult | { error: string } {
	const classifier = classifierRevision(repo);
	if (!classifier) return { error: "no classifier revision — not a git repo?" };
	const project = projectIdentity(repo);
	const items = store
		.query(
			`SELECT id FROM work_items
			 WHERE project = ? AND title LIKE 'Repair dangling path %'
			   AND state NOT IN ('DONE', 'CANCELLED', 'SUPERSEDED')`,
		)
		.all(project) as { id: string }[];
	const superseded: { id: string; reason: string }[] = [];
	let kept = 0;
	let unevidenced = 0;
	for (const { id } of items) {
		const ev = store
			.query(
				`SELECT payload FROM events
				 WHERE kind = 'code.dangling-path' AND scope = ? ORDER BY ts DESC LIMIT 1`,
			)
			.get(id) as { payload: string } | null;
		if (!ev) {
			unevidenced++;
			continue;
		}
		const ref = JSON.parse(ev.payload) as DanglingEvidence;
		const reason = judgeDanglingEvidence(ref);
		if (reason === null) {
			kept++;
			continue;
		}
		superseded.push({ id, reason });
	}
	if (opts.dryRun || !superseded.length)
		return { superseded, kept, unevidenced, classifier };
	const now = Date.now();
	const short = classifier.slice(0, 12);
	for (const { id, reason } of superseded) {
		store
			.query(
				"UPDATE work_items SET state = 'SUPERSEDED', result_sha = ?, updated_at = ? WHERE project = ? AND id = ?",
			)
			.run(classifier, now, project, id);
		store
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
			)
			.run(
				now,
				"work",
				"work.superseded",
				id,
				JSON.stringify({
					work: id,
					project,
					note: `rejudge: ${reason} (classifier ${short})`,
				}),
			);
	}
	return { superseded, kept, unevidenced, classifier };
}

// ---- fix-hold: install-keyed, never item-DONE-keyed -----------------------

/** Idempotently bank one classifier-fix sha at merge time. */
export function recordDanglingFix(
	store: DanglingStore,
	project: string,
	sha: string,
): boolean {
	const seen = store
		.query(
			"SELECT 1 FROM events WHERE kind = 'code.dangling-fix' AND scope = ? LIMIT 1",
		)
		.get(sha);
	if (seen) return false;
	store
		.query(
			"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
		)
		.run(
			Date.now(),
			"fleet-loop",
			"code.dangling-fix",
			sha,
			JSON.stringify({ project, sha }),
		);
	return true;
}

/** The installed harness receipt revision, or null when this machine has
 * no installed generation (nothing can be "installed" yet — never hold). */
export function installedRevision(prefix?: string): string | null {
	const home = process.env.HOME ?? "";
	const dir = prefix ?? process.env.SUSPENDERS_PREFIX ?? `${home}/.claude/hooks/suspenders`;
	if (!existsSync(join(dir, "harness-receipt.json"))) return null;
	try {
		const receipt = JSON.parse(
			readFileSync(join(dir, "harness-receipt.json"), "utf8"),
		) as { revision?: string };
		return receipt.revision ?? null;
	} catch {
		return null;
	}
}

/** Fix shas banked for this project that the INSTALLED generation does not
 * yet contain (empty = no hold). */
export function pendingDanglingFixes(
	store: DanglingStore,
	repo: string,
	prefix?: string,
): { sha: string; revision: string | null }[] {
	const project = projectIdentity(repo);
	const installed = installedRevision(prefix);
	if (!installed) return [];
	const rows = store
		.query(
			"SELECT scope, payload FROM events WHERE kind = 'code.dangling-fix' AND scope IS NOT NULL",
		)
		.all() as { scope: string; payload: string }[];
	const out: { sha: string; revision: string | null }[] = [];
	for (const { scope: sha, payload } of rows) {
		try {
			if ((JSON.parse(payload) as { project?: string }).project !== project)
				continue;
		} catch {
			continue;
		}
		const anc = Bun.spawnSync(
			["git", "-C", repo, "merge-base", "--is-ancestor", sha, installed],
			{ stdout: "pipe", stderr: "pipe" },
		);
		// unresolvable sha (garbage row): treat as installed — never hold forever
		if (anc.exitCode !== 0 && !objectExists(repo, sha)) continue;
		if (anc.exitCode !== 0) out.push({ sha, revision: installed });
	}
	return out;
}

/** Dispatch-pool hold lines for the READY items a pending (merged, not
 * installed) classifier fix freezes. */
export function danglingFixHolds(
	store: DanglingStore,
	repo: string,
	titles: { id: string; title: string }[],
): Map<string, string> {
	const fixes = pendingDanglingFixes(store, repo);
	const holds = new Map<string, string>();
	if (!fixes.length) return holds;
	for (const { id, title } of titles) {
		if (!DANGLING_REPAIR_TITLE.test(title)) continue;
		for (const f of fixes)
			holds.set(
				id,
				`classifier fix ${f.sha.slice(0, 12)} merged but not installed (receipt ${f.revision?.slice(0, 12) ?? "?"})`,
			);
	}
	return holds;
}
