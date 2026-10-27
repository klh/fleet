// bench/review-guardrail.ts — W1477 review human time + the revert/incident
// guardrail ('Keeping review useful',
// docs/paas-engineering-standard-2026-10-23.md): measure human time
// (approvals per landing, time waiting on a person) with revert and incident
// rates as the guardrail — if they rise, tighten the tiers. Pure logic
// first, thin IO tails last; pilot-measure.ts folds the result into
// pilot-summary.json `review`. The tier action is a SEAM: until the owner
// writes thresholds into the machine conf it reports `unconfigured` and
// stays disabled — this file never invents a threshold.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { DecisionRow, TaskRow } from "./pilot-measure.ts";

export type ReviewTier = "low" | "medium" | "high";
const TIERS: readonly ReviewTier[] = ["low", "medium", "high"];

/** Bus kinds the review reader keeps: landings + W1476's C156 rows. */
export const REVIEW_KINDS: ReadonlySet<string> = new Set([
	"work.landed",
	"review.incident",
]);

/** Default machine conf — operator policy, never committed (config-over-code). */
export const GUARDRAIL_CONF = "~/.config/klh/review-guardrail.json";

/** decisions.ts serves at most this many rows (OPEN first, newest first). */
const DECISIONS_CAP = 200;

const CONF_KEYS: ReadonlySet<string> = new Set([
	"revert_rate_max",
	"incident_rate_max",
	"min_landings",
	"decision",
]);

// C156 (agreed with W1476, whose review-evals.ts holds the suspenders copy;
// belt cannot import suspenders — W1249 — so this is the local twin, kernel
// promotion is the follow-up). A revert-of-revert is a re-land and gets NO
// row: git <2.43 writes `Revert "Revert …`, git >=2.43 `Reapply "…"` (whose
// body still says "This reverts commit").
const RELAND_SUBJECT = /^(?:Revert "Revert |Reapply ")/;
const REVERT_SUBJECT = /^Revert "/;
const REVERTS_BODY = /This reverts commit ([0-9a-f]{40})/;
const ITEM_ID = /\b(W\d+(?:\.\d+)*)\b/;
const INCIDENT_TAG = "incident";

/** One /api/events row (W451 cursor feed, payload parsed). */
export interface BoardEvent {
	id: number;
	ts: number;
	kind: string;
	payload: unknown;
}

/** One verified landing — work.landed (recordLanding, W1130). */
export interface Landing {
	work: string;
	commit: string;
	ts: number;
}

/** One commit record (`git log %H %ct %s %b`). */
export interface CommitRecord {
	commit: string;
	ts: number;
	subject: string;
	body: string;
}

/** C156 class revert: the revert commit, what it reverts, the item it undid. */
export interface RevertRow {
	commit: string;
	reverts: string | null;
	work: string | null;
	subject: string;
	ts: number;
}

/** C156 class incident: the ROOT incident-tagged item, counted once. */
export interface IncidentRow {
	incident: string;
	work: string;
	commit: string;
	ts: number;
}

/** Owner thresholds: rates in [0,1], null = metric unguarded. */
export interface GuardrailConfig {
	revert_rate_max: number | null;
	incident_rate_max: number | null;
	min_landings: number;
	decision: string | null;
}

/** A loaded conf: absent (config + error null), refused (error) or set. */
export interface GuardrailConf {
	path: string;
	config: GuardrailConfig | null;
	error: string | null;
}

export interface GuardrailRates {
	landings: number;
	revert_rate: number | null;
	incident_rate: number | null;
}

export interface Breach {
	metric: "revert_rate" | "incident_rate";
	value: number;
	max: number;
}

export interface GuardrailVerdict {
	state:
		| "unconfigured"
		| "invalid"
		| "insufficient-sample"
		| "within"
		| "tripped";
	action: "none" | "tighten-tiers";
	tiers: Record<ReviewTier, ReviewTier>;
	breaches: Breach[];
	decision: string | null;
	note: string;
}

export interface ReviewSummary {
	landings: number;
	landed_items: number;
	coverage_from: string | null;
	approvals: {
		total: number;
		per_landing: number | null;
		human_touched_items: number;
	};
	wait: {
		min_total: number;
		min_per_landing: number | null;
		min_max: number | null;
	};
	reverts: { count: number; rate: number | null; rows: RevertRow[] };
	incidents: { count: number; rate: number | null; rows: IncidentRow[] };
	guardrail: GuardrailVerdict;
	gaps: string[];
}

type ItemRef = Pick<TaskRow, "project" | "id" | "parent_id" | "tag">;

export interface ReviewInput {
	project: string;
	sinceMs: number;
	untilMs: number;
	events: BoardEvent[];
	decisions: DecisionRow[];
	tasks: ItemRef[];
	commits: CommitRecord[];
	conf: GuardrailConf;
}

/** C156 classifier: `{reverts}` for a revert (the body's 40-hex, null on a
 * subject-only match); null for anything else, re-lands included. */
export function classifyRevert(
	subject: string,
	body: string,
): { reverts: string | null } | null {
	if (RELAND_SUBJECT.test(subject)) return null;
	const hex = REVERTS_BODY.exec(body)?.[1] ?? null;
	if (hex) return { reverts: hex };
	return REVERT_SUBJECT.test(subject) ? { reverts: null } : null;
}

/** `git log --format=%H%x1f%ct%x1f%s%x1f%b%x1e` output → commit records. */
export function parseGitRecords(out: string): CommitRecord[] {
	const rows: CommitRecord[] = [];
	for (const rec of out.split("\x1e")) {
		const [commit, ct, subject, body] = rec.replace(/^\s+/, "").split("\x1f");
		if (!commit || subject === undefined) continue;
		rows.push({ commit, ts: Number(ct) * 1000, subject, body: body ?? "" });
	}
	return rows;
}

/** Revert rows off commit records — classified, deduped by commit. */
export function revertRows(records: CommitRecord[]): RevertRow[] {
	const rows = new Map<string, RevertRow>();
	for (const r of records) {
		const hit = classifyRevert(r.subject, r.body);
		if (!hit || rows.has(r.commit)) continue;
		rows.set(r.commit, {
			commit: r.commit,
			reverts: hit.reverts,
			work: ITEM_ID.exec(r.subject)?.[1] ?? null,
			subject: r.subject,
			ts: r.ts,
		});
	}
	return [...rows.values()];
}

function text(v: unknown): string | null {
	return typeof v === "string" && v !== "" ? v : null;
}

function fields(e: BoardEvent): Record<string, unknown> {
	return e.payload && typeof e.payload === "object"
		? (e.payload as Record<string, unknown>)
		: {};
}

/** work.landed rows of one project, deduped per (work, commit) — the
 * recordLanding idempotency key. Unwindowed: buildReview windows. */
export function landingsFrom(events: BoardEvent[], project: string): Landing[] {
	const rows = new Map<string, Landing>();
	for (const e of events) {
		const p = fields(e);
		const work = text(p.work);
		const commit = text(p.commit);
		if (e.kind !== "work.landed" || p.project !== project || !work || !commit)
			continue;
		const key = `${work}\0${commit}`;
		if (!rows.has(key)) rows.set(key, { work, commit, ts: e.ts });
	}
	return [...rows.values()];
}

/** Comma-set membership on the tags column (W846 `work add --tag`). */
function hasTag(raw: string | null | undefined, tag: string): boolean {
	return (raw ?? "").split(",").some((t) => t.trim() === tag);
}

/** The ROOT incident of a landed item: the item must carry the tag; climb
 * parents while they carry it too (split children inherit tags — C156 counts
 * roots, never commits). Cycle-safe. */
export function incidentRoot(
	id: string,
	byId: Map<string, ItemRef>,
): string | null {
	let cur = byId.get(id);
	if (!cur || !hasTag(cur.tag, INCIDENT_TAG)) return null;
	const seen = new Set<string>();
	while (cur.parent_id && !seen.has(cur.id)) {
		seen.add(cur.id);
		const up = byId.get(cur.parent_id);
		if (!up || !hasTag(up.tag, INCIDENT_TAG)) break;
		cur = up;
	}
	return cur.id;
}

/** One row per landed incident root (the first landing wins). */
export function incidentRows(
	landings: Landing[],
	tasks: ItemRef[],
	project: string,
): IncidentRow[] {
	const byId = new Map(
		tasks.filter((t) => t.project === project).map((t) => [t.id, t] as const),
	);
	const rows = new Map<string, IncidentRow>();
	for (const l of landings) {
		const root = incidentRoot(l.work, byId);
		if (root && !rows.has(root))
			rows.set(root, {
				incident: root,
				work: l.work,
				commit: l.commit,
				ts: l.ts,
			});
	}
	return [...rows.values()];
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/** n per landing, 4 dp; null when nothing landed (no rate, not zero). */
export function perLanding(n: number, landings: number): number | null {
	return landings > 0 ? Math.round((n / landings) * 10_000) / 10_000 : null;
}

/** Settled NEED_DECISION answers on landed items, per item — the approval
 * proxy (answer count) + time waiting on a person (answered − asked).
 * CANCELLED forks are superseded work, never an approval. */
export function humanByItem(
	items: ReadonlySet<string>,
	decisions: DecisionRow[],
	project: string,
): Map<string, { approvals: number; wait_min: number }> {
	const by = new Map<string, { approvals: number; wait_min: number }>();
	for (const d of decisions) {
		if (d.answered_ts == null || d.task_id == null || d.project !== project)
			continue;
		if (d.state === "CANCELLED" || !items.has(d.task_id)) continue;
		const cur = by.get(d.task_id) ?? { approvals: 0, wait_min: 0 };
		cur.approvals += 1;
		cur.wait_min = round1(
			cur.wait_min + (d.answered_ts - d.created_ts) / 60_000,
		);
		by.set(d.task_id, cur);
	}
	return by;
}

function rateMax(v: unknown, key: string): number | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
		throw new Error(`${key} must be a rate in [0,1] or null`);
	return v;
}

/** Validate the owner's guardrail JSON. Unknown keys refuse — a typo must not
 * read as a silently unguarded metric. */
export function parseGuardrailConfig(raw: unknown): GuardrailConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("not a JSON object");
	const o = raw as Record<string, unknown>;
	for (const k of Object.keys(o))
		if (!CONF_KEYS.has(k)) throw new Error(`unknown key ${k}`);
	const min = o.min_landings ?? 1;
	if (typeof min !== "number" || !Number.isInteger(min) || min < 1)
		throw new Error("min_landings must be an integer >= 1");
	if (o.decision != null && typeof o.decision !== "string")
		throw new Error("decision must be a string");
	return {
		revert_rate_max: rateMax(o.revert_rate_max, "revert_rate_max"),
		incident_rate_max: rateMax(o.incident_rate_max, "incident_rate_max"),
		min_landings: min,
		decision: text(o.decision),
	};
}

/** `shift` steps up the tier ladder, clamped at high. */
export function tightenTier(tier: ReviewTier, shift = 1): ReviewTier {
	const at = TIERS.indexOf(tier) + shift;
	return TIERS[Math.min(TIERS.length - 1, Math.max(0, at))];
}

function tierMap(shift: number): Record<ReviewTier, ReviewTier> {
	return {
		low: tightenTier("low", shift),
		medium: tightenTier("medium", shift),
		high: tightenTier("high", shift),
	};
}

/** The guardrail verdict. Disabled (action none) until the owner sets a
 * threshold; a rate strictly ABOVE its max trips one tier step up. */
export function evaluateGuardrail(
	rates: GuardrailRates,
	conf: GuardrailConf,
): GuardrailVerdict {
	const c = conf.config;
	const idle = {
		action: "none" as const,
		tiers: tierMap(0),
		breaches: [],
		decision: c?.decision ?? null,
	};
	if (conf.error)
		return {
			...idle,
			state: "invalid",
			note: `guardrail conf ${conf.path} refused (${conf.error}) — tier action disabled`,
		};
	if (!c || (c.revert_rate_max === null && c.incident_rate_max === null))
		return {
			...idle,
			state: "unconfigured",
			note: `no owner threshold in ${conf.path} — tier action disabled, measuring only`,
		};
	// zero landings never reads as "within", whatever min_landings says
	if (rates.landings < Math.max(1, c.min_landings))
		return {
			...idle,
			state: "insufficient-sample",
			note: `${rates.landings} landings < min_landings ${c.min_landings} — no verdict`,
		};
	const breaches: Breach[] = [];
	if (
		c.revert_rate_max !== null &&
		rates.revert_rate !== null &&
		rates.revert_rate > c.revert_rate_max
	)
		breaches.push({
			metric: "revert_rate",
			value: rates.revert_rate,
			max: c.revert_rate_max,
		});
	if (
		c.incident_rate_max !== null &&
		rates.incident_rate !== null &&
		rates.incident_rate > c.incident_rate_max
	)
		breaches.push({
			metric: "incident_rate",
			value: rates.incident_rate,
			max: c.incident_rate_max,
		});
	if (breaches.length === 0)
		return {
			...idle,
			state: "within",
			note: "rates at or under the owner thresholds",
		};
	return {
		...idle,
		state: "tripped",
		action: "tighten-tiers",
		tiers: tierMap(1),
		breaches,
		note: "rate above the owner threshold — review every change one tier up",
	};
}

/** W1476's review.incident rows (C156) fold in, deduped against the git scan
 * by commit (reverts) and by root (incidents). A landing with reverts banks
 * class revert only, so the incident root rides either class. */
function foldIncidentEvents(
	events: BoardEvent[],
	project: string,
	inside: (ts: number) => boolean,
	reverts: Map<string, RevertRow>,
	incidents: Map<string, IncidentRow>,
): void {
	for (const e of events) {
		const p = fields(e);
		const commit = text(p.commit);
		const root = text(p.incident);
		if (e.kind !== "review.incident" || p.project !== project) continue;
		if (!commit || !inside(e.ts)) continue;
		if (p.class === "revert" && !reverts.has(commit))
			reverts.set(commit, {
				commit,
				reverts: text(p.reverts),
				work: text(p.work),
				subject: text(p.subject) ?? "",
				ts: e.ts,
			});
		if (root && !incidents.has(root))
			incidents.set(root, {
				incident: root,
				work: text(p.work) ?? root,
				commit,
				ts: e.ts,
			});
	}
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function reviewGaps(input: ReviewInput, first: number | null): string[] {
	const gaps = [
		"approvals: no human-approval connector exists (how-to-review.md W1130 note) — settled NEED_DECISION answers on landed items are the proxy; W1130 machine receipts never count",
		"incidents: incident-tagged items that landed (C156, shared with W1476) — untagged or never-landed incidents are invisible",
		"reverts: git revert commits on the integration line (C156 markers) — undo commits without them are invisible",
	];
	if (first === null)
		gaps.push(
			"landings: no work.landed for this project — rates null, no verdict",
		);
	else if (first > input.sinceMs)
		gaps.push(
			`landings: work.landed starts ${iso(first)} — rates cover from there, not the window start`,
		);
	if (input.decisions.length >= DECISIONS_CAP) {
		const floor = input.decisions.reduce(
			(m, d) => Math.min(m, d.created_ts),
			Number.POSITIVE_INFINITY,
		);
		if (floor > input.sinceMs)
			gaps.push(
				`decisions: feed capped at ${DECISIONS_CAP} rows, floor ${iso(floor)} — earlier asks drop out, approvals/wait undercount`,
			);
	}
	return gaps;
}

/** Window review: landings × human answers × reverts × incidents → rates and
 * the guardrail verdict. Rates span only what work.landed covers. */
export function buildReview(input: ReviewInput): ReviewSummary {
	const { project, untilMs } = input;
	const all = landingsFrom(input.events, project);
	const first = all.reduce<number | null>(
		(m, l) => (m === null || l.ts < m ? l.ts : m),
		null,
	);
	// a revert before the first recorded landing has no denominator
	const from = first === null ? untilMs + 1 : Math.max(input.sinceMs, first);
	const inside = (ts: number) => ts >= from && ts <= untilMs;
	const landings = all.filter((l) => inside(l.ts));
	const items = new Set(landings.map((l) => l.work));
	const human = [...humanByItem(items, input.decisions, project).values()];
	const approvals = human.reduce((s, h) => s + h.approvals, 0);
	const waitTotal = round1(human.reduce((s, h) => s + h.wait_min, 0));
	const reverts = new Map(
		revertRows(input.commits)
			.filter((r) => inside(r.ts))
			.map((r) => [r.commit, r] as const),
	);
	const incidents = new Map(
		incidentRows(landings, input.tasks, project).map(
			(r) => [r.incident, r] as const,
		),
	);
	foldIncidentEvents(input.events, project, inside, reverts, incidents);
	const n = landings.length;
	const rates = {
		landings: n,
		revert_rate: perLanding(reverts.size, n),
		incident_rate: perLanding(incidents.size, n),
	};
	return {
		landings: n,
		landed_items: items.size,
		coverage_from: first === null ? null : iso(first),
		approvals: {
			total: approvals,
			per_landing: perLanding(approvals, n),
			human_touched_items: human.length,
		},
		wait: {
			min_total: waitTotal,
			min_per_landing: n > 0 ? round1(waitTotal / n) : null,
			min_max:
				human.length > 0 ? Math.max(...human.map((h) => h.wait_min)) : null,
		},
		reverts: {
			count: reverts.size,
			rate: rates.revert_rate,
			rows: [...reverts.values()],
		},
		incidents: {
			count: incidents.size,
			rate: rates.incident_rate,
			rows: [...incidents.values()],
		},
		guardrail: evaluateGuardrail(rates, input.conf),
		gaps: reviewGaps(input, first),
	};
}

// --- IO tails (thin; logic above is pure) ---

/** Drain the board bus (W451 cursor, 300/page) keeping only `kinds` — page
 * by page, the whole bus never sits in memory. Stops past `untilMs`. */
export async function fetchEvents(
	board: string,
	kinds: ReadonlySet<string>,
	untilMs: number,
): Promise<BoardEvent[]> {
	const kept: BoardEvent[] = [];
	let cursor = 0;
	let more = true;
	while (more) {
		const res = await fetch(`${board}/api/events?since=${cursor}&limit=300`, {
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`board ${board} -> ${res.status}`);
		const body = (await res.json()) as {
			events?: BoardEvent[];
			cursor?: number;
		};
		const page = body.events ?? [];
		for (const e of page) if (kinds.has(e.kind)) kept.push(e);
		const next = body.cursor ?? cursor;
		more = next > cursor && (page.at(-1)?.ts ?? 0) <= untilMs;
		cursor = next;
	}
	return kept;
}

function gitLines(repo: string, args: string[]): string[] {
	const out = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	return (out.stdout ?? "").split("\n").filter(Boolean);
}

/** C156 landing rule (W1476 revertLandings): a named revert counts only when
 * its target sat on the integration line before the revert landed, i.e. in
 * the pre-merge head of the first-parent commit that brought it in. Exit 1
 * from `merge-base --is-ancestor` = branch-internal undo, dropped; an
 * unknown object keeps the revert. --first-parent --ancestry-path misses
 * non-tip branch commits, hence the intersection with the first-parent set. */
function landedRevert(
	repo: string,
	firstParent: ReadonlySet<string>,
	commit: string,
	target: string,
): boolean {
	const landing = firstParent.has(commit)
		? commit
		: gitLines(repo, ["rev-list", "--ancestry-path", `${commit}..HEAD`])
				.filter((c) => firstParent.has(c))
				.at(-1);
	if (!landing) return true;
	const check = spawnSync(
		"git",
		["-C", repo, "merge-base", "--is-ancestor", target, `${landing}^1`],
		{ encoding: "utf8" },
	);
	return check.status !== 1;
}

/** Revert candidates on the integration line (HEAD of the common dir — the
 * gitAcceptance convention): git --grep pre-filters, classifyRevert decides,
 * landedRevert drops branch-internal undos. */
export function gitRevertCommits(
	repo: string,
	since: string,
	until: string,
): CommitRecord[] {
	const log = spawnSync(
		"git",
		[
			"-C",
			repo,
			"log",
			"--since",
			since,
			"--until",
			until,
			'--grep=^Revert "',
			"--grep=This reverts commit",
			"--format=%H%x1f%ct%x1f%s%x1f%b%x1e",
		],
		{ encoding: "utf8" },
	);
	const firstParent = new Set(
		gitLines(repo, ["rev-list", "--first-parent", "HEAD"]),
	);
	return parseGitRecords(log.stdout ?? "").filter((r) => {
		const target = classifyRevert(r.subject, r.body)?.reverts;
		return !target || landedRevert(repo, firstParent, r.commit, target);
	});
}

/** Machine conf → GuardrailConf: absent = unconfigured, broken = invalid. */
export function loadGuardrailConf(path: string): GuardrailConf {
	if (!existsSync(path)) return { path, config: null, error: null };
	try {
		const config = parseGuardrailConfig(JSON.parse(readFileSync(path, "utf8")));
		return { path, config, error: null };
	} catch (e) {
		return {
			path,
			config: null,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}
