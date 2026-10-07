import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GovernorStore } from "./govdb.ts";
import { scanCompletionDiff } from "./fake-completion.ts";

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
export function prepareCompletion(
	db: CompletionStore,
	o: {
		project: string;
		item: string;
		sid: string;
		cwd: string;
		sha: string | null;
		summary: string | null;
	},
): CompletionRecord | null {
	let context: { sid?: string; item?: string; baseline?: string } | null = null;
	let top = o.cwd;
	try {
		top = git(o.cwd, "rev-parse", "--show-toplevel");
	} catch {}
	const contextPath = join(top, ".fleet", "lane-context.json");
	if (existsSync(contextPath)) {
		try {
			context = JSON.parse(readFileSync(contextPath, "utf8"));
		} catch {
			throw new Error(
				"Invalid lane completion context; restore it before completing",
			);
		}
		if (context?.item !== o.item || context.sid !== o.sid)
			throw new Error(
				"Lane completion context does not match this item and owner",
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
	const sha = git(top, "rev-parse", "--verify", `${o.sha}^{commit}`);
	if (!o.summary) {
		if (capsule.item && capsule.item !== o.item)
			throw new Error(
				"Final capsule belongs to another item; supply --summary for this completion",
			);
		if (
			typeof capsule.checkpoint !== "string" ||
			git(top, "rev-parse", "--verify", `${capsule.checkpoint}^{commit}`) !==
				sha
		)
			throw new Error(
				"Final capsule checkpoint must match the completion commit",
			);
	}

	let baseline: string | null = null;
	let paths: string[];
	if (context?.baseline) {
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
	}
	if (!paths.some(productPath))
		throw new Error(
			"Completion has no product commit evidence; retain the claim and record a blocked decision instead",
		);
	// W511: fake-completion integrity scan on the closing diff's added lines —
	// the gate refuses closure while gated tests, stub notes or
	// placeholder-error throws ride the sha being claimed as done
	const diffText = baseline
		? git(top, "diff", "-U0", baseline, sha)
		: git(top, "diff-tree", "--root", "--no-commit-id", "-p", "-r", "-U0", sha);
	const hits = scanCompletionDiff(diffText).filter((hit) =>
		productPath(hit.path),
	);
	if (hits.length)
		throw new Error(
			`Completion diff carries fake-completion markers (${hits.length}) — remove or finish them, then land a new sha:\n${hits
				.slice(0, 10)
				.map((hit) => `  ${hit.path}:${hit.line} [${hit.marker}] ${hit.text}`)
				.join("\n")}${hits.length > 10 ? `\n  … ${hits.length - 10} more` : ""}`,
		);
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
