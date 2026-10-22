// work.ts — the Work Graph: hierarchical, claimable, shatterable work items
// in governor.db, partitioned per project (repo root). Replaces the old
// Markdown as the operational state DB — Markdown keeps architecture and
// decisions; the DB owns runtime state.
//
// project-scoping invariant (composite PK: (project, id)): NO work_items query
// identifies a row by id alone, NO work_deps query omits project. Row access
// goes through get/setState/deps, which own the project bind; the only
// exception is take's CAS, which needs the state guard in its WHERE.
//
// usage: GENERATED from the verb registry — `work --help`, `work <verb> --help`.
// workgraph mirror (beads-inspired): mutations re-export <repo>/.workgraph.jsonl
// (atomic, best-effort); reads fall back to the committed mirror when
// governor.db cannot serve the project — fresh clone / DB unreachable.

import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { automaticRecoveryCheck } from "../lib/automatic-recovery.ts";
import { budgetFlagClear } from "../lib/budget-flag.ts";
import { itemCapsuleKey } from "../lib/capsule-fence.ts";
import { unmergedDeps, unmergedNote } from "../lib/dep-merge-gate.ts";
import {
	assertCaps,
	type GovernorStore,
	openStore,
	projectIdentity,
	projectRootOf,
	resolveSidOf,
} from "../lib/govdb.ts";
import {
	recordKnowledgeSuggestion,
	renderKnowledgeSuggestion,
	suggestKnowledge,
} from "../lib/kev-curation.ts";
import { rebindKeptLaneContext } from "../lib/lane-context.ts";
import { doneSpendStamp, parseDoneSpend } from "../lib/lane-done-spend.ts";
import { doneEffortStamp } from "../lib/lane-effort.ts";
import { publishCompletionBlock } from "../lib/lane-stop-publisher.ts";
import { gitBadge, gitObservation, mergeReadyWhy } from "../lib/lane-git.ts";
import { laneAlive } from "../lib/lane-liveness.ts";
import {
	loadLaneRegistry,
	loadLaneRegistryFile,
} from "../lib/lane-registry.ts";
import { itemAttribution, renderAttribution } from "../lib/lane-spend.ts";
import { triggerMergeOnDone } from "../lib/merge-on-done.ts";
import { preferTagFor } from "../lib/prefer.ts";
import {
	claimantLanes,
	matchingClaimantLane,
	reclaimAll,
} from "../lib/reclaim-all.ts";
import {
	parseDuration,
	probeClaim,
	setReclaimHold,
} from "../lib/reclaim-liveness.ts";
import {
	parseReclaimReason,
	reclaimGateDecision,
} from "../lib/reclaim-sticky.ts";
import { reproGateRefusal } from "../lib/repro-gate.ts";
import { reapIfIdle } from "../lib/subscribe-attach.ts";
import { dieFor, idList, type Parsed, runCli } from "../lib/verb-kit.ts";
import {
	applyAllocations,
	assignTask,
	candidateLanes,
	nextChildIdOf,
	planAllocation,
	renderAllocPlan,
} from "../lib/work-alloc.ts";
import {
	type CompletionRecord,
	completionRecord,
	persistCompletion,
	prepareCompletion,
	reactivationRefusal,
} from "../lib/work-completion-record.ts";
import { EFFORTS } from "../lib/work-effort.ts";
import { evidencePatternsOf } from "../lib/work-fence.ts";
import { queueCompletionKnowledge } from "../lib/work-knowledge.ts";
import { runMigrateLedger } from "../lib/work-migrate-ledger.ts";
import { exportMirror, MIRROR_NAME, mirrorOrNull } from "../lib/work-mirror.ts";
import { releaseWorkClaim } from "../lib/work-release.ts";
import { GLYPH, renderRow, renderTimestamps } from "../lib/work-render.ts";
import {
	buildReportTable,
	parseReportWindow,
	reportRows,
	reportTableLinkOpts,
} from "../lib/work-report.ts";
import { retryFailedItem } from "../lib/work-retry.ts";
import { mergeTags, validateTags } from "../lib/work-tags.ts";
import { VERBS } from "../lib/work-verbs.ts";
import {
	parseWaitUntil,
	waitForPrerequisite,
	wakeAfterEvidence,
} from "../lib/work-wait.ts";
import { resolveItemWorktree } from "../lib/worktree-lookup.ts";
import { provisionForTake } from "../lib/worktree-provision.ts";

const die = dieFor("work");

// LAZY DB open with per-command routing (was a module-top direct DB open):
// mutators need the real DB — die with a hint when it is unreachable; readers
// may fall back to the committed .workgraph.jsonl mirror. An empty project
// partition counts as unreachable for readers: items are never deleted, so
// zero rows means this machine's DB has never seen this project's graph
// (fresh clone / worktree on a new machine — the beads use case).
let VERB = ""; // current verb — set by the kit onVerb hook
let handle: GovernorStore | undefined;
function db(): GovernorStore {
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
const PROJECT = projectIdentity();

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint =
	(code: string) =>
	(s: string): string =>
		tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const amber = paint("33");
const red = paint("31");

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
const MUTATING_CMDS = new Set([
	"add",
	"take",
	"release",
	"start",
	"done",
	"fail",
	"wait",
	"wake",
	"cancel",
	"supersede",
	"block",
	"unblock",
	"split",
	"reclaim",
	"migrate-ledger",
]);

type Item = Record<string, string | number | null>;
function get(id: string): Item {
	const r = db()
		.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
		.get(PROJECT, id) as Item | undefined;
	if (!r) die(`no such work item in this project: ${id}`);
	return r;
}

// owner/sha semantics: undefined = keep current value, null = clear
function setState(
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

function emit(
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

function deps(
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

function depsMet(id: string): boolean {
	return (
		deps(id).every((d) => d.state === "DONE") &&
		!unmergedDeps(deps(id), PROJECT).length
	);
}

// reaches(id, target): would a dependency edge id→target create/extend a cycle?
function reaches(
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
function rollUp(id: string): void {
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
function freeDependents(id: string): {
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

function nextRootId(): string {
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

function insertItem(
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
function releaseClaim(
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
function retireItemWorktree(id: string): void {
	// W211: resolve from git's registry by branch, never a derived path — the
	// old PROJECT.slice(0, -4) guess silently skipped the retire whenever the
	// tree stood outside .worktrees/ or the identity wasn't <root>/.git
	const wtDir = resolveItemWorktree(projectRootOf(PROJECT), id);
	if (!wtDir) return;
	const w = Bun.spawnSync(
		[
			process.execPath,
			new URL("./worktree.ts", import.meta.url).pathname,
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

function releaseObserved(
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

// W610: claimant LaneRefs by sid — registry rows feed laneProcessIdentity;
// a claimant with no registry entry (manual takes, reaped rows) probes from
// heartbeat + transcript alone and reads unknown, never dead. W376: built by
// lib/reclaim-all.ts claimantLanes (shared with the fleet-loop reclaim sweep).

// W795: show's renderer extracted from the dispatch chain — the multi-id
// loop calls it once per id instead of growing the chain (patch-first
// near-cap contract, W744).
const showOne = (id: string, json: boolean): void => {
	const it = get(id);
	if (json) {
		const capRow = db()
			.query("SELECT value FROM facts WHERE key = ?")
			.get(itemCapsuleKey(PROJECT, String(id))) as { value: string } | null;
		console.log(
			JSON.stringify({
				...it,
				completion: completionRecord(db(), PROJECT, String(it.id)),
				capsule: capRow ? JSON.parse(capRow.value) : null,
				attribution:
					itemAttribution(db() as unknown as Database, PROJECT).get(
						String(it.id),
					) ?? null,
			}),
		);
		return;
	}
	const [g, col] = GLYPH[it.state as string] ?? ["?", dim];
	console.log(`${col(g)} ${it.id} ${col(it.state as string)}  ${it.title}`);
	for (const k of [
		"scope",
		"owner_sid",
		"result_sha",
		"why_parallel",
		"requires",
		"tags",
		"effort",
		"evidence",
		"alloc_reason",
		"wait_kind",
		"wait_reason",
		"description",
	] as const) {
		if (it[k]) console.log(`  ${dim(`${k}:`)} ${it[k]}`);
	}
	if (it.wait_until)
		console.log(
			`  ${dim("wait_until:")} ${new Date(Number(it.wait_until)).toISOString()}`,
		);
	console.log(
		renderTimestamps(
			it,
			completionRecord(db(), PROJECT, String(it.id))?.completed_at ?? null,
		).join("\n"),
	);
	// W617/W687: the item capsule + W776 attribution travel with the item
	const cap = db()
		.query("SELECT value FROM facts WHERE key = ?")
		.get(itemCapsuleKey(PROJECT, String(id))) as { value: string } | null;
	if (cap) console.log(`  ${dim("capsule:")} ${cap.value}`);
	const at = itemAttribution(db() as unknown as Database, PROJECT).get(
		String(id),
	);
	if (at) {
		const line = renderAttribution(at);
		if (line) console.log(`  ${dim("spend:")} ${line}`);
	}
	const kids = db()
		.query(
			"SELECT * FROM work_items WHERE project = ? AND parent_id = ? ORDER BY id",
		)
		.all(PROJECT, id) as Item[];
	if (kids.length) {
		console.log(dim("  children:"));
		console.log(kids.map(renderRow).join("\n"));
	}
	const d = deps(id);
	if (d.length)
		console.log(
			dim(
				`  depends on: ${d.map((x) => `${x.depends_on}(${x.state ?? "?"})`).join(", ")}`,
			),
		);
};

const dispatchVerb = async (
	name: string,
	{ pos, flag, rest }: Parsed,
): Promise<void> => {
	if (name === "add") {
		const title = pos[0];
		if (!title)
			die(
				'usage: add <title> [--scope s] [--parent <id>] [--priority n] [--desc "..."] [--by sid] [--tag t1,t2]',
			);
		const parent = flag("--parent");
		const scope = flag("--scope");
		const priority = Number(flag("--priority") ?? 0);
		const by = flag("--by") ?? "unknown";
		let requires: string | null = null;
		const reqRaw = flag("--requires");
		if (reqRaw) {
			try {
				requires = assertCaps(reqRaw);
			} catch (error) {
				die(
					`requires: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		// W846 mint-time classification: validated tags stamp the tags column
		// (merged with the .prefer tree tag) so rework counters never title-regex
		let extraTags: string | null = null;
		const tagRaw = flag("--tag");
		if (tagRaw) {
			try {
				extraTags = validateTags(tagRaw);
			} catch (error) {
				die(`tag: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const effort = flag("--effort");
		if (effort && !(EFFORTS as readonly string[]).includes(effort))
			die(`unknown effort: ${effort} — vocabulary: ${EFFORTS.join(" | ")}`);
		// W643 evidence gate input: one regex, or a JSON array of them — every
		// pattern must match the closing evidence at done, else it refuses.
		let evidence: string | null = null;
		const evRaw = flag("--evidence");
		if (evRaw) {
			try {
				evidencePatternsOf(evRaw);
			} catch (error) {
				die(
					`evidence: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			evidence = evRaw;
		}
		if (parent) get(parent);
		// W743 repro-first gate: a re-mint of a FAILED item must carry evidence
		const remintRefusal = reproGateRefusal(
			db(),
			PROJECT,
			`${title} ${flag("--desc") ?? ""}`,
		);
		if (remintRefusal) die(remintRefusal);
		const id = parent ? nextChildIdOf(db(), PROJECT, parent) : nextRootId();
		insertItem(
			id,
			parent,
			title,
			scope,
			priority,
			by,
			flag("--reason"),
			requires,
			flag("--desc"),
			effort,
			evidence,
			extraTags,
		);
		emit("work.added", id, { scope: scope ?? "" });
		console.log(
			`${green("✓")} ${cyan(id)} ${dim("READY")} — ${title} ${dim(`[project: ${PROJECT}]`)}`,
		);
	} else if (name === "list" || name === "ready") {
		const mode = name === "ready" ? "ready" : (rest[0] ?? "open");
		let rows: Item[];
		const unmergedNotes: string[] = [];
		if (mode === "ready") {
			const all = db()
				.query(
					"SELECT * FROM work_items WHERE project = ? AND state = 'READY' ORDER BY priority DESC, id",
				)
				.all(PROJECT) as Item[];
			rows = all.filter((r) => depsMet(r.id as string));
			for (const r of all) {
				if (rows.includes(r)) continue;
				const note = unmergedNote(deps(r.id as string), PROJECT);
				if (note) unmergedNotes.push(`${note} — ${r.id} stays gated`);
			}
		} else if (mode === "all") {
			rows = db()
				.query("SELECT * FROM work_items WHERE project = ? ORDER BY id")
				.all(PROJECT) as Item[];
		} else {
			rows = db()
				.query(
					"SELECT * FROM work_items WHERE project = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED') ORDER BY id",
				)
				.all(PROJECT) as Item[];
		}
		console.log(rows.map(renderRow).join("\n") || dim("(none)"));
		for (const n of unmergedNotes) console.log(dim(`  ${n}`));
	} else if (name === "mine") {
		const as = flag("--as");
		if (!as) die("usage: mine --as <sid>");
		const rows = db()
			.query(
				"SELECT * FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED') ORDER BY id",
			)
			.all(PROJECT, as) as Item[];
		console.log(
			rows.length ? rows.map(renderRow).join("\n") : dim("(nothing owned)"),
		);
	} else if (name === "owned") {
		const rows = db()
			.query(
				"SELECT * FROM work_items WHERE project = ? AND owner_sid IS NOT NULL AND state NOT IN ('DONE','CANCELLED','SUPERSEDED') ORDER BY owner_sid, id",
			)
			.all(PROJECT) as Item[];
		console.log(rows.map(renderRow).join("\n") || dim("(nothing owned)"));
	} else if (name === "stats") {
		const counts = db()
			.query(
				"SELECT state, COUNT(*) AS n FROM work_items WHERE project = ? GROUP BY state",
			)
			.all(PROJECT) as { state: string; n: number }[];
		const done = db()
			.query(
				"SELECT MAX(updated_at) AS latest_done FROM work_items WHERE project = ? AND state = 'DONE'",
			)
			.get(PROJECT) as { latest_done: number | null };
		console.log(
			JSON.stringify({
				project: PROJECT,
				counts: Object.fromEntries(counts.map((r) => [r.state, r.n])),
				latest_done: done.latest_done,
			}),
		);
	} else if (name === "report") {
		// W892: the supervisor micro-metrics table — the ONE reply table
		// (supersedes the W865 prose list). Riding + queued + recent-done,
		// or strict --ids. A bad window dies at the parse boundary.
		const winRaw = flag("--done-window");
		const doneWindowMs = winRaw ? parseReportWindow(winRaw) : null;
		if (winRaw && doneWindowMs === null)
			die("report: bad --done-window — try 45m | 12h | 2d (s/m/h/d, ≤30d)");
		const ids = idList([...pos, ...(flag("--ids") ?? "").split(",")]);
		const { rows, missing } = reportRows(db() as unknown as Database, PROJECT, {
			ids,
			doneWindowMs: doneWindowMs ?? undefined,
			now: Date.now(),
		});
		if (missing.length > 0)
			die(`no such work item in this project: ${missing[0]}`);
		console.log(buildReportTable(rows, reportTableLinkOpts()));
	} else if (name === "show") {
		const json = flag("--json");
		for (const id of idList(pos)) showOne(id, Boolean(json));
		if (json) process.exit(0);
	} else if (name === "take") {
		const id = pos[0];
		let as = flag("--as");
		const origin = flag("--origin");
		if (
			rest.includes("--reconcile-context") &&
			(!flag("--evidence") || !rest.includes("--force"))
		)
			die(
				"take --reconcile-context requires --force --evidence <0600-json>; this is an explicit local operator repair, not SID authentication",
			);
		if (!id || !as) die("usage: take <id> --as <sid> [--origin <host:agent>]");
		// truncated-sid guard: a display slice (e.g. 'visual-c') must not become
		// the owner of record — expand a unique session-sid prefix to the full sid
		as = resolveSidOf(db(), as);
		const it = get(id);
		// capability-aware dispatch (v2): requires ⊆ capabilities or refuse —
		// kills the W28/W29-class NO-SHELL dead spawn at the CLI boundary
		const caps = (
			(
				db()
					.query("SELECT capabilities FROM sessions WHERE sid = ?")
					.get(as) as {
					capabilities: string | null;
				} | null
			)?.capabilities ?? ""
		)
			.split(",")
			.filter(Boolean);
		const missing = ((it.requires as string | null) ?? "")
			.split(",")
			.filter(Boolean)
			.filter((r) => !caps.includes(r));
		if (missing.length)
			die(
				`${id} requires [${missing.join(",")}] — session ${as.slice(0, 8)} advertises [${caps.join(",") || "none"}] — dispatch to a capable agent`,
			);
		if (!depsMet(id)) {
			const unmet = deps(id)
				.filter((d) => d.state !== "DONE")
				.map((d) => d.depends_on);
			const unmerged = unmergedDeps(deps(id), PROJECT).map(
				(x) => `dep ${x.dep} done but unmerged (sha not on main)`,
			);
			die(
				`${id} has unmet dependencies: ${[...unmet, ...unmerged].join(", ")}`,
			);
		}
		// compare-and-set through the ONE assignment gateway (W515): the CAS +
		// claim coupling + post-lock readiness recheck + alloc_reason audit stamp
		// happen in a single transaction inside assignTask
		const claimed = assignTask(db(), PROJECT, {
			id,
			sid: as,
			reason: "manual take",
			origin: origin ?? null,
			token: flag("--token") ?? process.env.KLH_CLAIM_TOKEN ?? null,
			expectedRevision: flag("--expect-updated-at")
				? Number(flag("--expect-updated-at"))
				: undefined,
			reconcileEvidence: rest.includes("--reconcile-context")
				? (flag("--evidence") ?? undefined)
				: undefined,
		});
		if (!claimed.ok)
			die(
				claimed.why === "race lost"
					? `${id} was taken (or is not READY) — race lost, pick another from \`work ready\``
					: `${id} claim refused: ${claimed.why}`,
			);
		console.log(`${green("✓")} ${cyan(id)} claimed by ${dim(as.slice(0, 8))}`);
		// W870: never treeless claims — the claim's worktree mints/attaches
		// here (dispatch's behavior, now the only behavior) and prints; the
		// location-vs-claim gate binds edits to this tree.
		const prov = provisionForTake(projectRootOf(PROJECT), id, PROJECT);
		if (!prov.ok)
			console.error(
				`worktree mint FAILED (${prov.err}) — ${id} stays claimed but TREELESS; fix the git failure, then worktree.ts retire ${id} and re-take to attach`,
			);
		console.log(`worktree: ${prov.path}${prov.attached ? " (attached)" : ""}`);
		// W643: the raw token prints ONCE — channels for lanes: KLH_CLAIM_TOKEN
		// env (dispatch/supervise pin it) + .fleet/lane-context.json claimToken.
		if (claimed.token)
			console.log(
				`claim token: ${claimed.token}  (present it to work done via --token; re-take after a reclaim mints a new one)`,
			);
	} else if (name === "release") {
		const id = pos[0];
		const as = flag("--as");
		if (!id || !as) die("usage: release <id> --as <sid>");
		const it = get(id);
		// release is the OWNER's give-up: state and caller are verified — --as is
		// no longer accepted-then-ignored. Operator override for a foreign/stuck
		// item stays explicit: `work reclaim`.
		if (!["CLAIMED", "RUNNING"].includes(it.state as string))
			die(`${id} is ${it.state} — only CLAIMED/RUNNING work can be released`);
		const owner = resolveSidOf(db(), as);
		if (it.owner_sid !== owner)
			die(
				`${id} is owned by ${String(it.owner_sid ?? "?").slice(0, 8)} — ${owner.slice(0, 8)} cannot release it`,
			);
		if (!releaseObserved(it, owner, "owner-release"))
			die(`${id} claim changed — release refused; inspect before retrying`);
		// W418: an idle owner's WS subscribe is reaped — no unfinished item, no
		// inbox to push to (subscribe lifecycle rides the work graph)
		reapIfIdle(db(), owner);
		console.log(`${cyan("·")} ${dim(`${id} → READY`)}`);
	} else if (name === "start") {
		const id = pos[0];
		const as = flag("--as");
		const it = get(id ?? "");
		// transition guard: only claimed work starts; --as (when given) must be
		// the owner of record
		if (!["CLAIMED", "RUNNING"].includes(it.state as string))
			die(`${id} is ${it.state} — only CLAIMED/RUNNING work can start`);
		if (as && it.owner_sid !== resolveSidOf(db(), String(as)))
			die(
				`${id} is owned by ${String(it.owner_sid ?? "?").slice(0, 8)} — ${String(as).slice(0, 8)} cannot start it`,
			);
		if (it.state !== "RUNNING") setState(id, "RUNNING");
		console.log(`${green("▶")} ${id}`);
	} else if (name === "summary") {
		const id = pos[0];
		get(id ?? "");
		const record = completionRecord(db(), PROJECT, id);
		if (!record) die(`${id} has no verified permanent completion record`);
		console.log(flag("--json") ? JSON.stringify(record) : record.summary);
	} else if (name === "done") {
		const id = pos[0];
		const sha = flag("--sha");
		const as = flag("--as");
		if (!id) die("usage: done <id> [--as sid] --sha <sha>");
		const it = get(id);
		// transition + ownership guard: stray completions corrupt roll-up — only
		// CLAIMED/RUNNING work completes, and --as (when given) must be the
		// owner of record
		if (!["CLAIMED", "RUNNING"].includes(it.state as string))
			die(
				`${id} is ${it.state} — only CLAIMED/RUNNING work can be marked done`,
			);
		if (as && it.owner_sid !== resolveSidOf(db(), String(as)))
			die(
				`${id} is owned by ${String(it.owner_sid ?? "?").slice(0, 8)} — ${String(as).slice(0, 8)} cannot complete it`,
			);
		// W835 merge-ready precondition warning — never blocks (merge-on-done
		// owns the actual merge): observe the close's cwd; warn when the
		// branch is dirty/conflicted or has nothing new to merge. Unknown
		// (null) stays silent.
		const git = gitObservation(process.cwd());
		if (git.mergeReady === false)
			console.log(
				`${amber("●")} ${id} not merge-ready: ${mergeReadyWhy(git).join(", ")} — merge-on-done may strand this close`,
			);
		// W643 claim-token fence: present the token minted at take (--token,
		// KLH_CLAIM_TOKEN env, or the lane context) — the verdict runs inside
		// prepareCompletion so the durable lane-context channel is consulted
		// before anything is refused; the CAS UPDATE then closes the race.
		const tok = flag("--token") ?? process.env.KLH_CLAIM_TOKEN ?? null;
		let record: CompletionRecord | null;
		try {
			record = prepareCompletion(db(), {
				project: PROJECT,
				item: id,
				sid: String(it.owner_sid ?? as ?? "manual"),
				cwd: process.cwd(),
				sha,
				summary: flag("--summary"),
				token: tok,
			});
		} catch (error) {
			try {
				publishCompletionBlock(
					db(),
					{
						project: PROJECT,
						item: id,
						sid: String(it.owner_sid ?? as ?? "manual"),
						revision: it.claim_token_hash ?? null,
					},
					error,
				);
			} catch (publicationError) {
				console.error(
					`Completion blocker could not be published: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`,
				);
			}
			die(error instanceof Error ? error.message : String(error));
		}
		const tx = db().transaction(() => {
			if (record) persistCompletion(db(), record);
			// W643 CAS: the write lands ONLY on the exact claim the token opened
			// — state + owner + token-hash in the WHERE; a reclaim+re-take in
			// flight changes the hash → 0 rows → refused (never clobber).
			const cas = db()
				.query(
					"UPDATE work_items SET state = 'DONE', owner_sid = NULL, result_sha = ?, updated_at = ? WHERE project = ? AND id = ? AND state IN ('CLAIMED','RUNNING') AND owner_sid IS ? AND claim_token_hash IS ?",
				)
				.run(
					record?.commit_sha ?? sha ?? null,
					Date.now(),
					PROJECT,
					id,
					it.owner_sid ?? null,
					it.claim_token_hash ?? null,
				);
			if (cas.changes === 0)
				throw new Error(
					`${id} claim changed — stale writer refused (never clobber)`,
				);
			emit("work.done", id, {
				sha: record?.commit_sha ?? sha ?? "",
				verified: !!record,
				summary: record?.summary ?? null,
				// W909: the lane's effort level rides the done event (reporter EFFORT column)
				...doneEffortStamp(
					`${projectRootOf(PROJECT)}/.fleet`,
					String(it.owner_sid ?? as ?? ""),
				),
				// W1070: a closing session's self-reported spend (--spend, for
				// subagent-run work with no attributable ledger rows) rides the
				// done event — itemAttribution replays it as fallback attribution.
				...doneSpendStamp(parseDoneSpend(flag("--spend"))),
			});
			const unblocked = freeDependents(id);
			releaseClaim(
				(it.owner_sid as string) ?? "",
				it.scope as string | null,
				it.id as string,
			);
			// W782.4: a closed item drains its open budget decision.
			budgetFlagClear(db(), id);
			return unblocked;
		});
		const { freed, gated } = tx();
		rollUp(id);
		const p = it.parent_id;
		if (p) rollUp(p as string);
		console.log(
			`${green("✓")} ${cyan(id)} DONE${sha ? ` @${sha.slice(0, 8)}` : ""}`,
		);
		if (record) console.log(record.summary);
		if (freed.length)
			console.log(
				`${amber("▶")} startable now: ${cyan(freed.join(", "))} ${dim(`— unblocked by ${id}`)}`,
			);
		for (const g of gated)
			console.log(
				`${amber("●")} ${g.note} — ${cyan(g.id)} stays gated (W60 dep-merge gate)`,
			);
		// W52: retire the item's per-item worktree if it has one (clean → removed,
		// dirty → kept with a note; branch suspenders/<id> always survives)
		retireItemWorktree(id);
		// W418: the item is DONE — when the owner holds nothing else, their WS
		// inbox connection is reaped (subscribe lifecycle rides the work graph)
		reapIfIdle(db(), String(it.owner_sid ?? ""));
		// W249 merge-on-done: a dispatched lane's close fires the ladder NOW — a
		// detached flush waits out this lane's exit and merges seconds later,
		// instead of at the next watch cycle. Manual closes (no lane entry) skip.
		triggerMergeOnDone(projectRootOf(PROJECT), id);
		// Curation is advisory and runs after the durable completion transaction.
		// A cold or unavailable Kev cannot reopen or lose completed work.
		const verdict = await suggestKnowledge({
			kind: "work",
			title: String(it.title ?? id),
			text: record?.summary ?? String(it.description ?? ""),
			reference: id,
			timeoutMs: 1500,
		});
		try {
			recordKnowledgeSuggestion(db(), verdict, {
				sid: String(it.owner_sid ?? as ?? ""),
				project: PROJECT,
			});
		} catch {
			// Curation telemetry does not affect an already durable completion.
		}
		console.log(renderKnowledgeSuggestion(verdict));
		if (record) {
			const knowledge = await queueCompletionKnowledge(
				db(),
				record,
				String(it.title ?? id),
				verdict,
			);
			if (knowledge.status === "queued")
				console.log(`knowledge candidate queued #${knowledge.qid}`);
			else if (knowledge.status === "failed")
				console.error(
					`knowledge enqueue failed for ${id}; completion remains done`,
				);
		}
	} else if (name === "fail") {
		const id = pos[0];
		const note = flag("--note") ?? "";
		const as = flag("--as");
		db().transaction(() => {
			const it = get(id ?? "");
			// W1173: failing completed work is the first step of the unsupported
			// reactivation chain — refuse on the retained record, caller ignored.
			const reactivation = reactivationRefusal(db(), PROJECT, id ?? "");
			if (reactivation) die(reactivation);
			if (
				as &&
				(it.owner_sid !== resolveSidOf(db(), String(as)) ||
					!["CLAIMED", "RUNNING"].includes(it.state as string))
			)
				die(
					`${id} is not an unfinished claim owned by ${as} — failure refused`,
				);
			setState(id, "FAILED");
			emit("work.failed", id, { note });
		})();
		console.log(`${red("✗")} ${id} FAILED${note ? dim(` — ${note}`) : ""}`);
	} else if (name === "retry") {
		for (const id of idList(pos)) {
			const r = retryFailedItem(db(), PROJECT, id);
			if (!r.ok) die(r.error ?? "retry refused");
			emit("work.retried", id, { note: flag("--note") ?? "" });
			console.log(
				`${green("✓")} ${id} READY — stale claim released, launch budget reset`,
			);
		}
	} else if (name === "wait") {
		const id = pos[0] ?? "";
		const kind = flag("--kind") ?? "";
		const reason = flag("--reason") ?? "";
		let until: number | null;
		try {
			until = parseWaitUntil(flag("--until"));
		} catch (e) {
			die(String(e));
		}
		const r = waitForPrerequisite(db(), PROJECT, id, kind, reason, until);
		if (!r.ok) die(r.error ?? "wait refused");
		emit("work.waiting", id, {
			kind,
			reason,
			until: until ? new Date(until).toISOString() : "",
		});
		console.log(`${amber("◷")} ${id} WAITING — ${kind}: ${reason}`);
	} else if (name === "wake") {
		const id = pos[0] ?? "";
		const note = flag("--note") ?? "";
		const r = wakeAfterEvidence(
			db(),
			PROJECT,
			id,
			note,
			rest.includes("--force"),
		);
		if (!r.ok) die(r.error ?? "wake refused");
		emit("work.woken", id, { note });
		console.log(`${green("✓")} ${id} READY — prerequisite verified: ${note}`);
	} else if (name === "cancel") {
		// W182 — CANCELLED terminal state: close completely with a required
		// reason; claim + worktree released safely. Deliberately NOT in rollUp's
		// satisfied set — a cancelled child keeps its SHATTERED parent open until
		// reclaimed or superseded (same doctrine as FAILED).
		const id = pos[0];
		const note = flag("--note") ?? "";
		db().transaction(() => {
			const it = get(id ?? "");
			if (
				["DONE", "FAILED", "SUPERSEDED", "CANCELLED", "SHATTERED"].includes(
					it.state as string,
				)
			)
				die(`${id} is ${it.state} — already closed`);
			setState(id, "CANCELLED", null);
			releaseClaim(
				(it.owner_sid as string) ?? "",
				it.scope as string | null,
				it.id as string,
			);
			emit("work.cancelled", id, { note });
		})();
		console.log(`${dim("⊘")} ${id} CANCELLED${note ? dim(` — ${note}`) : ""}`);
		retireItemWorktree(id);
	} else if (name === "supersede") {
		const id = pos[0];
		const byId = flag("--by");
		if (!id || !byId) die("usage: supersede <id> --by <new-id>");
		const it = get(id);
		setState(id, "SUPERSEDED", null, byId);
		// superseding the last unsatisfied child closes its SHATTERED parent
		const p = it.parent_id;
		if (p) rollUp(p as string);
		// W879: lanes.ts auto-cancels OPEN decisions on work.superseded —
		// without this emit, linked NEED_DECISIONs hang OPEN (finding.w781)
		emit("work.superseded", id, { note: `superseded by ${byId}` });
		console.log(`${dim("■")} ${id} superseded by ${byId}`);
	} else if (name === "block") {
		const id = pos[0];
		const on = flag("--on");
		if (!id || !on) die("usage: block <id> --on <other-id>");
		get(on ?? "");
		if (reaches(on, id))
			die(`dependency cycle: ${on} already (transitively) depends on ${id}`);
		db()
			.query(
				"INSERT OR REPLACE INTO work_deps (project, work_id, depends_on) VALUES (?, ?, ?)",
			)
			.run(PROJECT, id, on);
		console.log(`${red("⚠")} ${id} blocked on ${on}`);
	} else if (name === "unblock") {
		const id = pos[0];
		const on = flag("--on");
		if (!id || !on) die("usage: unblock <id> --on <id2>");
		db()
			.query(
				"DELETE FROM work_deps WHERE project = ? AND work_id = ? AND depends_on = ?",
			)
			.run(PROJECT, id, on);
		console.log(`${cyan("·")} ${id} unblocked from ${on}`);
	} else if (name === "split") {
		// atomic shatter: parent → SHATTERED, children → READY; the splitter may
		// keep one child (--keep N, 1-based). Requires why_parallel so splits
		// answer "why is this parallel work at all".
		const id = pos[0];
		const titles = pos.slice(1);
		const reason = flag("--reason");
		const keep = Number(flag("--keep") ?? 0);
		const it = get(id);
		if (!["READY", "CLAIMED", "RUNNING"].includes(it.state as string))
			die(
				`${id} is ${it.state} — only READY/CLAIMED/RUNNING items can shatter`,
			);
		// split gate (W16): a fan-out beyond 2 children must reference a registered
		// plan item — the monitor flags drive-by splits, the gate refuses them.
		// 1-2 child splits stay free. Checked before the transaction: a refusal
		// must not leave partial state.
		const plan = flag("--plan");
		if (titles.length > 2) {
			if (!plan)
				die(
					`split fans out to ${titles.length} children — pass --plan <itemId> (the registered decomposition plan; 1-2 child splits stay free)`,
				);
			if (
				!db()
					.query("SELECT 1 FROM work_items WHERE project = ? AND id = ?")
					.get(PROJECT, plan)
			)
				die(
					`--plan ${plan} does not exist in this project — register the plan with \`work add\` first`,
				);
		}
		let rebound: string | null = null;
		const tx = db().transaction(() => {
			setState(id, "SHATTERED");
			let n = 0;
			for (const t of titles) {
				const cid = nextChildIdOf(db(), PROJECT, id);
				// children inherit the parent's capability requirement — a split must
				// not be able to launder away the dispatch constraint
				insertItem(
					cid,
					id,
					t,
					it.scope as string | null,
					Number(it.priority),
					it.owner_sid as string,
					reason,
					(it.requires as string | null) ?? null,
					null,
					it.effort as string | null,
					(it.evidence as string | null) ?? null,
					// W846: classification tags (fix/re-land) follow the parent — a
					// split must not be able to launder the defect lineage either
					it.tags as string | null,
				);
				if (++n === keep) {
					setState(cid, "CLAIMED", it.owner_sid as string);
					// W628: --keep transfers the parent's claim to this child — the
					// keeping lane's context follows the claim inside the SAME
					// transaction (a failed rewrite rolls the shatter back);
					// pre-fix splits left it bound to the SHATTERED parent and the
					// lane had to hand-edit its own context to close (W621.1).
					rebound = rebindKeptLaneContext(
						process.cwd(),
						projectRootOf(PROJECT),
						id,
						String(it.owner_sid ?? ""),
						cid,
					);
				}
			}
		});
		tx();
		emit("work.shattered", id, { children: String(titles.length), reason });
		const kids = db()
			.query(
				"SELECT * FROM work_items WHERE project = ? AND parent_id = ? ORDER BY id",
			)
			.all(PROJECT, id) as Item[];
		console.log(
			`${cyan("⊞")} ${cyan(id)} SHATTERED → ${titles.length} children${keep ? `, child ${keep} kept by ${dim(String(it.owner_sid ?? "").slice(0, 8))}` : ""}`,
		);
		console.log(kids.map(renderRow).join("\n"));
		// W628: say the rebind happened — the keeping lane reads this output
		if (rebound)
			console.log(
				`${dim("⇢")} lane context rebound to ${cyan(rebound)} (kept child)`,
			);
		// W515: decision objects for the minted children (recommend-only — split
		// never claims; the scorer suggests a lane per unkept child)
		const unkept = kids
			.filter((k) => k.state === "READY")
			.map((k) => String(k.id));
		if (unkept.length) {
			const sugg = planAllocation(
				db(),
				PROJECT,
				candidateLanes(db(), loadLaneRegistry(process.cwd()), PROJECT),
				{ items: unkept },
			);
			if (sugg.length)
				console.log(
					`${dim("⇢ suggested allocation:")}\n${renderAllocPlan(sugg)}`,
				);
		}
	} else if (name === "orphaned") {
		// CLAIMED/RUNNING claims with no live evidence — the SAME tri-state the
		// bulk reaper uses (W610: verdict !== alive lists dead AND unknown so the
		// operator inspects before per-item reclaim; alive lanes stay out)
		const item = flag("--item");
		const lanesBySid = claimantLanes(process.cwd());
		const rows = db()
			.query(
				`SELECT * FROM work_items WHERE project = ? AND state IN ('CLAIMED','RUNNING')${item ? " AND id = ?" : ""} ORDER BY id`,
			)
			.all(...(item ? [PROJECT, item] : [PROJECT])) as Item[];
		const out = rows.filter((r) => {
			const owner = String(r.owner_sid ?? "");
			return (
				probeClaim(db(), PROJECT, {
					id: String(r.id),
					owner,
					revision: Number(r.updated_at),
					lane: matchingClaimantLane(lanesBySid, owner, String(r.id)),
				}).verdict !== "alive"
			);
		});
		console.log(
			rest.includes("--json")
				? JSON.stringify(out)
				: out.length
					? out.map(renderRow).join("\n")
					: dim("(no orphans)"),
		);
	} else if (name === "lanes") {
		// THE lane-liveness surface (2026-10-05): one honest audit of
		// .fleet/lanes.json — process-identity + worktree cwd for local lanes,
		// transcript freshness for host/remote lanes (never permanent trust).
		// --json for dispatch-next/fleet-loop; text for humans.
		const readRegistry =
			flag("--fleet") && basename(String(flag("--fleet"))) !== ".fleet"
				? loadLaneRegistryFile
				: loadLaneRegistry;
		const entries = readRegistry<{
			sid: string;
			item: string;
			pid?: number;
			worktree?: string;
			host?: string;
			launchedAt?: number;
		}>(flag("--fleet") ?? process.cwd());

		// W835: live lanes with a worktree gain a git observation record
		// (lib/lane-git.ts — budgeted probes, per-field null-degradation);
		// merge-ready gate = !dirty && ahead>0 && conflicted==0.
		const audit = entries.map((l) => {
			const live = laneAlive(l);
			const git = live && l.worktree ? gitObservation(l.worktree) : null;
			return {
				sid: l.sid,
				item: l.item,
				live,
				host: l.host ?? null,
				worktree: l.worktree ?? null,
				git,
			};
		});
		if (flag("--json") !== undefined) {
			console.log(JSON.stringify(audit));
		} else {
			for (const a of audit)
				console.log(
					`${a.live ? "▶" : "×"} ${a.sid} ${a.item}${a.host ? ` @${a.host}` : ""}${gitBadge(a.git)}`,
				);
		}
	} else if (name === "allocate") {
		// W515: allocation scorer + decision-object rebalance (oh-my-codex lift);
		// scorer/planner details in lib/work-alloc.ts. PURE unless --apply, which
		// claims ONLY the assign kind through assignTask(). In NEITHER cmd set:
		// the plan needs sessions/events (no mirror fallback), and a pure plan
		// must not re-export the mirror ("reads never write").
		const readRegistry =
			flag("--fleet") && basename(String(flag("--fleet"))) !== ".fleet"
				? loadLaneRegistryFile
				: loadLaneRegistry;
		const entries = readRegistry<{
			sid: string;
			item: string;
			pid?: number;
			worktree?: string;
			host?: string;
			launchedAt?: number;
		}>(flag("--fleet") ?? process.cwd());
		const decisions = planAllocation(
			db(),
			PROJECT,
			candidateLanes(db(), entries, PROJECT),
			{ capacity: Number(flag("--capacity") ?? 1) },
		);
		if (flag("--json")) console.log(JSON.stringify(decisions));
		else
			console.log(
				renderAllocPlan(decisions) || dim("(nothing READY to allocate)"),
			);
		if (flag("--apply")) {
			const { applied, skipped } = applyAllocations(db(), PROJECT, decisions);
			for (const s of skipped)
				console.log(`${amber("●")} ${s.item} skipped: ${s.why}`);
			console.log(`${green("✓")} ${applied.length} item(s) allocated`);
			exportMirror(db(), PROJECT);
		}
	} else if (name === "extend") {
		// W610 claim-extend (Hermes lift): a claimant facing a known-long op holds
		// `reclaim all` off its item. The lease lives in facts
		// (reclaim.extend.<project>.<id>), re-armable, capped at 24h; reclaim-all
		// honors it via probeClaim, the strike counter stays cleared while held.
		const id = pos[0];
		const ms = parseDuration(String(flag("--for") ?? ""));
		if (ms === null) die("extend: --for must be <n>s|m|h (e.g. 45m), 1s..24h");
		const it = get(id ?? "");
		if (!["CLAIMED", "RUNNING"].includes(it.state as string))
			die(`${id} is ${it.state} — only CLAIMED/RUNNING work can be extended`);
		const as = flag("--as");
		if (as && it.owner_sid !== resolveSidOf(db(), String(as)))
			die(
				`${id} is owned by ${String(it.owner_sid ?? "?").slice(0, 8)} — ${String(as).slice(0, 8)} cannot extend it`,
			);
		const by = as
			? resolveSidOf(db(), String(as))
			: resolveSidOf(db(), String(it.owner_sid ?? ""));
		setReclaimHold(db(), PROJECT, String(id), Date.now() + ms, by);
		emit("work.lease-extended", String(id), { forMs: String(ms), by });
		console.log(
			`${green("⏸")} ${cyan(id)} reclaim held ${flag("--for")} — until ${new Date(Date.now() + ms).toISOString()}`,
		);
	} else if (name === "reclaim") {
		// W339: `work reclaim all` — the supported bulk operation. Reclaims every
		// CLAIMED/RUNNING item whose claimant transcript is dead (the `orphaned`
		// listing). Capsule law preserved: this CAN strand uncommitted lane state;
		// each reclaim is listed for audit and `work reclaim <id>` stays the
		// careful per-item path.
		if (pos[0] === "all") {
			if (
				flag("--expect-owner") ||
				flag("--expect-updated-at") ||
				rest.includes("--json")
			)
				die("expected claim/JSON requires a single item");
			// W610 liveness parity: the SAME tri-state the lanes verb trusts —
			// registry process identity + claimant transcript + governor heartbeat
			// (sessions.hb) — with unknown never releasing, an extend lease as a
			// pause, and death needing 3 consecutive dead passes (fact-counted).
			// W376: the pass itself is lib/reclaim-all.ts — the ONE core the
			// fleet-loop reclaim sweep runs per cycle (no second implementation).
			const rows = reclaimAll(db(), PROJECT, process.cwd());
			let n = 0;
			for (const x of rows) {
				if (x.action === "held") console.log(`${dim(x.id)} held — ${x.why}`);
				else if (x.action === "changed")
					console.log(`${dim(x.id)} claim changed — skipped`);
				else {
					console.log(
						`${cyan("·")} ${x.id} reclaimed → READY (was ${x.was}) — ${x.why}`,
					);
					n++;
				}
			}
			console.log(
				n === 0
					? dim("(nothing reclaimable — claims are alive, unknown or leased)")
					: `${cyan("·")} ${n} orphaned item(s) reclaimed`,
			);
		} else {
			const id = pos[0];
			const it = get(id ?? "");
			if (!["CLAIMED", "RUNNING", "ORPHANED"].includes(it.state as string))
				die(
					`${id} is ${it.state} — only CLAIMED/RUNNING/ORPHANED can be reclaimed`,
				);
			// W831 kill-path double-check: the manual reclaim shares the bulk
			// pass's liveness truth. A verifiably-live claimant refuses (ghost
			// claims make two writers); --reason crash demands death evidence;
			// --force is the explicit operator decision (board force leg).
			const rawReason = flag("--reason");
			if (rawReason && !parseReclaimReason(rawReason))
				die(`invalid --reason ${rawReason} — user | crash`);
			const reclaimReason = parseReclaimReason(rawReason) ?? "user";
			const verdict = probeClaim(db(), PROJECT, {
				id,
				owner: String(it.owner_sid ?? ""),
				revision: Number(it.updated_at),
				lane: matchingClaimantLane(
					claimantLanes(process.cwd()),
					String(it.owner_sid ?? ""),
					id,
				),
			}).verdict;
			const gate = reclaimGateDecision(
				verdict,
				reclaimReason,
				!!flag("--force"),
			);
			if (!gate.ok) die(`${id} reclaim refused — ${gate.why}`);
			const expectedOwner = flag("--expect-owner");
			if (expectedOwner && it.owner_sid !== resolveSidOf(db(), expectedOwner))
				die(`${id} owner changed — reclaim refused`);
			const revision = flag("--expect-updated-at");
			if (
				revision &&
				(!Number.isSafeInteger(Number(revision)) ||
					Number(revision) !== it.updated_at)
			)
				die(`${id} revision changed — reclaim refused`);
			const crashGuard = () =>
				automaticRecoveryCheck({
					repo: process.cwd(),
					store: db(),
					project: PROJECT,
					id,
					owner: String(it.owner_sid ?? ""),
					revision: Number(it.updated_at),
					lane: claimantLanes(process.cwd()).get(String(it.owner_sid ?? "")),
				}).ok;
			if (reclaimReason === "crash" && !crashGuard())
				die(
					`${id} automatic recovery refused — pause, wait, or death unverified`,
				);
			if (
				!releaseObserved(
					it,
					"operator-reclaim",
					"operator-reclaim",
					reclaimReason === "crash" ? crashGuard : undefined,
				)
			)
				die(`${id} claim changed — reclaim refused; inspect before retrying`);
			console.log(
				rest.includes("--json")
					? JSON.stringify({
							project: PROJECT,
							id,
							previousOwner: it.owner_sid,
							previousUpdatedAt: it.updated_at,
							released: true,
						})
					: `${cyan("·")} ${id} reclaimed → READY`,
			);
		}
	} else if (name === "migrate-ledger") {
		runMigrateLedger(db(), PROJECT, pos[0], {
			die,
			nextRootId,
			insertItem: (id, parentId, title, by) =>
				insertItem(id, parentId, title, null, 0, by, null),
			emit: (kind, id) => emit(kind, id),
		});
	}
};

// verb-kit dispatch (W651): the kit resolves the verb, intercepts --help,
// parses and validates BEFORE dispatchVerb runs — parse errors never touch
// state. Mirror re-export rides the kit's after-hook (mutations only).
await runCli({
	prog: "work",
	about: "work — hierarchical shatterable work graph.",
	verbs: VERBS,
	onVerb: (name) => {
		VERB = name;
	},
	dispatch: dispatchVerb,
	after: (name) => {
		if (MUTATING_CMDS.has(name)) exportMirror(db(), PROJECT);
	},
});
