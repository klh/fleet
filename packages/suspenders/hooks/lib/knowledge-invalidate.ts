// hooks/lib/knowledge-invalidate.ts — W1228 knowledge invalidation: when a
// change lands (work.done / merge), flag the knowledge it touches as
// stale-for-review instead of trusting it blind. Mechanical, zero LLM:
// a row is flagged when its provenance (source_ref file, repo-relative area)
// or its text names a touched path. Facts (governor.db) flag when the fact
// text names a touched path. Pure planner + injected-handle apply, the
// knowledge-curate.ts doctrine — the callers own the IO.
import type { Database } from "bun:sqlite";
import { extractDocPaths } from "./knowledge.ts";
import { makeStamp, parseStamp } from "./confidence.ts";

// the promotion stamp — mechanical:work-landing lands in the machine-derived
// band (0.6): a landed, done-gated implementation is machine evidence, never
// a model review (doctrine caps mechanical < 0.8), and 0.6 is exactly the
// lane-brief recall threshold (CONFIDENCE_THRESHOLDS.lane-brief = 0.6).
export const LANDING_PROMOTE_VALUE = 0.6;
export const LANDING_PROMOTE_SETTER = "mechanical:work-landing";

// repo-relative parent dirs of the touched files — the exact-equality set
// an area column may name (areas are dir-shaped when they are paths at all;
// work-graph/gates-style labels never collide with them).
export function touchedAreas(files: string[]): string[] {
	const out = new Set<string>();
	for (const f of files) {
		const i = f.lastIndexOf("/");
		if (i > 0) out.add(f.slice(0, i));
	}
	return [...out];
}

// path tokens a row's text carries (extractDocPaths = the W112 pointer
// extractor: repo-relative, extension-anchored, lookalike-rejecting)
export function textPaths(text: string | null | undefined): string[] {
	if (!text) return [];
	return extractDocPaths(text);
}

// ─── pure planner ────────────────────────────────────────────────────────────

export interface KnowledgeCandidate {
	id: number;
	source_ref: string | null;
	area: string | null;
	fact: string | null;
}

export interface FactCandidate {
	key: string;
	value: string | null;
}

export interface TouchedChange {
	files: string[];
	item?: string | null;
	sha?: string | null;
	via: "work.done" | "merge";
}

export interface InvalidationMatch {
	id: number;
	// which mechanical rule fired and the path that fired it
	why: string;
	// facts are keyed, not id'd — the apply loop targets by key
	key?: string;
}

export interface InvalidationPlan {
	knowledge: InvalidationMatch[];
	facts: InvalidationMatch[];
}

export function planKnowledgeInvalidation(
	knowledge: KnowledgeCandidate[],
	facts: FactCandidate[],
	touched: TouchedChange,
): InvalidationPlan {
	const files = new Set(touched.files);
	const areas = new Set(touchedAreas(touched.files));
	const plan: InvalidationPlan = { knowledge: [], facts: [] };
	for (const k of knowledge) {
		const ref = (k.source_ref ?? "").trim().split(/\s+/)[0] || null;
		const why =
			(ref && files.has(ref) ? `source_ref ${ref}` : null) ??
			(k.area && areas.has(k.area) ? `area ${k.area}` : null) ??
			((k.fact ? textPaths(k.fact) : []).find((p) => files.has(p))
				? `text ${textPaths(k.fact).find((p) => files.has(p))}`
				: null);
		if (why) plan.knowledge.push({ id: k.id, why });
	}
	for (const f of facts) {
		const hit = textPaths(f.value).find((p) => files.has(p));
		if (hit) plan.facts.push({ id: 0, why: `text ${hit}`, key: f.key });
	}
	return plan;
}

// ─── apply: stale markers on both stores, one bus event ──────────────────────

export interface InvalidationHandles {
	gov: Database;
	kb: Database;
}

export const STALE_NOTE_TAG = "stale-for-review";

export function applyKnowledgeInvalidation(
	handles: InvalidationHandles,
	plan: InvalidationPlan,
	meta: TouchedChange,
): { knowledge: number; facts: number } {
	const now = Date.now();
	const reason = `${meta.via} ${meta.item ?? "?"}${
		meta.sha ? ` @ ${meta.sha.slice(0, 12)}` : ""
	} touched`;
	for (const m of plan.knowledge) {
		// append-only contributors note (curate doctrine: a flag is not
		// freshness — no updated_at bump); vanished rows skip honestly
		const row = handles.kb
			.query("SELECT contributors FROM knowledge WHERE id = ?")
			.get(m.id) as { contributors: string | null } | undefined;
		if (!row) continue;
		let list: unknown[] = [];
		try {
			list = row.contributors ? JSON.parse(row.contributors) : [];
		} catch {}
		list.push({ sid: STALE_NOTE_TAG, ts: now, what: `${reason} ${m.why}` });
		handles.kb
			.query(
				"UPDATE knowledge SET contributors = ?, stale_at = ?, stale_reason = ? WHERE id = ?",
			)
			.run(JSON.stringify(list), now, `${reason} (${m.why})`, m.id);
	}
	for (const m of plan.facts) {
		handles.gov
			.query("UPDATE facts SET stale_at = ?, stale_reason = ? WHERE key = ?")
			.run(now, `${reason} (${m.why})`, m.key ?? "");
	}
	handles.gov
		.query(
			"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'knowledge.stale', 'knowledge', ?, NULL)",
		)
		.run(
			now,
			meta.via === "merge" ? "fleet-loop" : "work-knowledge",
			JSON.stringify({
				item: meta.item ?? null,
				sha: meta.sha ?? null,
				via: meta.via,
				knowledge: plan.knowledge.map((m) => m.id),
				facts: plan.facts.map((m) => m.key ?? null),
			}),
		);
	return { knowledge: plan.knowledge.length, facts: plan.facts.length };
}

// W1228 promotion rule: branch-local findings prove on landing.

// facts keyed finding.<id> — case-insensitive, dot-anchored: finding.w1228
// and finding.W1228.2 match item W1228; finding.w12280 never does
export function isFindingKey(key: string, item: string): boolean {
	const k = key.toLowerCase();
	const i = item.toLowerCase();
	return k === `finding.${i}` || k.startsWith(`finding.${i}.`);
}

export function promoteLandedFindings(
	gov: Database,
	item: string,
	sha: string | null | undefined,
): { promoted: string[] } {
	const rows = gov
		.query("SELECT key, confidence_stamp FROM facts WHERE key LIKE 'finding.%'")
		.all() as { key: string; confidence_stamp: string | null }[];
	const evidence = `${item} landed @ ${sha ?? "?"}`;
	const promoted: string[] = [];
	for (const r of rows) {
		if (!isFindingKey(r.key, item)) continue;
		const prior = parseStamp(r.confidence_stamp);
		if (prior && prior.value >= LANDING_PROMOTE_VALUE) continue;
		const stamp = makeStamp({
			value: LANDING_PROMOTE_VALUE,
			setter: LANDING_PROMOTE_SETTER,
			evidence,
			verdict: "confirmed",
			prior,
		});
		const put =
			"UPDATE facts SET confidence = ?, confidence_stamp = ? WHERE key = ?";
		gov.query(put).run(stamp.value, JSON.stringify(stamp), r.key);
		const led =
			"INSERT INTO confidence_history (ts, tbl, row_key, value, setter, evidence, verdict, ref, prior, prior_setter, prior_ts, by_sid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
		gov
			.query(led)
			.run(
				stamp.ts,
				"facts",
				r.key,
				stamp.value,
				stamp.setter,
				stamp.evidence,
				stamp.verdict ?? null,
				stamp.ref ?? null,
				prior ? prior.value : null,
				prior?.setter ?? null,
				prior?.ts ?? null,
				"fleet-loop",
			);
		promoted.push(r.key);
	}
	return { promoted };
}

// git diff faces the landing site: base..sha when a claim baseline exists,
// the commit's own files otherwise. Fail-open: null on git trouble — a
// landing never breaks over invalidation.
function touchedFiles(
	repo: string,
	base: string | null | undefined,
	sha: string,
): string[] | null {
	const argv = base
		? ["git", "-C", repo, "diff", "--name-only", `${base}..${sha}`]
		: ["git", "-C", repo, "show", "--name-only", "--pretty=format:", sha];
	const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0) return null;
	return new TextDecoder()
		.decode(p.stdout)
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

export interface LandingInvalidationResult {
	knowledge: number;
	facts: number;
	promoted: string[];
}

// one call per landing site: diff the touched set, flag matching knowledge
// and facts stale, promote the item's findings. Handles are injected (W92:
// only store owners open the DBs) — knowledge-ports.ts withKnowledgeDb is
// the consumer face for the kb side.
export function invalidateForLanding(opts: {
	repo: string;
	item: string;
	sha: string | null | undefined;
	base?: string | null;
	files?: string[];
	via: "work.done" | "merge";
	gov: Database;
	kb: Database;
}): LandingInvalidationResult | null {
	const files = opts.files ?? touchedFiles(opts.repo, opts.base, opts.sha);
	if (!files?.length) return null;
	const gov = opts.gov;
	const kb = opts.kb;
	const meta = { files, item: opts.item, sha: opts.sha ?? null, via: opts.via };
	const knowledge = kb
		.query(
			"SELECT id, source_ref, area, fact FROM knowledge WHERE state NOT IN ('retired', 'graveyard')",
		)
		.all() as KnowledgeCandidate[];
	const facts = gov
		.query(
			"SELECT key, value FROM facts WHERE key NOT LIKE 'lane.%' AND key NOT LIKE 'activity.tp.%' AND key NOT LIKE 'usage.%'",
		)
		.all() as FactCandidate[];
	const plan = planKnowledgeInvalidation(knowledge, facts, meta);
	const counts = applyKnowledgeInvalidation({ gov, kb }, plan, meta);
	const { promoted } = promoteLandedFindings(gov, opts.item, opts.sha);
	return { knowledge: counts.knowledge, facts: counts.facts, promoted };
}
