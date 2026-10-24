// hooks/lib/board/board-config.ts — W147 console: the board's config surface.
// Read/validate/preview/apply for the two real config files the console
// manages, config-over-code, never a code edit:
//
//   routing-policy.json  — the shared belt+buckle routing policy. Chain
//     (belt bin/router-policy.ts pattern): BELT_POLICY/BUCKLE_POLICY env →
//     ~/.claude/local-llm/routing-policy.json (runtime) → committed default.
//     The console DISPLAYS the resolved file and WRITES the runtime copy
//     (or the env-named file when the operator pinned one) — never the
//     committed default. Apply is atomic (tmp + rename). Activation is NOT
//     instantaneous: belt emits litellm.yaml via gateway-config.ts and
//     kicks the launchd job BETWEEN fan-outs (a reload drops in-flight
//     streams); buckle loads the policy at boot.
//
//   suspenders-board.json — board knobs (~/.claude/local-llm/): a settings
//     file read by the live board process (status_refresh_s feeds servicemon
//     at boot; harvest_ttl_s is maybeHarvest's default TTL; default_actor
//     feeds the console avatar's demo switch preselect).
//
// Every write path here is an allowlisted constant (or the env-pinned policy
// path the operator already owns). Invalid config = rejected with the parse
// error; nothing partial ever lands (validate-then-atomic-write).
import {
	type PlaidRoute,
	validatePlaidRoutes,
} from "../plaid/plaid-route-config.ts";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { scrub } from "../servicemon.ts";

// ─── errors ───────────────────────────────────────────────────────────────
export class ConfigError extends Error {}

// ─── routing-policy.json (belt + buckle share one file) ───────────────────
export interface PolicyGateway {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
}

interface PolicyDoc {
	version?: unknown;
	gateway?: unknown;
	[key: string]: unknown;
}

// Native-router semantics (belt bin/router-policy.ts parity). Defaults live
// in the loader chain, so absent keys keep belt/buckle's own defaults.
export const POLICY_DEFAULTS = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
} as const;

export interface PolicyGatewayParsed {
	num_retries: number;
	allowed_fails: number;
	cooldown_time: number;
	fallbacks: Record<string, string[]>;
}

const isIntGte0 = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 0;

// Owner directive (belt bin/routing-policy.json + buckle): NEVER flashx —
// same upstream family saturates together, and flashx is too expensive.
const validateLadder = (fallbacks: Record<string, string[]>): string | null => {
	for (const [model, tiers] of Object.entries(fallbacks)) {
		if (
			!Array.isArray(tiers) ||
			!tiers.length ||
			!tiers.every((t) => typeof t === "string" && t.length > 0)
		)
			return `fallbacks.${model}: must be a non-empty list of tier names`;
		if (tiers.includes("flashx"))
			return `fallbacks.${model}: flashx is refused (owner directive: same upstream family saturates together, flashx is too expensive)`;
	}
	return null;
};

// Shape + version checks shared by parse (read) and patch (validate-after).
function policyDoc(text: string): PolicyDoc {
	// W1253: JSON is the ONE parser — yaml bytes under any name are skipped
	// (a legacy .yaml candidate only counts when its content is already JSON).
	let doc: PolicyDoc;
	try {
		doc = JSON.parse(text) as PolicyDoc;
	} catch (e) {
		throw new ConfigError(
			`policy parse failed: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc))
		throw new ConfigError("policy must be a JSON object (gateway: ...)");
	if (doc.version !== undefined && doc.version !== 1)
		throw new ConfigError(
			`unsupported policy version: ${String(doc.version)} — version: 1 only`,
		);
	return doc;
}

function policyChecked(text: string): PolicyGateway {
	const doc = policyDoc(text);
	const g = (doc.gateway ?? {}) as PolicyGateway;
	if (g === null || typeof g !== "object" || Array.isArray(g))
		throw new ConfigError("gateway: must be a mapping");
	return g;
}

// Parse + validate. Throws ConfigError carrying the underlying parse message
// so the settings page can show WHY a config is invalid, verbatim.
export function parsePolicy(text: string): PolicyGatewayParsed {
	const g = policyChecked(text);
	for (const k of ["num_retries", "allowed_fails", "cooldown_time"] as const) {
		const v = g[k];
		if (v !== undefined && !isIntGte0(v))
			throw new ConfigError(`gateway.${k}: must be an integer >= 0`);
	}
	const fb = (g.fallbacks ?? {}) as Record<string, string[]>;
	if (typeof fb !== "object" || fb === null || Array.isArray(fb))
		throw new ConfigError("gateway.fallbacks: must be a mapping");
	const ladderErr = validateLadder(fb);
	if (ladderErr) throw new ConfigError(ladderErr);
	return {
		num_retries: g.num_retries ?? POLICY_DEFAULTS.num_retries,
		allowed_fails: g.allowed_fails ?? POLICY_DEFAULTS.allowed_fails,
		cooldown_time: g.cooldown_time ?? POLICY_DEFAULTS.cooldown_time,
		fallbacks: fb,
	};
}

export interface ResolvedPolicy {
	path: string;
	source: "env" | "runtime" | "legacy" | "default";
	text: string;
	mtimeMs: number;
}

const jsonPolicyPath = (path: string): string =>
	path.endsWith(".json") ? path : `${path.replace(/\.ya?ml$/i, "")}.json`;

// JSON wins. YAML is accepted only as a migration source; it is never a
// settings write target. Preserve an env-pinned policy's sibling location.
export function resolvePolicy(opts?: {
	explicitPath?: string;
	beltRepo?: string;
	buckleRepo?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
}): ResolvedPolicy | null {
	const env = opts?.env ?? process.env;
	const home = opts?.home ?? env.HOME ?? "";
	const beltRepo = opts?.beltRepo ?? env.BELT_REPO ?? "";
	const buckleRepo = opts?.buckleRepo ?? env.BUCKLE_REPO ?? "";
	const pinned =
		opts?.explicitPath || env.BELT_POLICY || env.BUCKLE_POLICY || "";
	const cands: { path: string; source: ResolvedPolicy["source"] }[] = [
		{ path: pinned ? jsonPolicyPath(pinned) : "", source: "env" },
		{
			path: pinned && pinned !== jsonPolicyPath(pinned) ? pinned : "",
			source: "legacy",
		},
		{
			path: `${home}/.claude/local-llm/routing-policy.json`,
			source: "runtime",
		},
		{
			path: `${home}/.claude/local-llm/routing-policy.json`,
			source: "legacy",
		},
		{ path: `${beltRepo}/bin/routing-policy.json`, source: "default" },
		{ path: `${buckleRepo}/routing-policy.json`, source: "default" },
		{ path: `${beltRepo}/bin/routing-policy.json`, source: "default" },
		{ path: `${buckleRepo}/routing-policy.json`, source: "default" },
	];
	for (const c of cands) {
		if (!c.path || !existsSync(c.path)) continue;
		try {
			const st = statSync(c.path);
			return {
				path: c.path,
				source: c.source,
				text: readFileSync(c.path, "utf8"),
				mtimeMs: st.mtimeMs,
			};
		} catch {}
	}
	return null;
}

// The write target is always JSON, including when an old env variable points
// at a YAML file. The old YAML remains available for read-only migration.
export function policyWritePath(opts?: {
	explicitPath?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
}): string {
	const env = opts?.env ?? process.env;
	const home = opts?.home ?? env.HOME ?? "";
	// an EMPTY env var counts as unset — ?? alone would pass "" through and
	// resolve the write target to ""
	const envPath = env.BELT_POLICY || env.BUCKLE_POLICY || undefined;
	return jsonPolicyPath(
		opts?.explicitPath ??
			envPath ??
			`${home}/.claude/local-llm/routing-policy.json`,
	);
}

// Atomic write: temp file in the SAME directory (rename is same-fs atomic)
// then rename over the target. Belt/buckle never see a half-written policy.
export function atomicWrite(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** Convert a legacy policy to JSON without dropping unrelated keys/values. */
export function policyAsJson(text: string): string {
	parsePolicy(text);
	return `${JSON.stringify(policyDoc(text), null, "\t")}\n`;
}

/** Apply normal-form controls to the JSON policy document. */
export function patchPolicyJson(text: string, patch: PolicyPatch): string {
	parsePolicy(text);
	const doc = policyDoc(text);
	const gateway = { ...((doc.gateway ?? {}) as Record<string, unknown>) };
	for (const key of [
		"num_retries",
		"allowed_fails",
		"cooldown_time",
	] as const) {
		if (patch[key] !== undefined) gateway[key] = patch[key];
	}
	if (patch.ladder?.model || patch.ladders) {
		const fallbacks = {
			...((gateway.fallbacks ?? {}) as Record<string, unknown>),
		};
		if (patch.ladder?.model) {
			if (
				["__proto__", "constructor", "prototype"].includes(patch.ladder.model)
			)
				throw new ConfigError("invalid ladder model");
			fallbacks[patch.ladder.model] = patch.ladder.tiers;
		}
		for (const [model, tiers] of Object.entries(patch.ladders ?? {})) {
			if (["__proto__", "constructor", "prototype"].includes(model))
				throw new ConfigError("invalid ladder model");
			fallbacks[model] = tiers;
		}
		gateway.fallbacks = fallbacks;
	}
	const next = `${JSON.stringify({ ...doc, gateway }, null, "\t")}\n`;
	parsePolicy(next);
	return next;
}

// ─── comment-preserving line patch ────────────────────────────────────────
interface Edit {
	lines: string[];
	changed: boolean;
}

// Scalar knob: replace in place (keeps indent + comments), or insert under
// `gateway:`; a gateway-less doc gets the block appended at EOF.
const setScalar = (lines: string[], key: string, val: number): Edit => {
	const prefix = `${key}:`;
	const i = lines.findLastIndex((l) => l.trimStart().startsWith(prefix));
	if (i >= 0) {
		const t = lines[i].trimStart();
		const indent = lines[i].slice(0, lines[i].length - t.length);
		const next = lines.slice();
		next[i] = `${indent}${prefix} ${val}`;
		return { lines: next, changed: true };
	}
	const gi = lines.findIndex((l) => l.trimEnd() === "gateway:");
	if (gi < 0) {
		const next = lines.slice();
		next.push("gateway:", `  ${prefix} ${val}`);
		return { lines: next, changed: true };
	}
	const next = lines.slice();
	next.splice(gi + 1, 0, `  ${prefix} ${val}`);
	return { lines: next, changed: true };
};

// Ladder tier list: rewrite the `model: [a, b, c]` flow line in place (keeps
// indent + any trailing comment placement stays with the line it was on).
const setLadder = (lines: string[], model: string, tiers: string[]): Edit => {
	const prefix = `${model}:`;
	const rendered = `${prefix} [${tiers.join(", ")}]`;
	const i = lines.findIndex((l) => l.trimStart().startsWith(prefix));
	if (i >= 0) {
		const t = lines[i].trimStart();
		const indent = lines[i].slice(0, lines[i].length - t.length);
		const next = lines.slice();
		next[i] = `${indent}${rendered}`;
		return { lines: next, changed: true };
	}
	const fi = lines.findIndex((l) => l.trimEnd() === "fallbacks:");
	if (fi < 0) return { lines, changed: false };
	const next = lines.slice();
	next.splice(fi + 1, 0, `  ${rendered}`);
	return { lines: next, changed: true };
};

export interface PolicyPatch {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	// replaces the model's tier list — order IS priority (first = primary)
	ladder?: { model: string; tiers: string[] };
	ladders?: Record<string, string[]>;
}

// Line-patch the policy text (comments preserved), then PROVE the result
// parses + validates — belt/buckle's loaders must accept exactly this.
export function patchPolicyText(text: string, patch: PolicyPatch): string {
	let out = text;
	if (patch.ladder?.model) {
		const e = setLadder(
			out.split("\n"),
			patch.ladder.model,
			patch.ladder.tiers,
		);
		if (!e.changed) throw new ConfigError("no fallbacks: section to edit");
		out = e.lines.join("\n");
	}
	for (const [k, v] of Object.entries(patch)) {
		if (k === "ladder" || k === "ladders" || v === undefined) continue;
		const e = setScalar(out.split("\n"), k, v as number);
		out = e.lines.join("\n");
	}
	parsePolicy(out); // throws ConfigError when the patched doc is invalid
	return out;
}

// Small line diff for the preview page: common prefix/suffix trimmed, the
// middle shown as del/add blocks (a full LCS diff is overkill here).
export function diffLines(a: string, b: string): string[] {
	const al = a.split("\n");
	const bl = b.split("\n");
	let p = 0;
	while (p < al.length && p < bl.length && al[p] === bl[p]) p++;
	let s = 0;
	while (
		s < al.length - p &&
		s < bl.length - p &&
		al[al.length - 1 - s] === bl[bl.length - 1 - s]
	)
		s++;
	const out: string[] = [];
	for (let i = p; i < al.length - s; i++) out.push(`- ${al[i]}`);
	for (let i = p; i < bl.length - s; i++) out.push(`+ ${bl[i]}`);
	return out;
}

// ─── suspenders-board.json (the board's own knobs) ────────────────────────
export interface BoardSettings {
	/** Explicit route rows constrain both dispatcher and board; [] disables all routes. */
	plaid_routes?: PlaidRoute[];
	status_refresh_s?: number;
	harvest_ttl_s?: number;
	default_actor?: string;
	default_executors?: string[];
	/** W201 executor policy: allow-list of lane executors. Absent = everything
	 * allowed (no policy); claude/openai blocked by listing only what's in. */
	enabled_executors?: string[];
	/** W217: which model produces decision recommendations — user override of
	 * the hub default; read by advise.ts + decide-eval.ts (URL + model id). */
	recommendation_url?: string;
	recommendation_model?: string;
	/** W270 orchestrate prompt transforms (namespaced, W269-compatible):
	 * condense default ON, enhance/debug/log default OFF. */
	"prompt.condense"?: boolean;
	"prompt.enhance"?: boolean;
	"prompt.debug"?: boolean;
	"prompt.log"?: boolean;
}

export type BoardSettingsPatch = {
	[K in keyof BoardSettings]?: BoardSettings[K] | null;
};

export const PROMPT_SETTING_KEYS = [
	"prompt.condense",
	"prompt.enhance",
	"prompt.debug",
	"prompt.log",
] as const;

export const boardSettingsPath = (home = process.env.HOME ?? ""): string =>
	`${home}/.claude/local-llm/suspenders-board.json`;

const numKnob = (
	o: Record<string, unknown>,
	k: string,
	min: number,
): number | undefined => {
	const v = o[k];
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v < min)
		throw new ConfigError(`${k}: must be a number >= ${min}`);
	return v;
};

// Unknown keys are ignored on read and dropped on write. Every known board
// setting is exposed by the console form.
export function validateBoardSettings(v: unknown): BoardSettings {
	if (v === null || typeof v !== "object" || Array.isArray(v))
		throw new ConfigError("board settings must be a JSON object");
	const o = v as Record<string, unknown>;
	const out: BoardSettings = {};
	if (Object.hasOwn(o, "plaid_routes"))
		out.plaid_routes = validatePlaidRoutes(o.plaid_routes);
	const sr = numKnob(o, "status_refresh_s", 0);
	if (sr !== undefined) out.status_refresh_s = sr;
	const ht = numKnob(o, "harvest_ttl_s", 1);
	if (ht !== undefined) out.harvest_ttl_s = ht;
	const da = o.default_actor;
	if (da !== undefined && da !== null && da !== "") {
		if (typeof da !== "string" || da.length > 200)
			throw new ConfigError("default_actor: must be a string (max 200 chars)");
		out.default_actor = da;
	}
	const de = o.default_executors;
	if (de !== undefined && de !== null) {
		if (
			!Array.isArray(de) ||
			de.length > 20 ||
			de.some((s) => typeof s !== "string" || s.length > 200 || !s)
		)
			throw new ConfigError(
				"default_executors: must be an array of 1-20 non-empty strings (max 200 chars each)",
			);
		out.default_executors = de as string[];
	}
	const ee = o.enabled_executors;
	if (ee !== undefined && ee !== null) {
		if (
			!Array.isArray(ee) ||
			ee.length > 20 ||
			ee.some((s) => typeof s !== "string" || s.length > 200 || !s)
		)
			throw new ConfigError(
				"enabled_executors: must be an array of 1-20 non-empty strings (max 200 chars each)",
			);
		out.enabled_executors = ee as string[];
	}
	const ru = o.recommendation_url;
	if (ru !== undefined && ru !== null && ru !== "") {
		if (typeof ru !== "string" || ru.length > 400)
			throw new ConfigError(
				"recommendation_url: must be a string (max 400 chars)",
			);
		out.recommendation_url = ru;
	}
	const rm = o.recommendation_model;
	if (rm !== undefined && rm !== null && rm !== "") {
		if (typeof rm !== "string" || rm.length > 200)
			throw new ConfigError(
				"recommendation_model: must be a big-reasoner id (max 200 chars)",
			);
		out.recommendation_model = rm;
	}
	for (const k of PROMPT_SETTING_KEYS) {
		const b = o[k];
		if (b === undefined || b === null) continue;
		if (typeof b !== "boolean")
			throw new ConfigError(`${k}: must be true or false`);
		out[k] = b;
	}
	return out;
}

export interface BoardSettingsState {
	path: string;
	exists: boolean;
	mtimeMs: number;
	settings: BoardSettings;
	error: string | null;
}

// Read the board knobs file — missing file = defaults, invalid JSON =
// surfaced (never silently ignored), unknown keys tolerated.
export function readBoardSettings(
	path = boardSettingsPath(),
): BoardSettingsState {
	if (!existsSync(path))
		return { path, exists: false, mtimeMs: 0, settings: {}, error: null };
	try {
		const st = statSync(path);
		const text = readFileSync(path, "utf8");
		return {
			path: scrub(path),
			exists: true,
			mtimeMs: st.mtimeMs,
			settings: validateBoardSettings(JSON.parse(text)),
			error: null,
		};
	} catch (e) {
		return {
			path: scrub(path),
			exists: true,
			mtimeMs: 0,
			settings: {},
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

// Form semantics: empty string = unset (removes the knob). Numbers coerce
// from the form strings; anything non-numeric throws the honest error.
export function formToBoardSettings(
	f: Record<string, unknown>,
): BoardSettingsPatch {
	// W183.2 — the ordered executor editor submits one comma-joined string;
	// the apply step re-feeds the serialized patch (array already). Empty
	// clears the list — dispatch falls back to bare claude.
	const patch: BoardSettingsPatch = {};
	const raw: Record<string, unknown> = {};
	for (const key of ["status_refresh_s", "harvest_ttl_s"] as const) {
		if (!(key in f)) continue;
		raw[key] = f[key] === "" || f[key] === null ? null : Number(f[key]);
	}
	for (const key of [
		"default_actor",
		"recommendation_url",
		"recommendation_model",
	] as const) {
		if (!(key in f)) continue;
		raw[key] = f[key] === "" ? null : f[key];
	}
	for (const key of ["default_executors", "enabled_executors"] as const) {
		if (!(key in f)) continue;
		const value = f[key];
		const list = Array.isArray(value)
			? value
			: typeof value === "string"
				? value.split(",")
				: [];
		raw[key] =
			key === "enabled_executors" && list.every((v) => !String(v).trim())
				? null
				: list.map((v) => String(v).trim()).filter(Boolean);
	}
	for (const key of PROMPT_SETTING_KEYS) {
		if (!(key in f)) continue;
		raw[key] =
			f[key] === true || f[key] === "true"
				? true
				: f[key] === false || f[key] === "false"
					? false
					: f[key];
	}
	const checked = validateBoardSettings(raw);
	Object.assign(patch, checked);
	for (const [key, value] of Object.entries(raw))
		if (value === null) (patch as Record<string, unknown>)[key] = null;
	return patch;
}

// Merge-apply the settings file: read → merge → validate → mtime guard →
// atomic write. expectedMtime (from the preview step) rejects concurrent
// edits — the operator confirms a diff of what they SAW.
export function applyBoardSettings(
	path: string,
	patch: BoardSettingsPatch,
	expectedMtimeMs?: number,
): { applied: BoardSettings } {
	if (existsSync(path)) {
		const st = statSync(path);
		if (
			expectedMtimeMs !== undefined &&
			Math.abs(st.mtimeMs - expectedMtimeMs) > 1
		)
			throw new ConfigError(
				"config changed since the preview — review the fresh diff and confirm again",
			);
	}
	const curText = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	const cur = validateBoardSettings(JSON.parse(curText));
	const merged = { ...cur, ...patch } as BoardSettingsPatch;
	for (const k of Object.keys(merged) as (keyof BoardSettings)[])
		if (merged[k] === undefined || merged[k] === null) delete merged[k];
	const applied = validateBoardSettings(merged);
	atomicWrite(path, `${JSON.stringify(applied, null, "\t")}\n`);
	return { applied };
}
