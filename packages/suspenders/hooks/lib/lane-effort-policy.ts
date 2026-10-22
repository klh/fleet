// hooks/lib/lane-effort-policy.ts — W1140: lane effort pinned by verification
// need, the POLICY in machine conf (routing-policy-style), never code.
// Sources (read 2026-10-22): claude.dev/blog/spending-your-effort +
// SlopCodeBench: effort helps edgecase-heavy/verification work (security
// 64→87%, hardware 34→75% low→max) but does NOT rescue wrong approaches
// (wrong-reading failures ROSE 25→47 at max) and a detailed spec converges
// effort levels — so the brief front-loads spec completeness, dispatch
// classifies items by tags/title, and unmatched items ride the two-stage
// default (implement low → verify high) which captures most max-effort
// gains at a fraction of the tokens.
//
// Chain (routing-policy pattern): SUSPENDERS_EFFORT_POLICY env pin →
// ~/.claude/local-llm/lane-effort-policy.json → .yaml → built-in defaults.
// Fail-soft: unreadable/invalid conf = built-in defaults + a surfaced
// warning — never a dispatch blocker. Budgets are brief-surfaced baselines,
// not caps.
import { YAML } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { effortForPriority } from "./lane-effort.ts";
import { openStore, projectIdentity } from "./govdb.ts";

export type EffortWord = "low" | "medium" | "high";
export const EFFORT_WORDS: readonly EffortWord[] = ["low", "medium", "high"];

/** One classify rule — first match wins. */
export interface EffortRule {
	when: {
		tags_any?: string[];
		title_re?: string;
		desc_re?: string;
	};
	effort: EffortWord;
}

export interface EffortPolicy {
	version: 1;
	/** unmatched items: two-stage (implement → verify) or a single pin */
	default: "two-stage" | "single";
	/** single-mode pin for unmatched items */
	single_effort: EffortWord;
	classify: EffortRule[];
	/** the two-stage pipeline: implement-lane pin + verify-stage pin */
	two_stage: { implement: EffortWord; verify: EffortWord };
	/** token baselines per effort (brief-surfaced, not caps) */
	budgets: Partial<Record<EffortWord, number>>;
}

/** Built-in defaults = the W1140 policy itself: verification-shaped → high,
 *  research → medium, CRUD/rulebook → low. Machine conf overrides any of
 *  it — code never carries the operator's tuning. */
export const EFFORT_POLICY_DEFAULTS: EffortPolicy = {
	version: 1,
	default: "two-stage",
	single_effort: "medium",
	classify: [
		{
			when: {
				tags_any: ["verification", "security", "edgecase", "hardware"],
			},
			effort: "high",
		},
		{
			when: {
				title_re:
					"\\b(verif|audit|security|edge[- ]?case|claim[- ]?check|hardware|reject|malformed|valid)\\w*",
			},
			effort: "high",
		},
		{
			when: {
				title_re: "\\b(research|explor|investigat|spike|compare|benchmark)\\b",
			},
			effort: "medium",
		},
		{
			when: { tags_any: ["research", "exploration"] },
			effort: "medium",
		},
		{
			when: { tags_any: ["crud", "rulebook", "mechanical"] },
			effort: "low",
		},
	],
	two_stage: { implement: "low", verify: "high" },
	budgets: { low: 100_000, medium: 200_000, high: 300_000 },
};

export class EffortPolicyError extends Error {}

const isEffortWord = (v: unknown): v is EffortWord =>
	typeof v === "string" && (EFFORT_WORDS as readonly string[]).includes(v);

/** Parse + validate a policy document (YAML or JSON). Throws
 *  EffortPolicyError naming the offending key. */
export const parseEffortPolicy = (text: string): EffortPolicy => {
	let doc: Record<string, unknown>;
	try {
		doc = (
			text.trimStart().startsWith("{") ? JSON.parse(text) : YAML.parse(text)
		) as Record<string, unknown>;
	} catch (e) {
		throw new EffortPolicyError(
			`effort policy parse failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc))
		throw new EffortPolicyError("effort policy must be a mapping");
	if (doc.version !== undefined && doc.version !== 1)
		throw new EffortPolicyError(
			`unsupported effort policy version: ${String(doc.version)} — version: 1 only`,
		);
	const d = doc.default;
	const single = doc.single_effort;
	if (d !== undefined && d !== "two-stage" && d !== "single")
		throw new EffortPolicyError(`default: must be "two-stage" or "single"`);
	if (single !== undefined && !isEffortWord(single))
		throw new EffortPolicyError("single_effort: must be low|medium|high");
	return {
		version: 1,
		default: (d as "two-stage" | "single") ?? "two-stage",
		single_effort: (single as EffortWord) ?? "medium",
		classify: parseRules(doc.classify),
		two_stage: parseTwoStage(doc.two_stage),
		budgets: parseBudgets(doc.budgets),
	};
};

const parseRules = (raw: unknown): EffortRule[] => {
	if (raw === undefined) return [];
	if (!Array.isArray(raw))
		throw new EffortPolicyError("classify: must be a list of rules");
	return raw.map((r, i) => parseRule(r, i));
};

const parseRule = (r: unknown, i: number): EffortRule => {
	const rule = (r ?? {}) as Record<string, unknown>;
	const when = (rule.when ?? {}) as Record<string, unknown>;
	if (typeof when !== "object" || Array.isArray(when))
		throw new EffortPolicyError(`classify[${i}].when: must be a mapping`);
	if (!when.tags_any && !when.title_re && !when.desc_re)
		throw new EffortPolicyError(
			`classify[${i}].when: needs tags_any, title_re or desc_re`,
		);
	if (when.tags_any !== undefined) {
		const tags = when.tags_any as unknown;
		if (
			!Array.isArray(tags) ||
			!tags.length ||
			!tags.every((t) => typeof t === "string" && t)
		)
			throw new EffortPolicyError(
				`classify[${i}].when.tags_any: must be a non-empty string list`,
			);
	}
	for (const k of ["title_re", "desc_re"] as const) {
		const v = when[k];
		if (v === undefined) continue;
		if (typeof v !== "string")
			throw new EffortPolicyError(`classify[${i}].when.${k}: must be a string`);
		try {
			// compiled case-insensitive — JS RegExp has no (?i) inline flag
			new RegExp(v, "i");
		} catch {
			throw new EffortPolicyError(
				`classify[${i}].when.${k}: invalid regex: ${v}`,
			);
		}
	}
	if (!isEffortWord(rule.effort))
		throw new EffortPolicyError(
			`classify[${i}].effort: must be low|medium|high`,
		);
	return {
		when: {
			...(Array.isArray(when.tags_any)
				? { tags_any: (when.tags_any as string[]).map((t) => t.toLowerCase()) }
				: {}),
			...(typeof when.title_re === "string" ? { title_re: when.title_re } : {}),
			...(typeof when.desc_re === "string" ? { desc_re: when.desc_re } : {}),
		},
		effort: rule.effort,
	};
};

const parseTwoStage = (
	raw: unknown,
): { implement: EffortWord; verify: EffortWord } => {
	if (raw === undefined) return { implement: "low", verify: "high" };
	const ts = raw as Record<string, unknown>;
	if (typeof ts !== "object" || Array.isArray(ts))
		throw new EffortPolicyError("two_stage: must be a mapping");
	if (!isEffortWord(ts.implement) || !isEffortWord(ts.verify))
		throw new EffortPolicyError(
			"two_stage.implement/verify: must be low|medium|high",
		);
	return { implement: ts.implement, verify: ts.verify };
};

const parseBudgets = (raw: unknown): Partial<Record<EffortWord, number>> => {
	if (raw === undefined) return {};
	const b = (raw ?? {}) as Record<string, unknown>;
	if (typeof b !== "object" || Array.isArray(b))
		throw new EffortPolicyError("budgets: must be a mapping");
	const out: EffortPolicy["budgets"] = {};
	for (const [k, v] of Object.entries(b)) {
		if (!isEffortWord(k))
			throw new EffortPolicyError(`budgets.${k}: unknown effort word`);
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
			throw new EffortPolicyError(`budgets.${k}: must be a number >= 0`);
		out[k as EffortWord] = v;
	}
	return out;
};

export type EffortPolicySource = "env" | "runtime" | "default";

export interface LoadedEffortPolicy {
	policy: EffortPolicy;
	source: EffortPolicySource;
	path: string | null;
	/** set when a conf file exists but failed to load — surfaced, never silent */
	warning: string | null;
}

const RUNTIME_BASE = (home: string): string =>
	`${home}/.claude/local-llm/lane-effort-policy`;

/** One conf file → LoadedEffortPolicy; a bad file falls back to the built-in
 *  defaults with the parse error surfaced in warning (never silent). */
const readConf = (
	path: string,
	source: EffortPolicySource,
): LoadedEffortPolicy => {
	try {
		return {
			policy: parseEffortPolicy(readFileSync(path, "utf8")),
			source,
			path,
			warning: null,
		};
	} catch (e) {
		return {
			policy: EFFORT_POLICY_DEFAULTS,
			source: "default",
			path,
			warning: `${path}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
};

/** W1140 chain (routing-policy pattern): SUSPENDERS_EFFORT_POLICY env pin →
 *  runtime json → runtime yaml → built-in defaults. An EMPTY env var counts
 *  as unset (`??` alone would pass ""). */
export const loadEffortPolicy = (opts?: {
	env?: NodeJS.ProcessEnv;
	home?: string;
}): LoadedEffortPolicy => {
	const env = opts?.env ?? process.env;
	const home = opts?.home ?? env.HOME ?? "";
	const pinned = env.SUSPENDERS_EFFORT_POLICY || undefined;
	const cands = [
		{ path: pinned ?? "", source: "env" as const },
		{ path: `${RUNTIME_BASE(home)}.json`, source: "runtime" as const },
		{ path: `${RUNTIME_BASE(home)}.yaml`, source: "runtime" as const },
	];
	for (const c of cands) {
		if (c.path && existsSync(c.path)) return readConf(c.path, c.source);
	}
	return {
		policy: EFFORT_POLICY_DEFAULTS,
		source: "default",
		path: null,
		warning: null,
	};
};

/** The item-side classification inputs: the work row's comma-set tags,
 *  title and description. */
export interface EffortItemInput {
	tags?: string | null;
	title?: string | null;
	desc?: string | null;
}

const REGEX_CACHE = new Map<string, RegExp | null>();
const compiled = (re: string): RegExp | null => {
	if (!REGEX_CACHE.has(re))
		REGEX_CACHE.set(
			re,
			(() => {
				try {
					return new RegExp(re, "i");
				} catch {
					return null; // parse-time validation already refused these
				}
			})(),
		);
	return REGEX_CACHE.get(re) ?? null;
};

/** First-match-wins rule scan; matched=null means no rule fired. */
export const classifyItem = (
	policy: EffortPolicy,
	item: EffortItemInput,
): { effort: EffortWord | null; matched: string | null } => {
	const tags = (item.tags ?? "")
		.split(",")
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	for (const rule of policy.classify) {
		if (rule.when.tags_any?.some((t) => tags.includes(t.toLowerCase()))) {
			return {
				effort: rule.effort,
				matched: `tags_any:${rule.when.tags_any.join(",")}`,
			};
		}
		for (const [reKey, field] of [
			["title_re", item.title],
			["desc_re", item.desc],
		] as const) {
			const pattern = rule.when[reKey];
			const re = pattern ? compiled(pattern) : null;
			if (re && field && re.test(field))
				return { effort: rule.effort, matched: reKey };
		}
	}
	return { effort: null, matched: null };
};

export interface EffortDecision {
	effort: EffortWord;
	/** the verify-stage pin when the two-stage default applies; else null */
	verifyEffort: EffortWord | null;
	/** the matched rule summary ("tags_any:verification") or null (default) */
	matched: string | null;
	/** token baseline for the pin (policy.budgets), null when unset */
	budget: number | null;
}

/** W1140 decision: a matched rule pins one stage; the two-stage default
 *  pins implement + names the verify-stage effort. */
export const effortDecision = (
	policy: EffortPolicy,
	item: EffortItemInput,
): EffortDecision => {
	const { effort: ruleEffort, matched } = classifyItem(policy, item);
	if (ruleEffort)
		return {
			effort: ruleEffort,
			verifyEffort: null,
			matched,
			budget: policy.budgets[ruleEffort] ?? null,
		};
	if (policy.default === "single")
		return {
			effort: policy.single_effort,
			verifyEffort: null,
			matched: null,
			budget: policy.budgets[policy.single_effort] ?? null,
		};
	return {
		effort: policy.two_stage.implement,
		verifyEffort: policy.two_stage.verify,
		matched: null,
		budget: policy.budgets[policy.two_stage.implement] ?? null,
	};
};

const fmtTokens = (n: number | null): string =>
	n === null ? "n/a" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

/** The brief's one-line policy verdict: the lane reads WHY it got its pin,
 *  what the verification stage rides at, and the token baseline. */
export const effortPolicyLine = (d: EffortDecision): string => {
	const why = d.matched
		? `classified ${d.matched}`
		: d.verifyEffort
			? `two-stage default: this lane implements; verification rides a verify lane pinned ${d.verifyEffort}`
			: `single-pin default`;
	return `EFFORT POLICY: pinned ${d.effort} (${why}) — budget baseline ${fmtTokens(d.budget)} tokens.`;
};

/** The loosely-typed store handle (openStore's GovernorStore and bun:sqlite
 *  Database both satisfy it — work.ts passes the same shape). */
type RowStore = {
	query: (sql: string) => { get: (...params: unknown[]) => unknown };
};

/** The work row's classification inputs; null = no row or unreadable graph
 *  (fail-soft — the W923 priority fallback answers instead). */
export const effortItemFromStore = (
	store: RowStore,
	project: string,
	item: string,
): EffortItemInput | null => {
	try {
		const r = store
			.query(
				"SELECT tags, title, description FROM work_items WHERE project=? AND id=?",
			)
			.get(project, item) as {
			tags?: string | null;
			title?: string | null;
			description?: string | null;
		} | null;
		return r
			? {
					tags: r.tags ?? null,
					title: r.title ?? null,
					desc: r.description ?? null,
				}
			: null;
	} catch {
		return null;
	}
};

/** W1140 dispatch pin: row → policy classification → the effort word the
 *  lane settings carry. env SUSPENDERS_LANE_EFFORT still overrides it
 *  downstream (lane-settings env wins). Row/graph unavailable → the W923
 *  priority fallback. */
export const dispatchLaneEffort = (
	store: RowStore,
	project: string,
	item: string,
): EffortWord => {
	try {
		const row = effortItemFromStore(store, project, item);
		if (!row) return effortForPriority(null);
		return effortDecision(loadEffortPolicy().policy, row).effort;
	} catch {
		return effortForPriority(null);
	}
};

/** The brief's policy line for a graph item; null when the row/graph is
 *  unavailable (tests, dry preview against no graph) — legacy briefs stay
 *  byte-identical. Fail-soft like fleetReport: never blocks a dispatch. */
export const laneEffortBriefLine = (
	repo: string,
	item: string,
	opts?: {
		store?: RowStore;
		env?: NodeJS.ProcessEnv;
		home?: string;
	},
): string | null => {
	try {
		const store = opts?.store ?? (openStore() as unknown as RowStore);
		const row = effortItemFromStore(store, projectIdentity(repo), item);
		if (!row) return null;
		const { policy } = loadEffortPolicy({ env: opts?.env, home: opts?.home });
		return effortPolicyLine(effortDecision(policy, row));
	} catch {
		return null;
	}
};
