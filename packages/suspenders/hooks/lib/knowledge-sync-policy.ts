// hooks/lib/knowledge-sync-policy.ts — W944: the spoke→hub knowledge sync's
// policy layer. Two halves:
//
//   readSyncConfig — the machine-level config validator
//   (~/.config/klh/knowledge-sync.json, 0600 exactly, ≤32 KiB — same
//   discipline as the W491 observation relay's observation-relays.json).
//   The config IS the opt-in: no file = the sync is disabled.
//
//   projectSessionMetrics — the STRUCTURAL content deny. decant's per-session
//   rows carry transcript-derived text (`title`) and local paths
//   (`project_path`) — both default-DENY classes. The projector copies ONLY
//   allowlisted metric fields; content fields have no code path into any
//   payload. Policy knobs can only widen the METRICS class (aggregate stats
//   on/off, session grain on/off, facts on/off) — no knob re-enables content.
//
// decant is the ONLY input surface (brief law: never parse the unencrypted
// db directly — decant's own export is the interface).
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isLoopbackHostname } from "./loopback.ts";

export interface SyncPolicy {
	/** decant aggregate rollups (day/tool/model) — sync-by-default class */
	metrics: boolean;
	/** per-session metric grain (durations/context) — opt-in, metrics-only */
	metricsSessions: boolean;
	/** verified facts (lesson. + finding. keys) cross as candidate rows */
	facts: boolean;
}

export interface SyncConfig {
	localHub: string;
	targets: SyncTarget[];
	policy: SyncPolicy;
	/** decant binary — absolute path or bare name resolved from PATH */
	decantBin: string;
}

/** The default policy — metrics-only (the sync-by-default class). */
export const DEFAULT_POLICY: SyncPolicy = {
	metrics: true,
	metricsSessions: false,
	facts: true,
};

export const SYNC_CONFIG_PATH = (): string =>
	`${process.env.HOME}/.config/klh/knowledge-sync.json`;

export const DECANT_DEFAULT_BIN = "decant";

function identity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!!value.trim() &&
		value.length <= 128 &&
		!["all", "unknown"].includes(value) &&
		![...value].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	);
}

/** Same target-URL rules as the observation relay (W491): origin-only, no
 *  userinfo/query/hash, http only for loopback hosts. */
function validTargetUrl(raw: string): URL | null {
	try {
		const url = new URL(raw);
		if (url.protocol === "http:" && !isLoopbackHostname(url.hostname))
			return null;
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/"
		)
			return null;
		return url;
	} catch {
		return null;
	}
}

function parseTarget(value: unknown): SyncTarget {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid sync target");
	const target = value as Record<string, unknown>;
	if (
		typeof target.url !== "string" ||
		target.url.length > 2048 ||
		typeof target.writeTokenFile !== "string" ||
		target.writeTokenFile.length > 1024 ||
		!isAbsolute(target.writeTokenFile)
	)
		throw new Error("Invalid sync target");
	const url = validTargetUrl(target.url);
	if (!url) throw new Error("Invalid sync target");
	return {
		url: url.origin,
		writeTokenFile: target.writeTokenFile,
		...(typeof target.hubId === "string" && identity(target.hubId)
			? { hubId: target.hubId }
			: {}),
	};
}

/** ≤ 8 targets, unique origins (W491 posture). */
function parseTargets(value: unknown): SyncTarget[] {
	if (!Array.isArray(value) || value.length > 8)
		throw new Error("Invalid sync configuration");
	const targets = value.map(parseTarget);
	if (new Set(targets.map((t) => t.url)).size !== targets.length)
		throw new Error("Duplicate sync targets");
	return targets;
}

/** Policy keys: booleans only, unknown keys rejected — the policy can only
 *  toggle classes that already exist, never invent new ones. */
function parsePolicy(value: unknown): SyncPolicy {
	if (value === undefined) return DEFAULT_POLICY;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid sync policy");
	const p = value as Record<string, unknown>;
	for (const [k, v] of Object.entries(p)) {
		if (!(k in DEFAULT_POLICY) || typeof v !== "boolean")
			throw new Error(`Invalid sync policy key: ${k}`);
	}
	return {
		metrics: p.metrics ?? DEFAULT_POLICY.metrics,
		metricsSessions: p.metricsSessions ?? DEFAULT_POLICY.metricsSessions,
		facts: p.facts ?? DEFAULT_POLICY.facts,
	};
}

function parseDecantBin(value: unknown): string {
	if (value === undefined) return DECANT_DEFAULT_BIN;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 1024 ||
		(!isAbsolute(value) && !/^[A-Za-z0-9._-]+$/.test(value))
	)
		throw new Error("Invalid decantBin (absolute path or bare name)");
	return value;
}

/** No secrets in configuration: only identity and token file paths. */
export function readSyncConfig(path: string): SyncConfig | null {
	let body: string;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 32_768 || (stat.mode & 0o777) !== 0o600)
			throw new Error("Invalid sync configuration");
		body = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("Unable to read sync configuration");
	}
	let input: unknown;
	try {
		input = JSON.parse(body);
	} catch {
		throw new Error("Invalid sync configuration");
	}
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid sync configuration");
	const config = input as Record<string, unknown>;
	if (!identity(config.localHub)) throw new Error("Invalid sync configuration");
	return {
		localHub: config.localHub,
		targets: parseTargets(config.targets),
		policy: parsePolicy(config.policy),
		decantBin: parseDecantBin(config.decantBin),
	};
}

/** The W491 token-file discipline, shared posture: 0600, single-line. */
export function readSyncToken(path: string): string {
	const stat = statSync(path);
	if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096)
		throw new Error("Token file must be private mode 600");
	const token = readFileSync(path, "utf8").trim();
	if (!token || /\s/.test(token)) throw new Error("Invalid token file");
	return token;
}

// ─── the structural content deny ────────────────────────────────────────────

export interface SessionMetrics {
	sessionId: string; // opaque: sha256(source_session_id), 16 hex
	tool: string | null;
	model: string | null;
	reasoningEffort: string | null;
	startedAt: string | null;
	endedAt: string | null;
	durationMs: number | null;
	messageCount: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	peakContextTokens: number | null;
	contextWindowTokens: number | null;
	costUsd: number | null;
}

/** sha256 hex of the local session id — opaque correlation across the
 *  boundary; the raw id never leaves the machine. */
export function opaqueSessionId(sourceSessionId: string): string {
	return createHash("sha256")
		.update(sourceSessionId)
		.digest("hex")
		.slice(0, 16);
}

const cleanMetricString = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 && v.length <= 128 ? v : null;

const cleanMetricNumber = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

/** decant ls row → metrics-only row. Content fields (title, project_path,
 *  user_state, …) are NEVER READ — the deny is structural, not a filter. */
export function projectSessionMetrics(
	row: Record<string, unknown>,
): SessionMetrics {
	const startedAt = cleanMetricString(row.started_at);
	const endedAt = cleanMetricString(row.ended_at);
	const durationMs =
		startedAt && endedAt
			? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || null
			: null;
	return {
		sessionId:
			typeof row.source_session_id === "string"
				? opaqueSessionId(row.source_session_id)
				: "",
		tool: cleanMetricString(row.tool),
		model: cleanMetricString(row.model),
		reasoningEffort: cleanMetricString(row.reasoning_effort),
		startedAt,
		endedAt,
		durationMs,
		messageCount: cleanMetricNumber(row.message_count),
		inputTokens: cleanMetricNumber(row.total_input_tokens),
		outputTokens: cleanMetricNumber(row.total_output_tokens),
		reasoningTokens: cleanMetricNumber(row.total_reasoning_tokens),
		peakContextTokens: cleanMetricNumber(row.peak_context_tokens),
		contextWindowTokens: cleanMetricNumber(row.context_window_tokens),
		costUsd: cleanMetricNumber(row.estimated_cost_usd),
	};
}

/** decant stats row (key, sessions, tokens, cost) → metrics row. Stats
 *  output is numeric by construction; the projection still re-types every
 *  field so a future decant change cannot smuggle content through. */
export function projectStatsMetrics(
	row: Record<string, unknown>,
): StatsMetrics | null {
	const key = cleanMetricString(row.key);
	const sessions = cleanMetricNumber(row.sessions);
	const input = cleanMetricNumber(row.input_tokens);
	const output = cleanMetricNumber(row.output_tokens);
	const cost = cleanMetricNumber(row.estimated_cost_usd);
	if (!key || sessions === null || input === null || output === null)
		return null;
	return {
		key,
		sessions,
		tokens: input + output,
		costUsd: cost ?? 0,
	};
}

export interface StatsMetrics {
	key: string;
	sessions: number;
	tokens: number;
	costUsd: number;
}
