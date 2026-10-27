// work-graph.ts — the graph-DB core of the Work Graph CLI (hooks/bin/work.ts):
// the lazy project-partitioned store handle, row access (get/setState/emit/
// deps), dependency roll-up, id allocation, item mint, and claim release. The
// bin keeps the verb doors; everything that touches work_items rows lives
// here (THEN.C decomposition, 2026-10-23).
//
// project-scoping invariant (composite PK: (project, id)): NO work_items query
// identifies a row by id alone, NO work_deps query omits project. Row access
// goes through get/setState/deps, which own the project bind; the only
// exception is take's CAS, which needs the state guard in its WHERE.
import type { GovernorStore } from "../govdb/govdb.ts";
import { openStore, projectIdentity, projectRootOf } from "../govdb/govdb.ts";
import { unmergedDeps, unmergedNote } from "../gates/dep-merge-gate.ts";
import { dieFor } from "../verb-kit.ts";
import { mergeTags } from "./work-tags.ts";
import { MIRROR_NAME, mirrorOrNull } from "./work-mirror.ts";
import { preferTagFor } from "../prefer.ts";
import { releaseWorkClaim } from "./work-release.ts";
import { resolveItemWorktree } from "./worktree-lookup.ts";

const die = dieFor("work");

// LAZY DB open with per-command routing (was a module-top direct DB open):
// mutators need the real DB — die with a hint when it is unreachable; readers
// may fall back to the committed .workgraph.jsonl mirror. An empty project
// partition counts as unreachable for readers: items are never deleted, so
// zero rows means this machine's DB has never seen this project's graph
// (fresh clone / worktree on a new machine — the beads use case).
let VERB = ""; // current verb — set by the kit onVerb hook
export function setWorkVerb(name: string): void {
	VERB = name;
}
let handle: GovernorStore | undefined;
export function db(): GovernorStore {
	if (handle) return handle;
	const isRead = READ_CMDS.has(VERB);
	let d: GovernorStore;
	try {
		d = openStore();
	} catch (e) {
		if (isRead) {
			const m = mirrorOrNull(PROJECT);
			if (m) {
				handle = m;
				return m;
			}
		}
		die(
			`governor.db unreachable (${e instanceof Error ? e.message : String(e)}) — mutations need the DB; the committed ${MIRROR_NAME} mirror keeps reads alive`,
		);
	}
	if (isRead) {
		const n = (
			d
				.query("SELECT COUNT(*) AS n FROM work_items WHERE project = ?")
				.get(PROJECT) as { n: number }
		).n;
		if (n === 0) {
			const m = mirrorOrNull(PROJECT);
			if (m) {
				handle = m;
				return m;
			}
		}
	}
	handle = d;
	return d;
}

// project partitioning: shared identity from govdb (repo's common git dir) —
// sessions in different projects never see or steal each other's work
export const PROJECT = projectIdentity();

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint =
	(code: string) =>
	(s: string): string =>
		tty ? `\x1b[${code}m${s}\x1b[0m` : s;
export const dim = paint("2");
export const cyan = paint("36");
export const green = paint("32");
export const amber = paint("33");
export const red = paint("31");

// ---- workgraph mirror (beads-inspired, W32) ------------------------------
// beads commits its issue graph as JSONL so a fresh clone sees the queue with
// zero server access and git history becomes the audit trail. governor.db is
// centralized, so the work CLI mirrors it: every SUCCESSFUL mutating command
// atomically re-exports this project's graph to <repo>/.workgraph.jsonl, and
// read verbs fall back to that file when the DB cannot serve the project —
// unreachable, or a fresh machine whose empty partition has never seen this
// graph (items are never deleted, so an empty partition means "never seen").
// The DB always wins when it holds the project's rows; reads never write.
const READ_CMDS = new Set([
	"stats",
	"report",
	"list",
	"ready",
	"mine",
	"owned",
	"show",
	"summary",
	"orphaned",
]);
export const MUTATING_CMDS = new Set([
	"add",
	"take",
	"release",
	"start",
	"done",
	"fail",
	"wait",
	"wake",
	"cancel",
	"edit",
	"supersede",
	"block",
	"unblock",
	"split",
	"reclaim",
	"migrate-ledger",
]);

export type Item = Record<string, string | number | null>;
export function get(id: string): Item {
	const r = db()
		.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
		.get(PROJECT, id) as Item | undefined;
	if (!r) die(`no such work item in this project: ${id}`);
	return r;
}

// owner/sha semantics: undefined = keep current value, null = clear
export function setState(
	id: string,
	state: string,
	owner?: string | null,
	sha?: string | null,
): void {
	const sets = ["state = ?", "updated_at = ?"];
	const vals: (string | number)[] = [state, Date.now()];
	if (owner !== undefined) {
		sets.push("owner_sid = ?");
		vals.push(owner);
	}
	if (sha !== undefined) {
		sets.push("result_sha = ?");
		vals.push(sha);
	}
	db()
		.query(
			`UPDATE work_items SET ${sets.join(", ")} WHERE project = ? AND id = ?`,
		)
		.run(...vals, PROJECT, id);
}

export function emit(
	kind: string,
	id: string,
	extra: Record<string, string> = {},
	source = "work",
): void {
	db()
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) SELECT ?, ?, ?, scope, ?, NULL FROM work_items WHERE project = ? AND id = ?",
		)
		.run(
			Date.now(),
			source,
			kind,
			JSON.stringify({ work: id, project: PROJECT, ...extra }),
			PROJECT,
			id,
		);
}

export function deps(
	id: string,
): { depends_on: string; state: string | null; result_sha: string | null }[] {
	return db()
		.query(
			"SELECT d.depends_on, w.state, w.result_sha FROM work_deps d LEFT JOIN work_items w ON w.id = d.depends_on AND w.project = d.project WHERE d.project = ? AND d.work_id = ?",
		)
		.all(PROJECT, id) as {
		depends_on: string;
		state: string | null;
		result_sha: string | null;
	}[];
}

// W60 dep-merge gate (done ≠ merged) lives in lib/dep-merge-gate.ts —
// work.ts feeds it this project's dep rows.

export function depsMet(id: string): boolean {
	return (
		deps(id).every((d) => d.state === "DONE") &&
		!unmergedDeps(deps(id), PROJECT).length
	);
}

// reaches(id, target): would a dependency edge id→target create/extend a cycle?
export function reaches(
	id: string,
	target: string,
	seen = new Set<string>(),
): boolean {
	if (id === target) return true;
	if (seen.has(id)) return false;
	seen.add(id);
	for (const d of deps(id))
		if (reaches(d.depends_on, target, seen)) return true;
	return false;
}

// roll-up: a SHATTERED parent auto-DONEs ONLY when every required child is in
// a successful terminal state — DONE, or SUPERSEDED (replaced; its successor
// carries the work). Positively defined: FAILED/ORPHANED children block the
// parent (recover them: reclaim → finish, or supersede), a nested SHATTERED
// child blocks until its own leaves close (rollUp recurses up from each
// child transition), and any future unknown state blocks by default.
export function rollUp(id: string): void {
	const it = get(id);
	if (it.state !== "SHATTERED") return;
	const unsatisfied = db()
		.query(
			"SELECT id, state FROM work_items WHERE project = ? AND parent_id = ? AND (required IS NULL OR required = 1) AND state NOT IN ('DONE','SUPERSEDED')",
		)
		.all(PROJECT, id) as { id: string; state: string }[];
	if (unsatisfied.length === 0) {
		setState(id, "DONE");
		emit("work.done", id, { auto: "all required children done/superseded" });
		freeDependents(id);
		const p = it.parent_id;
		if (p) rollUp(p as string);
	}
}

// done→ready auto-start (W50): when an item lands DONE, each dependent still
// in READY whose deps are now all DONE is startable — emit work.ready per such
// item (payload note "unblocked by <id>") so the board flags it ▶ and a lane
// can self-serve the chain without re-deriving it. Same gate as take: depsMet.
export function freeDependents(id: string): {
	freed: string[];
	gated: { id: string; note: string }[];
} {
	const waiting = db()
		.query(
			"SELECT d.work_id FROM work_deps d JOIN work_items w ON w.id = d.work_id AND w.project = d.project WHERE d.project = ? AND d.depends_on = ? AND w.state = 'READY'",
		)
		.all(PROJECT, id) as { work_id: string }[];
	const freed: string[] = [];
	const gated: { id: string; note: string }[] = [];
	for (const { work_id: wid } of waiting) {
		const ds = deps(wid);
		if (!ds.every((d) => d.state === "DONE")) continue; // not ready anyway — unchanged behavior
		const note = unmergedNote(deps(wid), PROJECT);
		if (note)
			gated.push({ id: wid, note }); // W60: deps done but sha unmerged — stays gated
		else freed.push(wid);
	}
	for (const wid of freed)
		emit("work.ready", wid, { unblocked_by: id, note: `unblocked by ${id}` });
	return { freed, gated };
}

export function nextRootId(): string {
	// atomic per-project allocation: one upsert statement is the allocator, so
	// concurrent `work add` races each get a distinct id instead of one losing
	// to a UNIQUE error. Seeds from existing max, then increments.
	const tx = db().transaction(() => {
		db()
			.query(
				"INSERT INTO work_sequences (project, next_id) SELECT ?, COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) + 1 FROM work_items WHERE project = ? AND id GLOB 'W[0-9]*' AND id NOT LIKE '%.%' ON CONFLICT(project) DO UPDATE SET next_id = next_id + 1",
			)
			.run(PROJECT, PROJECT);
		return (
			db()
				.query("SELECT next_id FROM work_sequences WHERE project = ?")
				.get(PROJECT) as { next_id: number }
		).next_id;
	});
	return `W${tx()}`;
}

export function insertItem(
	id: string,
	parentId: string | null,
	title: string,
	scope: string | null,
	priority: number,
	by: string,
	why: string | null,
	requires: string | null = null,
	description: string | null = null,
	effort: string | null = null,
	evidence: string | null = null,
	extraTags: string | null = null,
): void {
	db()
		.query(
			"INSERT INTO work_items (id, parent_id, title, state, priority, created_by, scope, why_parallel, project, required, requires, tags, effort, evidence, created_at, updated_at, description) VALUES (?, ?, ?, 'READY', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			id,
			parentId,
			title,
			priority,
			by,
			scope,
			why,
			PROJECT,
			requires,
			mergeTags(preferTagFor(projectRootOf(PROJECT)), extraTags),
			effort,
			evidence,
			Date.now(),
			Date.now(),
			description,
		);
}

// claim coupling on release; the claim-side coupling (take) lives in
// lib/work-alloc.ts assignTask() — one ownership system, not two that drift
export function releaseClaim(
	sid: string,
	scope: string | null,
	itemId?: string,
): void {
	// release the autoClaim (sid,scope) AND legacy/intent-scoped claims that
	// reference this item — scopeless items otherwise leak claims on DONE
	db()
		.query(
			"DELETE FROM claims WHERE sid = ? AND (scope = ? OR (? IS NOT NULL AND intent LIKE ? || ' %'))",
		)
		.run(sid, scope, itemId ?? null, itemId ?? "");
}
// W52/W182 — retire the item's per-item worktree when its work closes (shared
// by done and cancel): clean → removed, dirty → kept with a note (work is
// never silently discarded); branch suspenders/<id> always survives
export function retireItemWorktree(id: string): void {
	// W211: resolve from git's registry by branch, never a derived path — the
	// old PROJECT.slice(0, -4) guess silently skipped the retire whenever the
	// tree stood outside .worktrees/ or the identity wasn't <root>/.git
	const wtDir = resolveItemWorktree(projectRootOf(PROJECT), id);
	if (!wtDir) return;
	const w = Bun.spawnSync(
		[
			process.execPath,
			new URL("../../bin/worktree.ts", import.meta.url).pathname,
			"retire",
			id,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (w.exitCode === 3)
		console.log(`${amber("●")} worktree kept (dirty) — ${wtDir}`);
	else if (w.exitCode === 4)
		console.log(`${amber("●")} worktree kept (live lane inside) — ${wtDir}`);
}

export function releaseObserved(
	it: Item,
	by: string,
	reason: "owner-release" | "operator-reclaim" | "reclaim-all",
	guard?: () => boolean,
): boolean {
	return releaseWorkClaim(
		db(),
		{
			project: PROJECT,
			id: String(it.id),
			owner: it.owner_sid as string | null,
			state: String(it.state),
			updatedAt: Number(it.updated_at),
		},
		{ by, reason },
		guard,
	);
}
