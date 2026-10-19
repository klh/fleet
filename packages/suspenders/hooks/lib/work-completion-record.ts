import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectRootOf, type GovernorStore } from "./govdb.ts";
import { scanCompletionDiff } from "./fake-completion.ts";
import { patchFirstVerdict } from "./patch-first.ts";
import { claimCheckVerdict } from "./claim-check.ts";
import { resolveTranscriptPath } from "./transcript.ts";
import {
	claimTokenVerdict,
	evidenceCheck,
	evidencePatternsOf,
} from "./work-fence.ts";

type CompletionStore = Pick<GovernorStore, "query" | "run">;

export interface CompletionRecord {
	project: string;
	item: string;
	summary: string;
	summary_hash: string;
	commit_sha: string;
	baseline_sha: string | null;
	completed_by: string;
	completed_at: number;
	capsule_json: string;
	evidence_json: string;
}
function ensureRecords(db: CompletionStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS work_completion_records (
 project TEXT NOT NULL, item TEXT NOT NULL, summary TEXT NOT NULL, summary_hash TEXT NOT NULL,
 commit_sha TEXT NOT NULL, baseline_sha TEXT, completed_by TEXT NOT NULL,
 completed_at INTEGER NOT NULL, capsule_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
 PRIMARY KEY(project, item))`);
	ensureCompletionIdentityMigration(db);
	db.run(
		`CREATE TRIGGER IF NOT EXISTS work_completion_immutable_delete BEFORE DELETE ON work_completion_records BEGIN SELECT RAISE(ABORT, 'completion records are immutable'); END`,
	);
}
/** Project is the graph's movable identity reference; evidence fields never change. */
export function ensureCompletionIdentityMigration(db: CompletionStore): void {
	const existing = db
		.query(
			"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='work_completion_immutable_update'",
		)
		.get() as { sql: string } | undefined;
	if (existing?.sql.includes("NEW.item IS NOT OLD.item")) return;
	db.run("DROP TRIGGER IF EXISTS work_completion_immutable_update");
	db.run(`CREATE TRIGGER work_completion_immutable_update BEFORE UPDATE ON work_completion_records
 WHEN NEW.item IS NOT OLD.item OR NEW.summary IS NOT OLD.summary OR NEW.summary_hash IS NOT OLD.summary_hash
 OR NEW.commit_sha IS NOT OLD.commit_sha OR NEW.baseline_sha IS NOT OLD.baseline_sha
 OR NEW.completed_by IS NOT OLD.completed_by OR NEW.completed_at IS NOT OLD.completed_at
 OR NEW.capsule_json IS NOT OLD.capsule_json OR NEW.evidence_json IS NOT OLD.evidence_json
 BEGIN SELECT RAISE(ABORT, 'completion records are immutable'); END`);
}
export function completionRecord(
	db: CompletionStore,
	project: string,
	item: string,
): CompletionRecord | null {
	try {
		return db
			.query(
				"SELECT * FROM work_completion_records WHERE project = ? AND item = ?",
			)
			.get(project, item) as CompletionRecord | null;
	} catch {
		return null;
	}
}
const git = (cwd: string, ...args: string[]) => {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`Cannot verify completion commit evidence: git ${args[0]} failed`,
		);
	return result.stdout.toString().trim();
};
const productPath = (path: string): boolean =>
	!/^((\.fleet|\.claude|\.agents|node_modules)(\/|$)|\.klh-(brief|done)\.md$|\.workgraph\.jsonl$)/.test(
		path,
	);
type LaneContext = {
	sid?: string;
	item?: string;
	baseline?: string;
	/** W643: the claim token dispatch banked at take — durable channel. */
	claimToken?: string;
};
/** Lane identity is absolute: missing → null, corrupt → hard error, and a
 * context bound to another item or owner is rejected, never ignored —
 * except the graph-proven kept-child case (W652.1): `work split --keep`
 * claims the kept child for the SPLITTER, whose dispatch context still
 * names the SHATTERED parent. When the context item is the completing
 * item's actual parent and the sid binding holds, the parent-bound
 * context may complete the child. */
const laneContextAt = (
	path: string,
	item: string,
	sid: string,
	parentOf: (id: string) => string | null = () => null,
): LaneContext | null => {
	if (!existsSync(path)) return null;
	let context: LaneContext;
	try {
		context = JSON.parse(readFileSync(path, "utf8")) as LaneContext;
	} catch {
		throw new Error(
			"Invalid lane completion context; restore it before completing",
		);
	}
	if (context?.sid !== sid)
		throw new Error(
			"Lane completion context does not match this item and owner",
		);
	// W652.1 kept-child: the graph link proves the parent binding
	if (context?.item !== item && context.item !== parentOf(item))
		throw new Error(
			"Lane completion context does not match this item and owner",
		);
	return context;
};
/** W601: scope=<name> pins a sibling checkout as the item's evidence repo —
 * the directory beside the graph project's checkout root. Charset-guarded:
 * free-text scope can never path-escape that parent. */
const scopeRepo = (project: string, scope: string): string => {
	const dir = join(dirname(projectRootOf(project)), scope);
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope) ||
		!existsSync(join(dir, ".git"))
	)
		throw new Error(
			`Item scope "${scope}" does not name a sibling repo checkout of ${dirname(projectRootOf(project))}`,
		);
	return dir;
};
const hasCommit = (cwd: string, ref: string): boolean => {
	try {
		git(cwd, "rev-parse", "--verify", `${ref}^{commit}`);
		return true;
	} catch {
		return false;
	}
};
const tryGit = (cwd: string, ...args: string[]): boolean => {
	try {
		git(cwd, ...args);
		return true;
	} catch {
		return false;
	}
};
/** W601: cross-repo closure evidence — the scope repo's own lane-branch diff
 * (suspenders/<item> vs merge-base with the default head), degrading to the
 * single closure commit when no branch resolves. */
const crossRepoEvidence = (
	shaRepo: string,
	item: string,
	sha: string,
): { paths: string[]; diffText: string; diffBase: string | null } => {
	const branch = `suspenders/${item}`;
	let diffBase: string | null = null;
	if (
		hasCommit(shaRepo, `refs/heads/${branch}`) &&
		tryGit(shaRepo, "merge-base", "--is-ancestor", sha, branch)
	) {
		const head = ["main", "master"].find((ref) => hasCommit(shaRepo, ref));
		if (head) {
			diffBase = git(shaRepo, "merge-base", sha, head);
			if (diffBase === sha) diffBase = null;
		}
	}
	return {
		diffBase,
		paths: (diffBase
			? git(shaRepo, "diff", "--name-only", diffBase, sha)
			: git(
					shaRepo,
					"diff-tree",
					"--root",
					"--no-commit-id",
					"--name-only",
					"-r",
					sha,
				)
		)
			.split("\n")
			.filter(Boolean),
		diffText: diffBase
			? git(shaRepo, "diff", "-U0", diffBase, sha)
			: git(
					shaRepo,
					"diff-tree",
					"--root",
					"--no-commit-id",
					"-p",
					"-r",
					"-U0",
					sha,
				),
	};
};
export function prepareCompletion(
	db: CompletionStore,
	o: {
		project: string;
		item: string;
		sid: string;
		cwd: string;
		sha: string | null;
		summary: string | null;
		/** W643: --token / KLH_CLAIM_TOKEN as passed by work done. */
		token?: string | null;
	},
): CompletionRecord | null {
	let context: LaneContext | null = null;
	let top = o.cwd;
	try {
		top = git(o.cwd, "rev-parse", "--show-toplevel");
	} catch {}
	let contextRepo = top;
	// W652.1: graph-backed parent lookup for the kept-child context binding
	const parentOf = (id: string): string | null => {
		try {
			const row = db
				.query("SELECT parent_id FROM work_items WHERE project = ? AND id = ?")
				.get(o.project, id) as { parent_id: string } | null;
			return row?.parent_id ?? null;
		} catch {
			return null;
		}
	};
	context = laneContextAt(
		join(top, ".fleet", "lane-context.json"),
		o.item,
		o.sid,
		parentOf,
	);
	if (!context && /^autow/.test(o.sid)) {
		const wt = join(projectRootOf(o.project), ".worktrees", o.item);
		const fallback = laneContextAt(
			join(wt, ".fleet", "lane-context.json"),
			o.item,
			o.sid,
			parentOf,
		);
		if (fallback) {
			context = fallback;
			contextRepo = wt;
		}
	}
	// W628: when the W652.1 parent binding carried this closure, warn — the
	// kept lane's context should have been rebound by split (W628) but still
	// names the SHATTERED parent. Closure proceeds; the warning tells the lane
	// the binding is stale.
	if (context && context.item !== o.item) {
		const parent = String(context.item);
		const parentRow = db
			.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
			.get(o.project, parent) as { state?: string } | undefined;
		const kept =
			parentRow?.state === "SHATTERED"
				? db
						.query(
							"SELECT id FROM work_items WHERE project = ? AND parent_id = ? AND owner_sid = ? AND state IN ('CLAIMED','RUNNING') LIMIT 1",
						)
						.get(o.project, parent, o.sid)
				: undefined;
		if (kept)
			console.error(
				`warning: lane context still names ${parent} (SHATTERED; kept child ${o.item} owned by ${o.sid}) — split --keep rebinds the context itself (W628); closure proceeds via the W652.1 parent binding`,
			);
	}
	if (/^autow/.test(o.sid) && !context)
		throw new Error(
			"Dispatched completion requires its original lane context and baseline",
		);
	if (context && !context.baseline)
		throw new Error(
			"Dispatched completion requires immutable baseline evidence; restore the original lane context",
		);
	// W643 claim-token fence: the row hash must match a presented token —
	// flag/env via o.token, or the lane context claimToken (the durable
	// channel — env pins can be lost to settings-env merges; the file is not).
	const hashRow = db
		.query(
			"SELECT claim_token_hash, evidence FROM work_items WHERE project = ? AND id = ?",
		)
		.get(o.project, o.item) as
		| {
				claim_token_hash: string | null;
				evidence: string | null;
		  }
		| undefined;
	const verdict = claimTokenVerdict(
		hashRow ?? {},
		o.token ?? context?.claimToken ?? null,
	);
	if (!verdict.ok) throw new Error(verdict.why);
	const fact = db
		.query("SELECT value, source FROM facts WHERE key = ?")
		.get(`lane.${o.sid}.capsule`) as
		| { value: string; source: string }
		| undefined;
	let capsule: Record<string, unknown> = {};
	if (fact?.source === o.sid) {
		try {
			capsule = JSON.parse(fact.value);
		} catch {}
	}
	const raw =
		o.summary ?? (typeof capsule.done === "string" ? capsule.done : null);
	// Compatibility: older manual ledger closures remain explicitly unverified.
	// Every dispatched lane and every summary-bearing closure uses verified evidence.
	if (!context && !raw) return null;
	const summary = raw?.trim().replace(/\s+/g, " ") ?? "";
	if (summary.length < 40 || summary.length > 4000)
		throw new Error(
			"Completion requires a 40-4000 character paragraph via --summary or a final capsule done field",
		);
	if (!o.sha || !/^[a-f0-9]{7,40}$/i.test(o.sha))
		throw new Error(
			"Completion requires a real --sha commit, not a no-op or placeholder",
		);
	const scope = (
		db
			.query("SELECT scope FROM work_items WHERE project = ? AND id = ?")
			.get(o.project, o.item) as { scope?: string | null } | undefined
	)?.scope?.trim();
	let sha: string;
	let shaRepo = top;
	try {
		sha = git(top, "rev-parse", "--verify", `${o.sha}^{commit}`);
	} catch {
		// W601: foreign sha — the item's scope repo owns the evidence
		if (!scope)
			throw new Error(
				`Cannot verify completion commit evidence: ${o.sha} is not a commit in this repo and the item declares no scope repo`,
			);
		shaRepo = scopeRepo(o.project, scope);
		try {
			sha = git(shaRepo, "rev-parse", "--verify", `${o.sha}^{commit}`);
		} catch {
			throw new Error(
				`Cannot verify completion commit evidence: ${o.sha} is not a commit in the graph repo or its scope repo (${scope})`,
			);
		}
	}
	const crossRepo = contextRepo !== shaRepo;
	if (!o.summary) {
		if (capsule.item && capsule.item !== o.item)
			throw new Error(
				"Final capsule belongs to another item; supply --summary for this completion",
			);
		if (
			typeof capsule.checkpoint !== "string" ||
			git(
				shaRepo,
				"rev-parse",
				"--verify",
				`${capsule.checkpoint}^{commit}`,
			) !== sha
		)
			throw new Error(
				"Final capsule checkpoint must match the completion commit",
			);
	}

	let baseline: string | null = null;
	let diffBase: string | null = null;
	let paths: string[];
	let diffText: string;
	if (crossRepo) {
		({ diffBase, paths, diffText } = crossRepoEvidence(shaRepo, o.item, sha));
	} else if (context?.baseline) {
		baseline = git(
			top,
			"rev-parse",
			"--verify",
			`${context.baseline}^{commit}`,
		);
		git(top, "merge-base", "--is-ancestor", baseline, sha);
		git(top, "merge-base", "--is-ancestor", sha, "HEAD");
		paths = git(top, "diff", "--name-only", baseline, sha)
			.split("\n")
			.filter(Boolean);
		diffText = git(top, "diff", "-U0", baseline, sha);
	} else {
		paths = git(
			top,
			"diff-tree",
			"--root",
			"--no-commit-id",
			"--name-only",
			"-r",
			sha,
		)
			.split("\n")
			.filter(Boolean);
		diffText = git(
			top,
			"diff-tree",
			"--root",
			"--no-commit-id",
			"-p",
			"-r",
			"-U0",
			sha,
		);
	}
	if (!paths.some(productPath))
		throw new Error(
			"Completion has no product commit evidence; retain the claim and record a blocked decision instead",
		);
	// W744 patch-first: near-cap .ts files in the closing diff must be patched,
	// not rewritten — churn beyond the budget refuses closure unless the item
	// IS a decomposition (title/description declares it).
	const pfRow = db
		.query(
			"SELECT title, description FROM work_items WHERE project = ? AND id = ?",
		)
		.get(o.project, o.item) as
		| { title: string; description: string | null }
		| undefined;
	const pf = patchFirstVerdict({
		repo: shaRepo,
		paths,
		baseline,
		sha,
		title: pfRow?.title,
		desc: pfRow?.description,
	});
	if (!pf.ok) throw new Error(pf.why ?? "patch-first refusal");
	// W511: fake-completion integrity scan on the closing diff's added lines —
	// the gate refuses closure while gated tests, stub notes or
	// placeholder-error throws ride the sha being claimed as done
	const hits = scanCompletionDiff(diffText).filter((hit) =>
		productPath(hit.path),
	);
	if (hits.length)
		throw new Error(
			`Completion diff carries fake-completion markers (${hits.length}) — remove or finish them, then land a new sha:\n${hits
				.slice(0, 10)
				.map((hit) => `  ${hit.path}:${hit.line} [${hit.marker}] ${hit.text}`)
				.join(
					"\n",
				)}${hits.length > 10 ? `\n  … ${hits.length - 10} more` : ""}`,
		);
	// W643 evidence-gated transition: declared patterns must EACH match the
	// summary, a product path, or the added diff lines — absence rejects the
	// transition itself.
	const declared = (() => {
		try {
			return evidencePatternsOf(hashRow?.evidence ?? null);
		} catch (e) {
			throw new Error(
				`evidence: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	})();
	if (declared?.length) {
		const missing = evidenceCheck(declared, { summary, paths, diffText });
		if (missing.length)
			throw new Error(
				`Completion evidence missing required patterns (${missing.length}/${declared.length} unsatisfied): ${missing.map((m) => `/${m}/`).join(", ")} — matched none of summary / product paths / added diff lines`,
			);
	}
	// W833 claim-check: test-pass claims in the lane transcript or capsule
	// must ride a real passing run that predates the claim, with no
	// test-affecting file changed since, and the closing diff must not
	// erode the suite (deleted tests, focused/expected-failure gates,
	// loosened assertions). SUSPENDERS_CLAIM_CHECK=0 disables.
	const cc = claimCheckVerdict({
		transcriptPath:
			resolveTranscriptPath({ session_id: o.sid, cwd: o.cwd }) ?? undefined,
		capsuleDone: typeof capsule.done === "string" ? capsule.done : undefined,
		capsuleTs: typeof capsule.ts === "number" ? capsule.ts : undefined,
		paths,
		diffText,
		statRoot: shaRepo,
	});
	if (!cc.ok) throw new Error(cc.why ?? "claim-check refusal");
	const completedAt = Date.now();
	const finalCapsule = {
		...capsule,
		checkpoint: sha,
		done: summary,
		next: "complete",
		item: o.item,
		ts: completedAt,
	};
	return {
		project: o.project,
		item: o.item,
		summary,
		summary_hash: createHash("sha256").update(summary).digest("hex"),
		commit_sha: sha,
		baseline_sha: baseline,
		completed_by: o.sid,
		completed_at: completedAt,
		capsule_json: JSON.stringify(finalCapsule),
		evidence_json: JSON.stringify({
			origin_project: o.project,
			paths: paths.filter(productPath),
			verified_at: completedAt,
			...(crossRepo
				? { scope, verify_repo: shaRepo, diff_base: diffBase }
				: {}),
		}),
	};
}
export function persistCompletion(
	db: CompletionStore,
	record: CompletionRecord,
): void {
	ensureRecords(db);
	db.query(
		"INSERT INTO work_completion_records (project,item,summary,summary_hash,commit_sha,baseline_sha,completed_by,completed_at,capsule_json,evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		record.project,
		record.item,
		record.summary,
		record.summary_hash,
		record.commit_sha,
		record.baseline_sha,
		record.completed_by,
		record.completed_at,
		record.capsule_json,
		record.evidence_json,
	);
	db.query(
		"INSERT INTO facts (key,value,source,version,ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts",
	).run(
		`lane.${record.completed_by}.capsule`,
		record.capsule_json,
		record.completed_by,
		record.completed_at,
	);
}
export function completionTail(
	db: CompletionStore,
	project: string,
	item: string,
): { text: string; ts: string; source: string } | null {
	const record = completionRecord(db, project, item);
	return record
		? {
				text: record.summary,
				ts: new Date(record.completed_at).toISOString(),
				source: "completion",
			}
		: null;
}
