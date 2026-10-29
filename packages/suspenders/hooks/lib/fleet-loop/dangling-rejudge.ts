// dangling-rejudge.ts — W2189 (re-land of W1762): the dangling-path
// classifier's rejudge face. The flood came from merges landing through
// scanner generations OLDER than the current scoping rules: items minted by
// rules the installed scanner no longer applies. One pass re-runs the
// CURRENT classifier (W1302.8 dangling-classify.ts) over every open
// "Repair dangling path" item's banked evidence and supersedes the rejects
// — legacy per-edge items flip to SUPERSEDED; the aggregate item keeps its
// row and rejects per EDGE (a code.dangling-reject event per edge), its
// surviving edges untouched.
//
// The second half is the prevention rule W1473 got wrong: a classifier fix
// holds REPAIR dispatch keyed on the INSTALLED harness receipt revision
// containing the fix sha — never on a work item's DONE. A merge that lands
// commits touching the classifier banks a `code.dangling-fix` event; the
// dispatch pool skips dangling-path repairs while any banked fix sha is not
// an ancestor of the installed revision (explicit `dispatch --item` stays
// operator-explicit and is never held).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../govdb/govdb.ts";
import { dim } from "../work/work-graph.ts";
import { REFERENCE_FORM, TEST_FILE } from "./dangling-classify.ts";
import { UNJUDGED_TARGET } from "./dangling-paths.ts";

export const DANGLING_REPAIR_TITLE = /^Repair dangling path/;
const CLASSIFIER_PATHS = [
	"packages/suspenders/hooks/lib/fleet-loop/dangling-classify.ts",
	"packages/suspenders/hooks/lib/fleet-loop/dangling-paths.ts",
];
export const REJECT_KIND = "code.dangling-reject";

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
	for (const path of CLASSIFIER_PATHS) {
		const log = git(repo, ["log", "-1", "--format=%H", "--", path]);
		if (log?.trim()) return log.trim();
	}
	return git(repo, ["rev-parse", "HEAD"])?.trim() ?? null;
}

export type DanglingEvidence = {
	target: string;
	refBy: string;
	specifier?: string;
	line: number;
};

/** Apply the CURRENT classifier rules to one banked finding. Returns the
 * reject reason, or null when the finding survives. Probe-1 findings
 * (line > 0, whole-tree grep) keep only the runtime-dir reject — a test
 * file importing a deleted module is a real dangling edge, so test files
 * never reject there. Probe-2 findings (line = 0, the syntax-classified
 * merge delta) already passed dangling-classify's reference-form and file
 * class gates at bank time; they survive unless the target is unjudged. */
export function judgeDanglingEvidence(ref: DanglingEvidence): string | null {
	if (ref.line > 0)
		return UNJUDGED_TARGET.test(ref.target) ? "runtime-dir target" : null;
	if (ref.specifier && !REFERENCE_FORM.test(ref.specifier))
		return "non-reference-form specifier";
	if (TEST_FILE.test(ref.refBy)) return "test-file reference";
	if (UNJUDGED_TARGET.test(ref.target)) return "runtime-dir target";
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

const OPEN_STATES = "state NOT IN ('DONE', 'CANCELLED', 'SUPERSEDED')";

/** One rejudge pass: open dangling-path repairs × their banked
 * code.dangling-path evidence, judged by the current rules. Legacy
 * per-edge items flip to SUPERSEDED with the classifier sha as the
 * recorded result; the aggregate item rejects per edge via
 * code.dangling-reject events — one transaction, batched. */
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
			`SELECT id, title FROM work_items
			 WHERE project = ? AND title LIKE 'Repair dangling path%' AND ${OPEN_STATES}`,
		)
		.all(project) as { id: string; title: string }[];
	const superseded: { id: string; reason: string }[] = [];
	let kept = 0;
	let unevidenced = 0;
	const now = Date.now();
	const short = classifier.slice(0, 12);
	for (const { id, title } of items) {
		const evs = store
			.query(
				"SELECT payload FROM events WHERE kind = 'code.dangling-path' AND scope = ? ORDER BY ts DESC",
			)
			.all(id) as { payload: string }[];
		if (!evs.length) {
			unevidenced++;
			continue;
		}
		const aggregate = !/^Repair dangling path .+ referenced by .+$/.test(title);
		for (const { payload } of evs) {
			const ref = JSON.parse(payload) as DanglingEvidence;
			const reason = judgeDanglingEvidence(ref);
			if (reason === null) {
				kept++;
				continue;
			}
			if (aggregate) {
				if (opts.dryRun) continue;
				superseded.push({ id: `${id}:${ref.target}`, reason });
				store
					.query(
						"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES(?,?,?,?,?,NULL)",
					)
					.run(
						now,
						"work",
						REJECT_KIND,
						id,
						JSON.stringify({
							project,
							target: ref.target,
							refBy: ref.refBy,
							reason,
							classifier,
						}),
					);
			} else {
				superseded.push({ id, reason });
				if (opts.dryRun) continue;
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
			break; // a legacy item judges on its latest evidence alone
		}
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
	const dir =
		prefix ??
		process.env.SUSPENDERS_PREFIX ??
		`${home}/.claude/hooks/suspenders`;
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

/** CLI verb face (W2233 re-land): one `work rejudge dangling [--dry-run]`
 * pass, rendering the rejudge verdict — superseded items, then the
 * classifier line. `die` on a judge error. */
export function runRejudgeVerb(
	store: DanglingStore,
	repo: string,
	die: (m: string) => never,
	opts: { dryRun?: boolean } = {},
): void {
	const result = rejudgeDangling(store, repo, opts);
	if ("error" in result) die(`rejudge: ${result.error}`);
	for (const { id, reason } of result.superseded)
		console.log(`${dim("■")} ${id} superseded — ${reason}`);
	console.log(
		`REJUDGE classifier ${result.classifier.slice(0, 12)}: ${result.superseded.length} superseded, ${result.kept} kept, ${result.unevidenced} unevidenced`,
	);
}
