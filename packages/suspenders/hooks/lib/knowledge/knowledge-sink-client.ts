// hooks/lib/knowledge/knowledge-sink-client.ts — W1221: the ONE client the
// harness uses to reach the hub knowledge sink's recall faces. W1221 wires
// three consumers onto it:
//   coord fact get — a local facts miss falls through to the sink (/search),
//   session-start  — a one-line pointer renders when the sink conf resolves,
//   belt tier.json — the emitted manifest carries the query face URL + scope.
// The faces are the W1218 pair (POST /knowledge/query {question} and
// /knowledge/sql {sql}, bksk_ keys scoped buckle:knowledge:QUERY_ / READ_)
// plus the anonymous-scrubbed POST /search recall face — all on knowledge-api.
// Config-over-code: real values live in machine conf (the sync config /
// launchd env); this module reads the env knobs only, empty string counts as
// absent (the knowledge-query.ts conf law). Fail-open everywhere: a sink
// miss/partition must never break the local read it backs.
import { readFileSync } from "node:fs";

/** The NL query face's buckle scope (mirrors knowledge-query.ts). */
export const SINK_QUERY_SCOPE = "buckle:knowledge:QUERY_";
/** The direct SQL face's buckle scope (mirrors knowledge-query.ts). */
export const SINK_READ_SCOPE = "buckle:knowledge:READ_";

/** Sink recall conf — resolved once per call site, env-pinnable for tests. */
export interface SinkConf {
	/** knowledge-api base (origin only). null = sink unconfigured. */
	url: string | null;
	/** bksk_ key for the /knowledge/* faces. null = anonymous posture. */
	key: string | null;
	/** 0600 key file (preferred over a raw env key — secrets are files). */
	keyFile: string | null;
	/** bounded recall budget — a slow sink must not stall the caller. */
	timeoutMs: number;
}

const envStr = (v: string | undefined): string | null => {
	const t = (v ?? "").trim();
	return t.length > 0 ? t : null;
};

/** Read the configured key file (single-line 0600). Missing/unreadable →
 *  null — a missing key file degrades to anonymous, never throws. */
export const readSinkKey = (conf: SinkConf = sinkConf()): string | null => {
	if (conf.key) return conf.key;
	if (!conf.keyFile) return null;
	try {
		return envStr(readFileSync(conf.keyFile, "utf8"));
	} catch {
		return null;
	}
};

/** Boot-time resolution (env-first; empty string counts as absent). */
export function sinkConf(env: NodeJS.ProcessEnv = process.env): SinkConf {
	return {
		url: envStr(env.SUSPENDERS_KNOWLEDGE_SINK_URL),
		key: envStr(env.SUSPENDERS_KNOWLEDGE_KEY),
		keyFile: envStr(env.SUSPENDERS_KNOWLEDGE_KEY_FILE),
		timeoutMs: Number(env.SUSPENDERS_KNOWLEDGE_SINK_TIMEOUT_MS) || 2_000,
	};
}

/** True when the sink is addressable — session-start's one-liner and the
 *  coord fallback gate on THIS, never on a hardcoded host. */
export const sinkConfigured = (conf: SinkConf = sinkConf()): boolean =>
	conf.url !== null;

export interface SinkSearchOutcome {
	ok: boolean;
	/** the answer text rendered from the top cards/hits (null on a miss) */
	answer: string | null;
	/** raw hits (already scrubbed when anonymous) for richer callers */
	hits: Record<string, unknown>[];
	/** the sink that answered — renders in the fallback line */
	url: string;
	error?: string;
}

const searchMiss = (conf: SinkConf, error: string): SinkSearchOutcome => ({
	ok: false,
	answer: null,
	hits: [],
	url: conf.url ?? "",
	error,
});

/** Outcome of the NL query face — mirrors the knowledge-api JSON contract. */
export interface SinkQueryOutcome {
	ok: boolean;
	status: number;
	rows?: Record<string, unknown>[];
	rowCount?: number;
	sql?: string;
	elapsedMs?: number;
	error?: string;
}

const queryRefused = (status: number, error: string): SinkQueryOutcome => ({
	ok: false,
	status,
	error,
});

/** POST {url}/search — the anonymous scrubbed recall face; bounded, fail-open. */
export async function searchSink(
	query: string,
	conf: SinkConf = sinkConf(),
	fetchFn: typeof fetch = fetch,
): Promise<SinkSearchOutcome> {
	if (!conf.url) return searchMiss(conf, "sink not configured");
	try {
		const res = await fetchFn(`${conf.url.replace(/\/$/, "")}/search`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query, limit: 5 }),
			signal: AbortSignal.timeout(conf.timeoutMs),
		});
		if (!res.ok) return searchMiss(conf, `HTTP ${res.status}`);
		const data = (await res.json().catch(() => null)) as {
			cards?: unknown;
			hits?: Record<string, unknown>[];
		} | null;
		// W103: the face's cards field is ONE prose string; tolerate an array
		// form defensively (older/newer faces) — joined with a blank line.
		const raw: unknown = data?.cards;
		const answer =
			typeof raw === "string"
				? raw
				: Array.isArray(raw)
					? (raw as string[]).join("\n\n")
					: null;
		return {
			ok: true,
			answer,
			hits: Array.isArray(data?.hits) ? data.hits : [],
			url: conf.url,
		};
	} catch (e) {
		return searchMiss(conf, e instanceof Error ? e.message : String(e));
	}
}

/** POST {url}/knowledge/query — the NL face; needs a QUERY_-scoped key. */
export async function querySink(
	question: string,
	conf: SinkConf = sinkConf(),
	fetchFn: typeof fetch = fetch,
): Promise<SinkQueryOutcome> {
	if (!conf.url) return queryRefused(0, "sink not configured");
	const key = readSinkKey(conf);
	if (!key) return queryRefused(0, "no sink key");
	try {
		const res = await fetchFn(
			`${conf.url.replace(/\/$/, "")}/knowledge/query`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({ question }),
				signal: AbortSignal.timeout(conf.timeoutMs + 5_000),
			},
		);
		const data = (await res.json().catch(() => ({}))) as {
			rows?: Record<string, unknown>[];
			rowCount?: number;
			sql?: string;
			elapsedMs?: number;
			error?: string;
		};
		if (!res.ok)
			return queryRefused(res.status, data.error ?? `HTTP ${res.status}`);
		return {
			ok: true,
			status: res.status,
			rows: data.rows ?? [],
			rowCount: data.rowCount ?? 0,
			sql: data.sql,
			elapsedMs: data.elapsedMs,
		};
	} catch (e) {
		return queryRefused(0, e instanceof Error ? e.message : String(e));
	}
}
