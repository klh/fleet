// hooks/lib/race-policy.ts — W1143: the race-vs-single dispatch pattern,
// switched per item class by MACHINE CONF (config-over-code law) — never
// code. A race = N concurrent cheap-tier attempts at temp>0, then a
// fresh-context blind pairwise tournament + skeptic verify on the strong
// tier picks the winner, scored by the same mechanical checker as a single
// (bench/w1143). Racing multiplies attempt tokens by N and adds judge
// overhead, so the built-in default is OFF (default_lanes 1): the operator
// turns it on per class via ~/.claude/local-llm/race-policy.json.
//
// Chain (lane-effort-policy pattern, W1140): SUSPENDERS_RACE_POLICY env pin →
// ~/.claude/local-llm/race-policy.json → .yaml → built-in defaults.
// Fail-soft: unreadable/invalid conf = built-in defaults + a surfaced
// warning — never a dispatch blocker.

import { existsSync, readFileSync } from "node:fs";
import { YAML } from "bun";

/** Hard ceiling on any lanes number regardless of conf. */
export const RACE_LANES_CAP = 8;
/** The lane count meaning racing OFF. */
export const RACE_OFF = 1;

/** One classify rule — first match wins; lanes > 1 turns racing ON for the
 *  matching class of work items. */
export interface RaceRule {
	when: {
		tags_any?: string[];
		title_re?: string;
		desc_re?: string;
	};
	/** lanes for a matched item; 1 = stay single */
	lanes: number;
}

export interface RacePolicy {
	version: 1;
	/** unmatched items ride this; 1 = racing OFF fleet-wide */
	default_lanes: number;
	/** every lanes number clamps to this at decision time */
	max_lanes: number;
	/** cheap tier the race attempts ride */
	attempt_port: number;
	attempt_temp: number;
	/** strong tier: judge + skeptic */
	judge_port: number;
	/** skeptic per-rule verify pass on the judge tally */
	skeptic: boolean;
	classify: RaceRule[];
}

/** Built-in defaults: racing OFF everywhere, the W1143 bench constants as
 *  the ready-to-switch-on shape. Machine conf overrides any of it — code
 *  never carries the operator's tuning. */
export const RACE_POLICY_DEFAULTS: RacePolicy = {
	version: 1,
	default_lanes: 1,
	max_lanes: 3,
	attempt_port: 8902,
	attempt_temp: 0.7,
	judge_port: 8903,
	skeptic: true,
	classify: [],
};

export class RacePolicyError extends Error {}

const isPort = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 65535;

const lanesOf = (v: unknown, field: string): number => {
	if (
		typeof v === "number" &&
		Number.isInteger(v) &&
		v >= 1 &&
		v <= RACE_LANES_CAP
	)
		return v;
	throw new RacePolicyError(
		`${field}: must be an integer 1..${RACE_LANES_CAP} (1 = racing off)`,
	);
};

const portOf = (v: unknown, field: string): number => {
	if (isPort(v)) return v;
	throw new RacePolicyError(`${field}: must be a port 1..65535`);
};

const tempOf = (v: unknown): number => {
	if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2) return v;
	throw new RacePolicyError("attempt_temp: must be a number 0..2");
};

const parseRules = (raw: unknown): RaceRule[] => {
	if (raw === undefined) return [];
	if (!Array.isArray(raw))
		throw new RacePolicyError("classify: must be a list of rules");
	return raw.map((r, i) => parseRule(r, i));
};

const parseRule = (r: unknown, i: number): RaceRule => {
	const rule = (r ?? {}) as Record<string, unknown>;
	const when = (rule.when ?? {}) as Record<string, unknown>;
	const tags = when.tags_any;
	if (
		tags !== undefined &&
		(!Array.isArray(tags) ||
			!tags.length ||
			!tags.every((t) => typeof t === "string" && t))
	)
		throw new RacePolicyError(
			`classify[${i}].when.tags_any: must be a non-empty string list`,
		);
	if (!tags && !when.title_re && !when.desc_re)
		throw new RacePolicyError(
			`classify[${i}].when: needs tags_any, title_re or desc_re`,
		);
	for (const k of ["title_re", "desc_re"] as const) {
		const v = when[k];
		if (v === undefined) continue;
		if (typeof v !== "string")
			throw new RacePolicyError(`classify[${i}].when.${k}: must be a string`);
		try {
			// compiled case-insensitive — JS RegExp has no (?i) inline flag
			new RegExp(v, "i");
		} catch {
			throw new RacePolicyError(
				`classify[${i}].when.${k}: invalid regex: ${v}`,
			);
		}
	}
	return {
		when: {
			...(Array.isArray(tags)
				? { tags_any: (tags as string[]).map((t) => t.toLowerCase()) }
				: {}),
			...(typeof when.title_re === "string" ? { title_re: when.title_re } : {}),
			...(typeof when.desc_re === "string" ? { desc_re: when.desc_re } : {}),
		},
		lanes: lanesOf(rule.lanes, `classify[${i}].lanes`),
	};
};

/** Parse + validate a policy document (YAML or JSON). Throws
 *  RacePolicyError naming the offending key; absent optional keys ride
 *  the built-in defaults. */
export const parseRacePolicy = (text: string): RacePolicy => {
	let doc: Record<string, unknown>;
	try {
		doc = (
			text.trimStart().startsWith("{") ? JSON.parse(text) : YAML.parse(text)
		) as Record<string, unknown>;
	} catch (e) {
		throw new RacePolicyError(
			`race policy parse failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc))
		throw new RacePolicyError("race policy must be a mapping");
	if (doc.version !== undefined && doc.version !== 1)
		throw new RacePolicyError(
			`unsupported race policy version: ${String(doc.version)} — version: 1 only`,
		);
	return {
		version: 1,
		default_lanes: lanesOf(doc.default_lanes ?? 1, "default_lanes"),
		max_lanes: lanesOf(doc.max_lanes ?? 3, "max_lanes"),
		attempt_port: portOf(doc.attempt_port ?? 8902, "attempt_port"),
		attempt_temp: tempOf(doc.attempt_temp ?? 0.7),
		judge_port: portOf(doc.judge_port ?? 8903, "judge_port"),
		skeptic: doc.skeptic === undefined ? true : doc.skeptic === true,
		classify: parseRules(doc.classify),
	};
};

export type RacePolicySource = "env" | "runtime" | "default";

export interface LoadedRacePolicy {
	policy: RacePolicy;
	source: RacePolicySource;
	path: string | null;
	/** set when a conf file exists but failed to load — surfaced, never silent */
	warning: string | null;
}

const RUNTIME_BASE = (home: string): string =>
	`${home}/.claude/local-llm/race-policy`;

/** One conf file → LoadedRacePolicy; a bad file falls back to the built-in
 *  defaults with the parse error surfaced in warning (never silent). */
const readConf = (path: string, source: RacePolicySource): LoadedRacePolicy => {
	try {
		return {
			policy: parseRacePolicy(readFileSync(path, "utf8")),
			source,
			path,
			warning: null,
		};
	} catch (e) {
		return {
			policy: RACE_POLICY_DEFAULTS,
			source: "default",
			path,
			warning: `${path}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
};

/** W1143 chain (lane-effort-policy pattern): SUSPENDERS_RACE_POLICY env pin →
 *  runtime json → runtime yaml → built-in defaults. An EMPTY env var counts
 *  as unset (`??` alone would pass ""). */
export const loadRacePolicy = (opts?: {
	env?: NodeJS.ProcessEnv;
	home?: string;
}): LoadedRacePolicy => {
	const env = opts?.env ?? process.env;
	const home = opts?.home ?? env.HOME ?? "";
	const pinned = env.SUSPENDERS_RACE_POLICY || undefined;
	const cands = [
		{ path: pinned ?? "", source: "env" as const },
		{ path: `${RUNTIME_BASE(home)}.json`, source: "runtime" as const },
		{ path: `${RUNTIME_BASE(home)}.yaml`, source: "runtime" as const },
	];
	for (const c of cands) {
		if (c.path && existsSync(c.path)) return readConf(c.path, c.source);
	}
	return {
		policy: RACE_POLICY_DEFAULTS,
		source: "default",
		path: null,
		warning: null,
	};
};

/** The item-side classification inputs: the work row's comma-set tags,
 *  title and description. */
export interface RaceItemInput {
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
export const classifyRace = (
	policy: RacePolicy,
	item: RaceItemInput,
): { lanes: number; matched: string | null } => {
	const tags = (item.tags ?? "")
		.split(",")
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	for (const rule of policy.classify) {
		if (rule.when.tags_any?.some((t) => tags.includes(t.toLowerCase()))) {
			return {
				lanes: Math.min(rule.lanes, policy.max_lanes),
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
				return {
					lanes: Math.min(rule.lanes, policy.max_lanes),
					matched: reKey,
				};
		}
	}
	return {
		lanes: Math.min(policy.default_lanes, policy.max_lanes),
		matched: null,
	};
};

export interface RaceDecision {
	/** lanes clamped to max_lanes; 1 = racing OFF */
	lanes: number;
	raced: boolean;
	attemptPort: number;
	attemptTemp: number;
	judgePort: number;
	skeptic: boolean;
	/** the matched rule summary ("tags_any:verification") or null (default) */
	matched: string | null;
}

/** W1143 decision: a matched rule pins the lanes (clamped); unmatched items
 *  ride default_lanes. raced = lanes > 1. */
export const raceDecision = (
	policy: RacePolicy,
	item: RaceItemInput,
): RaceDecision => {
	const { lanes, matched } = classifyRace(policy, item);
	return {
		lanes,
		raced: lanes > RACE_OFF,
		attemptPort: policy.attempt_port,
		attemptTemp: policy.attempt_temp,
		judgePort: policy.judge_port,
		skeptic: policy.skeptic,
		matched,
	};
};

/** The brief's one-line policy verdict: dispatch reads whether the item
 *  races, at how many lanes, and why. */
export const racePolicyLine = (d: RaceDecision): string =>
	d.raced
		? `RACE POLICY: race ${d.lanes} cheap attempts (temp ${d.attemptTemp}) → judge :${d.judgePort}${d.skeptic ? " + skeptic" : ""} — classified ${d.matched ?? "default"}.`
		: `RACE POLICY: off — single lane — classified ${d.matched ?? "default"}.`;
