// hooks/lib/knowledge-sync.ts — W944: the spoke→hub knowledge sync core.
// Payload = two classes, and the class width is the policy:
//
//   metrics — decant headless (sync → stats --by day/tool/model, plus ls
//     only when policy.metricsSessions). Aggregate/token/cost/context
//     numbers only; the projector structurally cannot emit content fields.
//   facts — governor.db facts rows with lesson./finding. keys, AFTER local
//     verification: redactSecrets (mechanical secret pass) + version delta
//     against the machine-local cursor. They land hub-side as CANDIDATE
//     knowledge rows (unverified trust marker) — the hub's W142 gate
//     (human knowledge-promote) governs activation, never the wire.
//
// Transport mirrors the W491 relay: per-target token file (0600), POST with
// x-klh-write-token, origin-only URLs. No content ever crosses: the payload
// builder reads decant stats/ls ONLY (never export/show/search — transcript
// surfaces), and facts pass redactSecrets before serialization.
import { readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { REG } from "./govdb-util.ts";
import {
	readSyncConfig,
	readSyncToken,
	SYNC_CONFIG_PATH,
	projectSessionMetrics,
	projectStatsMetrics,
	type SessionMetrics,
	type StatsMetrics,
	type SyncConfig,
	type SyncTarget,
} from "./knowledge-sync-policy.ts";
import { redactSecrets } from "./knowledge.ts";

export interface SyncPayload {
	originHub: string;
	metrics: {
		days: StatsMetrics[];
		tools: StatsMetrics[];
		models: StatsMetrics[];
		sessions?: SessionMetrics[];
	};
	facts: SyncFact[];
}

export interface SyncFact {
	key: string;
	value: string;
	source: string | null;
	version: number;
	ts: number;
}

export interface SyncOutcome {
	target: string;
	hubId: string | null;
	ok: boolean;
	sentFacts: number;
	sentMetrics: number;
	error: string | null;
}

// the machine-local cursor: fact versions already accepted by every target
// (stamped only on a fully-successful pass — a partial pass re-sends, the
// hub side is idempotent by topic-skip). SUSPENDERS_KNOWLEDGE_SYNC_STATE
// relocates it (tests).
export interface SyncState {
	facts: Record<string, number>;
	metricsAt: number;
}

export const syncStatePath = (): string =>
	process.env.SUSPENDERS_KNOWLEDGE_SYNC_STATE ??
	`${process.env.HOME}/.claude-insights/knowledge-sync-state.json`;

export function readSyncState(path: string): SyncState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return { facts: {}, metricsAt: 0 };
		const s = parsed as Record<string, unknown>;
		const facts: Record<string, number> = {};
		if (s.facts && typeof s.facts === "object" && !Array.isArray(s.facts))
			for (const [k, v] of Object.entries(s.facts))
				if (typeof v === "number") facts[k] = v;
		return {
			facts,
			metricsAt: typeof s.metricsAt === "number" ? s.metricsAt : 0,
		};
	} catch {
		return { facts: {}, metricsAt: 0 };
	}
}

export function writeSyncState(path: string, state: SyncState): void {
	try {
		writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`, {
			mode: 0o600,
		});
	} catch {
		// state is a cursor, not a ledger — a failed stamp re-sends next fire
	}
}

// ─── decant: the only input surface ─────────────────────────────────────────

export interface DecantResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** argv-array spawn of the decant CLI — never a shell string. `sync` first
 *  (headless index refresh), then read-only projections with --no-sync. */
export function runDecant(
	bin: string,
	args: string[],
	cwd: string,
): DecantResult {
	const p = Bun.spawnSync([bin, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode ?? 1,
		stdout: new TextDecoder().decode(p.stdout ?? new Uint8Array()),
		stderr: new TextDecoder().decode(p.stderr ?? new Uint8Array()),
	};
}

function decantStats(
	config: SyncConfig,
	dim: "day" | "tool" | "model",
	cwd: string,
): StatsMetrics[] {
	const r = runDecant(
		config.decantBin,
		["stats", "--by", dim, "--format", "json", "--no-sync"],
		cwd,
	);
	if (r.code !== 0)
		throw new Error(
			`decant stats --by ${dim} failed: ${r.stderr.slice(0, 200)}`,
		);
	let rows: unknown;
	try {
		rows = JSON.parse(r.stdout);
	} catch {
		throw new Error(`decant stats --by ${dim}: unparseable output`);
	}
	if (!Array.isArray(rows))
		throw new Error(`decant stats --by ${dim}: not a list`);
	const out: StatsMetrics[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const m = projectStatsMetrics(row as Record<string, unknown>);
		if (m) out.push(m);
	}
	return out;
}

function decantSessions(config: SyncConfig, cwd: string): SessionMetrics[] {
	const r = runDecant(
		config.decantBin,
		["ls", "--json", "--limit", "2000", "--no-sync"],
		cwd,
	);
	if (r.code !== 0)
		throw new Error(`decant ls failed: ${r.stderr.slice(0, 200)}`);
	let rows: unknown;
	try {
		rows = JSON.parse(r.stdout);
	} catch {
		throw new Error("decant ls: unparseable output");
	}
	if (!Array.isArray(rows)) throw new Error("decant ls: not a list");
	const out: SessionMetrics[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		out.push(projectSessionMetrics(row as Record<string, unknown>));
	}
	return out;
}

// ─── facts: verified-only crossing ──────────────────────────────────────────

/** The syncable fact vocabulary: lesson. + finding. keys — the two classes
 *  lanes bank as durable knowledge. Anything else (work-adjacent fact rows,
 *  scratch keys) never crosses the machine boundary. */
export const SYNCABLE_FACT = /^(lesson|finding)\./;
export const MAX_FACT_VALUE = 2000;

export interface CollectedFacts {
	send: SyncFact[];
	skipped: string[];
}

/** Local verification, mechanically: vocabulary gate + redactSecrets pass
 *  + version-delta against the cursor. Rejected values are skipped WITH
 *  their key named — nothing partial crosses. */
export function collectFacts(
	state: SyncState,
	opts: { dbPath?: string | null } = {},
): CollectedFacts {
	const send: SyncFact[] = [];
	const skipped: string[] = [];
	const dbPath =
		opts.dbPath !== undefined ? opts.dbPath : `${REG()}/governor.db`;
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true, create: false });
	} catch {
		return { send, skipped: ["facts: governor.db not readable"] };
	}
	if (db) {
		const rows = db
			.query(
				"SELECT key, value, source, version, ts FROM facts WHERE key LIKE 'lesson.%' OR key LIKE 'finding.%' ORDER BY key",
			)
			.all() as {
			key: string;
			value: string | null;
			source: string | null;
			version: number;
			ts: number;
		}[];
		for (const r of rows) {
			if (!SYNCABLE_FACT.test(r.key)) continue;
			if (state.facts[r.key] === r.version) continue;
			const red = redactSecrets(r.value ?? "");
			if (!r.value) continue;
			if (r.value.length > MAX_FACT_VALUE) continue;
			if (red.rejected || red.hits.length > 0) {
				skipped.push(`${r.key}: secret pattern (${red.hits.join(", ")})`);
				continue;
			}
			send.push({
				key: r.key,
				value: red.text,
				source: r.source,
				version: r.version,
				ts: r.ts,
			});
		}
		// the hub caps 50 facts/payload — overflow waits for the next pass
		if (send.length > 50) send.length = 50;
	}
	if (db) db.close();
	return { send, skipped };
}

export interface CollectedPayload {
	payload: SyncPayload;
	skipped: string[];
	decantOk: boolean;
}

/** One collection pass: decant refresh + policy-gated projections + the
 *  facts pass. decant failures degrade to decantOk false + a skipped note —
 *  the sync never fabricates metrics rows. */
export function collectPayload(
	config: SyncConfig,
	state: SyncState,
	opts: { cwd?: string; dbPath?: string | null } = {},
): CollectedPayload {
	const skipped: string[] = [];
	const cwd = opts.cwd ?? process.cwd();
	const metrics: SyncPayload["metrics"] = { days: [], tools: [], models: [] };
	let decantOk = false;
	let facts: SyncFact[] = [];
	if (config.policy.metrics) {
		// headless refresh first — best-effort, its failure never fabricates
		runDecant(config.decantBin, ["sync", "-q"], cwd);
		for (const dim of ["day", "tool", "model"] as const) {
			try {
				const rows = decantStats(config, dim, cwd);
				if (dim === "day") metrics.days = rows;
				if (dim === "tool") metrics.tools = rows;
				if (dim === "model") metrics.models = rows;
				decantOk = true;
			} catch (e) {
				skipped.push(`${dim}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	if (config.policy.metricsSessions) {
		try {
			metrics.sessions = decantSessions(config, cwd);
		} catch (e) {
			skipped.push(`sessions: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (config.policy.facts) {
		const cf = collectFacts(state, { dbPath: opts.dbPath });
		skipped.push(...cf.skipped);
		facts = cf.send;
	}
	return {
		payload: {
			originHub: config.localHub,
			metrics,
			facts,
		},
		skipped,
		decantOk,
	};
}

// ─── transport: the W491 relay posture ──────────────────────────────────────

export async function postTarget(
	target: SyncTarget,
	payload: SyncPayload,
): Promise<SyncOutcome> {
	const sentFacts = payload.facts.length;
	const sentMetrics =
		payload.metrics.days.length +
		payload.metrics.tools.length +
		payload.metrics.models.length +
		(payload.metrics.sessions?.length ?? 0);
	const base = {
		target: target.url,
		hubId: target.hubId ?? null,
		sentFacts,
		sentMetrics,
	};
	try {
		const token = readSyncToken(target.writeTokenFile);
		const res = await fetch(`${target.url}/api/knowledge-ingest`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": token,
			},
			body: JSON.stringify(payload),
		});
		if (!res.ok) return { ...base, ok: false, error: `HTTP ${res.status}` };
		return { ...base, ok: true, error: null };
	} catch (e) {
		return {
			...base,
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

export interface SyncOnceResult {
	disabled: boolean;
	configError: string | null;
	outcomes: SyncOutcome[];
	skipped: string[];
}

/** One full sync pass: config → collect → per-target POST → cursor stamp
 *  only when EVERY target accepted the pass (partial passes re-send; the
 *  hub side is idempotent by topic-skip + upsert keys). */
export async function syncOnce(
	opts: {
		configPath?: string;
		statePath?: string;
		cwd?: string;
		dbPath?: string | null;
	} = {},
): Promise<SyncOnceResult> {
	const path = opts.configPath ?? SYNC_CONFIG_PATH();
	let config: SyncConfig | null = null;
	try {
		config = readSyncConfig(path);
	} catch (e) {
		return {
			disabled: false,
			configError: e instanceof Error ? e.message : String(e),
			outcomes: [],
			skipped: [],
		};
	}
	if (!config)
		return { disabled: true, configError: null, outcomes: [], skipped: [] };
	const statePath = opts.statePath ?? syncStatePath();
	const state = readSyncState(statePath);
	const collected = collectPayload(config, state, {
		cwd: opts.cwd,
		dbPath: opts.dbPath,
	});
	const outcomes: SyncOutcome[] = [];
	for (const target of config.targets) {
		if (target.hubId && target.hubId === config.localHub) continue;
		outcomes.push(await postTarget(target, collected.payload));
	}
	const allOk = outcomes.length > 0 && outcomes.every((o) => o.ok === true);
	if (allOk) {
		for (const f of collected.payload.facts) state.facts[f.key] = f.version;
		state.metricsAt = Date.now();
		writeSyncState(statePath, state);
	}
	return {
		disabled: false,
		configError: null,
		outcomes,
		skipped: collected.skipped,
	};
}
