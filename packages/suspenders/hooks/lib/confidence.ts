// hooks/lib/confidence.ts — W953 fleet confidence doctrine.
//
// The 0.1–1.0 scale is a POLICY TRUST BAND scale, NOT a probability: a
// stamp grades the SOURCE of a quality-bearing row (who set it, what was
// reviewed, how independently) — it never claims measured correctness.
// Reading 0.8 as "80% correct" is a doctrine violation.
//
// SCHEMA: every quality-bearing row (coord facts, consult_kb, decant-ingest
// knowledge rows, knowledge store candidates, bench verdicts) carries
// confidence: {value, setter, ts, evidence, prior} — append-only history,
// never overwrite: a raise cites what it raised (the prior stamp), and the
// chain is sha256-hashed so tampering is detectable.
//
// ChatGPT adversarial verdict #47598 (owner GO, all binding):
// - 0.8 requires an INDEPENDENT reviewer — different model family than the
//   producer — citing exact checked evidence; same-family self-review caps
//   at 0.7 (the stamp is DENIED, re-stamp ≤ 0.7 stands).
// - 0.9 requires DIVERSE independent checks: the stamp chain must already
//   hold ≥2 distinct setter families with pairwise-distinct evidence —
//   the same unverified text sent to two families is not consensus.
// - 1.0 = human-reviewed (a human vouches; not a claim of infallibility).
// - Stamp events land for EVERY row incl. low bands — the 0.4→0.9 upgrade
//   path is the attack vector: self-upgrades are denied structurally and
//   every stamp is identity-bound (by_sid) + hashed (tamper-evidence).
// - First failure mode guarded: self-stamp, self-review, recycled evidence.
// - Addendum 2 (owner): a stamp may carry a verdict lifecycle — fresh |
//   stale | confirmed | retracted | superseded | contradicted.
//   superseded / contradicted REQUIRE ref: a link to the superseding row
//   (superseded) or the contradicting row/evidence (contradicted) —
//   validation refuses those stamps without ref, so contradiction chains
//   stay walkable ("what replaced me / what disproved me").
import { createHash } from "node:crypto";
// W955 convergence: the verdict enum lives in confidence-verdict.ts (its
// ref rules + append-only ledger ride it); this module consumes + re-exports
import { STAMP_VERDICTS } from "./confidence-verdict.ts";

export const CONFIDENCE_MIN = 0.1;
export const CONFIDENCE_MAX = 1.0;

// W142 consumer law, graded: below 0.6 a row is a CANDIDATE — never
// auto-trusted; surfaces MAY filter by min-confidence; the W142
// verified-only law grades instead of gates.
export const CANDIDATE_THRESHOLD = 0.6;

// Policy trust bands — ascending source-tier, matched by strict max so
// every value in [0.1, 1.0] lands in exactly one band (mid-band values
// display at the rung whose RULES they passed: 0.85 → model-reviewed,
// 0.95 → multi-model; 1.0 alone is human-reviewed). glyph is single-width —
// board/fact-list render it next to the raw value; the glyph is the
// at-a-glance grade, the number is the tie-breaker inside a band.
export interface ConfidenceBand {
	name: string;
	// first band with max > value owns the value (1.0 routes to the last)
	max: number;
	glyph: string;
	label: string;
}

export const CONFIDENCE_BANDS: ConfidenceBand[] = [
	{
		name: "machine-raw",
		max: 0.4,
		glyph: "·",
		label: "machine-raw unreviewed",
	},
	{
		name: "machine-derived",
		max: 0.6,
		glyph: "○",
		label: "machine-derived schema/heuristic-validated",
	},
	{
		name: "single-model",
		max: 0.8,
		glyph: "◔",
		label: "single model pass",
	},
	{
		name: "model-reviewed",
		max: 0.9,
		glyph: "◑",
		label: "model-reviewed confirmation (independent family)",
	},
	{
		name: "multi-model",
		max: 1.0,
		glyph: "◕",
		label: "multi-model consensus / dual independent models",
	},
	{ name: "human-reviewed", max: 1.0, glyph: "●", label: "human-reviewed" },
];

// Threshold matrix (verdict #5): the minimum band a surface trusts per use.
// board/search = show-all (grades displayed, nothing hidden); policy
// activation stays human-gated (no numeric shortcut — a human stamps 1.0).
export const CONFIDENCE_THRESHOLDS = {
	"board/search": 0,
	"lane-brief": 0.6,
	consult: 0.8,
	benchmark: 0.8,
	policy: 1.0,
} as const;

export type ConfidenceSurface = keyof typeof CONFIDENCE_THRESHOLDS;

// The cited stamp this one changed.
export interface StampPrior {
	value: number;
	setter: string;
	ts: number;
	evidence: string | null;
	// the prior stamp's own chain hash — evidence+prior ride the new hash
	hash: string | null;
}

export interface ConfidenceStamp {
	// 0.1–1.0 policy trust band (see header: not a probability)
	value: number;
	// human | model:<model-id-or-executor> | mechanical:<tool>
	setter: string;
	// ms epoch of the stamping event
	ts: number;
	// what the setter actually checked — file:line | URL | sha | consult:<id>
	evidence: string | null;
	// the stamp this one changed — a raise cites what it raised; null on first
	prior: StampPrior | null;
	// lifecycle verdict (addendum 2): fresh | stale | confirmed | retracted |
	// superseded | contradicted — absent = fresh
	verdict?: string;
	// REQUIRED for superseded (the superseding row) and contradicted (the
	// contradicting row/evidence) — validation refuses without it
	ref?: string;
	// sha256 over value|setter|ts|evidence|ref|verdict|prior-hash — the
	// tamper-evidence chain (writable append alone is not tamper-proof)
	hash: string;
}

// W955 convergence: one enum, zero drift — the lifecycle verdict set is
// DEFINED in confidence-verdict.ts (with its ref rules + ledger) and
// re-exported here for schema face
export { STAMP_VERDICTS };

// History ledger DDL shared by governor.db and knowledge.db — one source.
// The row's confidence_stamp JSON mirrors the LATEST stamp; this table is
// the append-only ledger (every stamp event, incl. low bands).
export const CONFIDENCE_HISTORY_DDL = `CREATE TABLE IF NOT EXISTS confidence_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	tbl TEXT NOT NULL,
	row_key TEXT NOT NULL,
	value REAL NOT NULL,
	setter TEXT NOT NULL,
	evidence TEXT,
	verdict TEXT,
	ref TEXT,
	prior REAL,
	prior_setter TEXT,
	prior_ts INTEGER,
	by_sid TEXT
)`;

export const CONFIDENCE_HISTORY_INDEX_DDL =
	"CREATE INDEX IF NOT EXISTS confidence_history_row ON confidence_history (tbl, row_key)";

// ─── setter grammar ──────────────────────────────────────────────────────────

export type SetterKind = "human" | "model" | "mechanical";

export function parseSetterKind(setter: string): SetterKind | null {
	if (setter === "human") return "human";
	if (setter.startsWith("model:")) {
		if (setter.length > "model:".length) return "model";
		return null;
	}
	if (setter.startsWith("mechanical:")) {
		if (setter.length > "mechanical:".length) return "mechanical";
		return null;
	}
	return null;
}

// Review independence family: for model setters the family is the leading
// vendor segment of the model/executor id (claude-sonnet-5 → "claude",
// glm-5.3-flash → "glm", gpt-5.2-codex → "gpt"); human is its own family;
// every mechanical tool is its own family (tools never vouch for each
// other — a heuristic pass cannot independent-review a model's work).
export function familyOf(setter: string): string {
	const kind = parseSetterKind(setter);
	if (kind === "human") return "human";
	if (kind === "model") {
		const id = setter.slice("model:".length);
		const dash = id.indexOf("-");
		return dash > 0 ? id.slice(0, dash) : id;
	}
	if (kind === "mechanical") return setter; // whole tool id = its family
	return `unknown:${setter}`;
}

// ─── validation + stamp construction ────────────────────────────────────────

export function validateConfidence(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(
			`confidence value must be a finite number, got ${JSON.stringify(value)}`,
		);
	// a small float-drift window (value arrives from JSON/DB REAL columns)
	const v = Math.round(value * 100) / 100;
	if (v < CONFIDENCE_MIN || v > CONFIDENCE_MAX)
		throw new Error(
			`confidence value ${v} out of policy range [${CONFIDENCE_MIN}, ${CONFIDENCE_MAX}]`,
		);
	return v;
}

function hashStampFields(
	value: number,
	setter: string,
	ts: number,
	evidence: string | null,
	ref: string | null,
	verdict: string | undefined,
	priorHash: string | null,
): string {
	return createHash("sha256")
		.update(
			`${value}|${setter}|${ts}|${evidence ?? ""}|${ref ?? ""}|${verdict ?? ""}|${priorHash ?? ""}`,
		)
		.digest("hex");
}

export interface StampInput {
	value: number;
	setter: string;
	// what the setter checked — required on raises, on 0.8 and on 0.9
	evidence?: string | null;
	// lifecycle verdict (addendum 2); absent = fresh
	verdict?: string;
	// the walk link — REQUIRED when verdict is superseded/contradicted
	ref?: string | null;
	// the row's current stamp — null on first stamp; cited on every change
	prior?: ConfidenceStamp | null;
	// the row's full stamp chain (newest-last) — consulted for the 0.9
	// diverse-checks rule; absent = just prior
	chain?: ConfidenceStamp[] | null;
	// test seam — real callers omit (Date.now())
	now?: number;
}

export class ConfidenceError extends Error {}

// makeStamp validates a stamp against the doctrine and returns the stamped
// record (hash chained to its prior). Throws ConfidenceError with the exact
// doctrine rule named — callers surface it, never swallow.
export function makeStamp(input: StampInput): ConfidenceStamp {
	const value = validateConfidence(input.value);
	const setter = input.setter;
	if (!parseSetterKind(setter))
		throw new ConfidenceError(
			`setter "${setter}" violates the grammar — human | model:<model-id> | mechanical:<tool>`,
		);
	const verdict = input.verdict?.trim() || undefined;
	if (verdict && !(STAMP_VERDICTS as readonly string[]).includes(verdict))
		throw new ConfidenceError(
			`verdict "${verdict}" not in the lifecycle set: ${STAMP_VERDICTS.join(", ")}`,
		);
	const ref = input.ref?.trim() ? input.ref.trim() : null;
	if ((verdict === "superseded" || verdict === "contradicted") && !ref)
		throw new ConfidenceError(
			`verdict ${verdict} requires ref — a link to the ${
				verdict === "superseded" ? "SUPERSEDING" : "CONTRADICTING"
			} row/evidence`,
		);
	const evidence = input.evidence?.trim() ? input.evidence.trim() : null;
	const ts = input.now ?? Date.now();
	const prior = input.prior ?? null;
	// 1.0 = human-reviewed — only a human setter may claim it
	if (value >= 1.0 && parseSetterKind(setter) !== "human")
		throw new ConfidenceError(
			"1.0 is human-reviewed — only setter=human may stamp it",
		);
	// raises cite what they checked: new evidence, never recycled. A FIRST
	// stamp (no prior) is not a raise — mechanical ingest rows land without
	// evidence; the stamp itself is the logged event.
	const isRaise = prior != null && value > prior.value;
	if (isRaise && !evidence)
		throw new ConfidenceError(
			`raise to ${value} requires evidence — what did the setter check?`,
		);
	if (isRaise && prior?.evidence && evidence && evidence === prior.evidence)
		throw new ConfidenceError(
			"evidence ancestry: a raise must cite NEW evidence, not the prior stamp's ref",
		);
	// 0.8 = model-reviewed confirmation — an INDEPENDENT reviewer (different
	// family than the producer) citing exact checked evidence. Same-family
	// self-review caps at 0.7: the stamp is denied, ≤0.7 re-stamp stands.
	if (value >= 0.8 && value < 0.9) {
		if (parseSetterKind(setter) !== "model")
			throw new ConfidenceError(
				"0.8 is a model-reviewed confirmation — setter must be model:<id>",
			);
		if (!evidence)
			throw new ConfidenceError(
				"0.8 requires evidence — the reviewing model must cite what it checked",
			);
		if (prior && familyOf(setter) === familyOf(prior.setter))
			throw new ConfidenceError(
				`self-upgrade denied: ${setter} is same family as the prior setter ${prior.setter} — same-family review caps at 0.7`,
			);
	}
	// 0.9 = multi-model consensus / dual independent models — the chain must
	// ALREADY hold ≥2 distinct families with pairwise-distinct evidence
	// (the same unverified text to two families is not consensus)
	if (value >= 0.9 && value < 1.0) {
		if (parseSetterKind(setter) !== "model")
			throw new ConfidenceError(
				"0.9 is multi-model consensus — setter must be model:<id>",
			);
		if (!evidence)
			throw new ConfidenceError(
				"0.9 requires evidence — consensus cites what was checked",
			);
		// the diverse check counts the consensus stamp ITSELF: the chain plus
		// this setter's own evidence must span ≥2 families / ≥2 evidence refs
		// (e.g. family-A 0.8 with evidence E1 → family-B 0.9 with NEW evidence E2)
		const chain = [
			...(input.chain ?? []),
			...(prior ? [prior] : []),
			{ setter, evidence },
		];
		const checked = chain.filter(
			(s) =>
				typeof s?.setter === "string" &&
				parseSetterKind(s.setter) === "model" &&
				typeof s.evidence === "string" &&
				s.evidence.length > 0,
		);
		const families = new Set(checked.map((s) => familyOf(s.setter)));
		const evidences = new Set(checked.map((s) => s.evidence));
		if (checked.length < 2 || families.size < 2 || evidences.size < 2)
			throw new ConfidenceError(
				"0.9 requires diverse independent checks — the chain must hold ≥2 model stamps with distinct families AND distinct evidence",
			);
	}
	const priorHash = prior?.hash ?? null;
	return {
		value,
		setter,
		ts,
		evidence,
		prior: prior
			? {
					value: prior.value,
					setter: prior.setter,
					ts: prior.ts,
					evidence: prior.evidence,
					hash: prior.hash,
				}
			: null,
		...(verdict ? { verdict } : {}),
		...(ref ? { ref } : {}),
		hash: hashStampFields(value, setter, ts, evidence, ref, verdict, priorHash),
	};
}

// ─── consumers ───────────────────────────────────────────────────────────────

// W142 graded law: below the threshold a row is a candidate — never
// auto-trusted, surface it as a lead.
export function isCandidate(value: number): boolean {
	return validateConfidence(value) < CANDIDATE_THRESHOLD;
}

export function meetsThreshold(
	surface: ConfidenceSurface,
	value: number,
): boolean {
	return validateConfidence(value) >= CONFIDENCE_THRESHOLDS[surface];
}

export function bandOf(value: number): ConfidenceBand {
	const v = validateConfidence(value);
	if (v >= CONFIDENCE_MAX) return CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1];
	for (const b of CONFIDENCE_BANDS) if (v < b.max) return b;
	// validateConfidence guarantees v ≤ 1.0; the last band maxes at 1.0
	return CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1];
}

export function glyphFor(value: number): string {
	return bandOf(value).glyph;
}

export function bandLabel(value: number): string {
	return bandOf(value).name;
}

// one-line render for fact get/list, search cards, board cells
export function renderStamp(stamp: ConfidenceStamp): string {
	const b = bandOf(stamp.value);
	const ev = stamp.evidence ? ` · ev ${stamp.evidence}` : "";
	const vd =
		stamp.verdict && stamp.verdict !== "fresh"
			? ` · ${stamp.verdict}${stamp.ref ? ` → ${stamp.ref}` : ""}`
			: "";
	return `${b.glyph} ${stamp.value} ${b.name} · set by ${stamp.setter}${ev}${vd}`;
}

// read-side tolerance: parse a stored stamp JSON, null when absent/corrupt
// (an unreadable stamp renders as ungraded — never a fabricated grade)
export function parseStamp(
	json: string | null | undefined,
): ConfidenceStamp | null {
	if (!json) return null;
	try {
		const o: unknown = JSON.parse(json);
		if (!o || typeof o !== "object") return null;
		const s = o as Record<string, unknown>;
		if (
			typeof s.value !== "number" ||
			typeof s.setter !== "string" ||
			typeof s.ts !== "number" ||
			typeof s.hash !== "string"
		)
			return null;
		return s as unknown as ConfidenceStamp;
	} catch {
		return null;
	}
}
