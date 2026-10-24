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
import { redactMatches, scrubRules } from "./scrub.ts";
import {
	collectClaims,
	ROLL_KEY_HEADER,
	type RollEntry,
} from "./knowledge-roll.ts";

export interface SyncPayload {
	originHub: string;
	metrics: {
		days: StatsMetrics[];
		tools: StatsMetrics[];
		models: StatsMetrics[];
		sessions?: SessionMetrics[];
	};
	facts: SyncFact[];
	/** W1213: the CAS'd claim roll — posts to the target's knowledge-api
	 *  /roll face under the scoped TTL key, NOT the board ingest. */
	claims: RollEntry[];
}

/** W1226: the fact provenance record — evidence fields (the model's declared
 *  trigger/procedure/etc.) plus the SESSION-DERIVED repo/branch attribution.
 *  One shape across facts.ts, the sync payload, and the hub landing. */
export interface FactProvenance {
	trigger?: string;
	explanation?: string;
	procedure?: string;
	verification?: string;
	source_commit?: string;
	applicability?: string;
	repo?: string;
	branch?: string;
	session?: string;
}

export interface SyncFact {
	key: string;
	value: string;
	source: string | null;
	version: number;
	ts: number;
	/** W1226: the fact's provenance record, already scrubbed. Null when none. */
	prov: FactProvenance | null;
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
	/** W1213: versions of claim.* facts already accepted by every roll target */
	claims: Record<string, number>;
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
		const claims: Record<string, number> = {};
		if (s.claims && typeof s.claims === "object" && !Array.isArray(s.claims))
			for (const [k, v] of Object.entries(s.claims))
				if (typeof v === "number") claims[k] = v;
		return {
			facts,
			claims,
			metricsAt: typeof s.metricsAt === "number" ? s.metricsAt : 0,
		};
	} catch {
		return { facts: {}, claims: {}, metricsAt: 0 };
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

/** W1226: the provenance fields that cross the sync, with the per-field cap.
 *  Keys mirror the stored facts.provenance JSON exactly; anything else in the
 *  stored record never leaves the machine. */
export const PROVENANCE_KEYS = [
	"trigger",
	"explanation",
	"procedure",
	"verification",
	"source_commit",
	"applicability",
	"repo",
	"branch",
	"session",
] as const;
export const MAX_PROV_FIELD = 600;

/** Safe parse of a stored facts.provenance JSON string; null on absence or
 *  unparsable JSON (legacy rows, junk writes). Unknown keys drop; strings
 *  clamp at MAX_PROV_FIELD. */
export function parseProvenance(raw: string | null): FactProvenance | null {
	if (!raw) return null;
	try {
		const p: unknown = JSON.parse(raw);
		if (!p || typeof p !== "object" || Array.isArray(p)) return null;
		const out: FactProvenance = {};
		for (const [k, v] of Object.entries(p)) {
			if (!(PROVENANCE_KEYS as readonly string[]).includes(k)) continue;
			if (typeof v !== "string" || !v) continue;
			out[k as keyof FactProvenance] = v.slice(0, MAX_PROV_FIELD);
		}
		return out;
	} catch {
		return null;
	}
}

/** W1226 redact-before-remote: the OUTBOUND copy runs the W236 rule set —
 *  contextual leaks (home paths, LAN addrs, denylist hosts) get redacted from
 *  value and provenance fields before anything leaves the machine. No
 *  `scrub:allow` exemption applies here: the allow marker is a commit-gate
 *  escape hatch, never a transport one. (Key material upstream stays a hard
 *  skip via redactSecrets — redaction never launders a key.) */
export function scrubSyncFact(
	r: {
		key: string;
		value: string;
		source: string | null;
		version: number;
		ts: number;
	},
	provRaw: FactProvenance | null,
): SyncFact {
	const rules = scrubRules();
	const value = redactMatches(r.value, rules);
	const prov: FactProvenance | null = provRaw
		? Object.fromEntries(
				Object.entries(provRaw).map(([k, v]) => [
					k,
					typeof v === "string" ? redactMatches(v, rules) : v,
				]),
			)
		: null;
	return {
		key: r.key,
		value,
		source: r.source,
		version: r.version,
		ts: r.ts,
		prov,
	};
}

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
		// W1226: the provenance column rides the guarded-ALTER heal — but the
		// sync opens the db READONLY (no migration on that path), so a
		// pre-W1226 spoke db is legal. Probe the column once; legacy shapes
		// sync with prov null (parseProvenance tolerates absence).
		const hasProv = (
			db.query("PRAGMA table_info(facts)").all() as { name: string }[]
		).some((c) => c.name === "provenance");
		const rows = db
			.query(
				`SELECT key, value, source, version, ts${hasProv ? ", provenance" : ""} FROM facts WHERE key LIKE 'lesson.%' OR key LIKE 'finding.%' ORDER BY key`,
			)
			.all() as {
			key: string;
			value: string | null;
			source: string | null;
			version: number;
			ts: number;
			provenance?: string | null;
		}[];
		for (const r of rows) {
			if (!SYNCABLE_FACT.test(r.key)) continue;
			if (state.facts[r.key] === r.version) continue;
			// W1226: the provenance record rides the SAME verification chain —
			// a secret anywhere in value OR evidence skips the row (the evidence
			// never outranks the secret gate).
			const provRaw = parseProvenance(r.provenance ?? null);
			const provText = provRaw
				? Object.values(provRaw)
						.filter((v): v is string => typeof v === "string")
						.join("\n")
				: "";
			const red = redactSecrets(`${r.value ?? ""}\n${provText}`);
			if (!r.value) continue;
			if (r.value.length > MAX_FACT_VALUE) continue;
			if (red.rejected || red.hits.length > 0) {
				skipped.push(`${r.key}: secret pattern (${red.hits.join(", ")})`);
				continue;
			}
			send.push(scrubSyncFact(r, provRaw));
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
	/** W1213: facts-key → version for the collected claims (cursor fodder) */
	claimsCursor: Record<string, number>;
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
	const metrics: {
		days: StatsMetrics[];
		tools: StatsMetrics[];
		models: StatsMetrics[];
		sessions?: SessionMetrics[];
	} = { days: [], tools: [], models: [] };
	let decantOk = false;
	let facts: SyncFact[] = [];
	let claimsCursor: Record<string, number> = {};
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
	// W1213: the claim roll rides only when a roll-capable target exists —
	// collection without a destination is wasted redaction work.
	let claims: RollEntry[] = [];
	const rollTargets = config.targets.filter((t) => t.rollUrl && t.rollKeyFile);
	if (config.policy.claims && rollTargets.length > 0) {
		const cc = collectClaims(state, { dbPath: opts.dbPath });
		skipped.push(...cc.skipped);
		claims = cc.send;
		claimsCursor = cc.cursor;
	}
	return {
		payload: {
			originHub: config.localHub,
			metrics,
			facts,
			claims,
		},
		skipped,
		decantOk,
		claimsCursor,
	};
}

// ─── transport: the W491 relay posture ──────────────────────────────────────

const isNum = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

/** W1213.2: HTTP 200 alone is not acceptance — the cursor advances only on
 *  an explicit, validated positive ack MATCHED to the batch: body parses as
 *  an object, ok === true, fact counters account for every sent fact with
 *  none rejected, plus the landed metrics row count. Anything else — a
 *  rejected batch ({ok:false}, e.g. invalid confidence), an unparseable
 *  body, missing or mismatched counters — is a non-ack: the cursor is
 *  retained and the batch re-sends next pass (hub side idempotent by
 *  topic-skip, so the retry cannot duplicate rows). */
export function validateIngestAck(
	body: string,
	batch: { sentFacts: number; sentMetrics: number },
): { ok: boolean; error: string | null } {
	let ack: unknown;
	try {
		ack = JSON.parse(body);
	} catch {
		return { ok: false, error: "ingest ack unparseable" };
	}
	if (!ack || typeof ack !== "object" || Array.isArray(ack))
		return { ok: false, error: "ingest ack not an object" };
	const a = ack as Record<string, unknown>;
	if (a.ok !== true) {
		const why = typeof a.error === "string" ? a.error : "no positive ok flag";
		return { ok: false, error: `ingest ack not positive: ${why}` };
	}
	const c = a.counts as Record<string, unknown> | undefined;
	if (!c || typeof c !== "object" || Array.isArray(c))
		return { ok: false, error: "ingest ack carries no counters" };
	const f = c.facts as Record<string, unknown> | undefined;
	if (!f || typeof f !== "object" || Array.isArray(f))
		return { ok: false, error: "ingest ack carries no fact counters" };
	if (!isNum(f.landed) || !isNum(f.dupes) || !isNum(f.rejected))
		return { ok: false, error: "ingest ack fact counters not numeric" };
	if (f.rejected > 0)
		return { ok: false, error: `ingest ack rejects ${f.rejected} fact(s)` };
	const counted = f.landed + f.dupes + f.rejected;
	if (counted !== batch.sentFacts)
		return {
			ok: false,
			error: `ingest ack accounts for ${counted} of ${batch.sentFacts} sent facts`,
		};
	if (!isNum(c.metrics) || c.metrics !== batch.sentMetrics)
		return {
			ok: false,
			error: `ingest ack accounts for ${String(c.metrics)} of ${batch.sentMetrics} sent metrics rows`,
		};
	return { ok: true, error: null };
}

/** W1213.2.1: HTTP 200 alone is not acceptance on the roll face either —
 *  postRoll mirrors the ingest ack contract (W1213.2): the claims cursor
 *  advances only on an explicit, validated positive ack matched to the
 *  batch. The hub acks with counts {merged, versions, tombstoned, stale,
 *  dupes}; every entry lands in exactly one bucket except an idempotent
 *  no-op — the re-push of a retraction onto an already-tombstoned row counts
 *  nothing (exact-sum would wedge the cursor on a version-bumped re-set of
 *  the same retraction), so the counters must account for AT MOST the sent
 *  batch. Anything else — a rejected roll ({ok:false}, e.g. invalid claim
 *  entry), an unparseable body, a bare {ok:true} without counters,
 *  non-numeric counters, or counters exceeding the batch — is a non-ack: the
 *  cursor is retained and the roll re-sends next pass (hub side idempotent
 *  by claim hash + provenance, so the retry cannot duplicate rows). */
export function validateRollAck(
	body: string,
	batch: { sentClaims: number },
): { ok: boolean; error: string | null } {
	let ack: unknown;
	try {
		ack = JSON.parse(body);
	} catch {
		return { ok: false, error: "roll ack unparseable" };
	}
	if (!ack || typeof ack !== "object" || Array.isArray(ack))
		return { ok: false, error: "roll ack not an object" };
	const a = ack as Record<string, unknown>;
	if (a.ok !== true) {
		const why = typeof a.error === "string" ? a.error : "no positive ok flag";
		return { ok: false, error: `roll ack not positive: ${why}` };
	}
	const c = a.counts as Record<string, unknown> | undefined;
	if (!c || typeof c !== "object" || Array.isArray(c))
		return { ok: false, error: "roll ack carries no counts" };
	let counted = 0;
	for (const k of [
		"merged",
		"versions",
		"tombstoned",
		"stale",
		"dupes",
	] as const) {
		if (!isNum(c[k]))
			return { ok: false, error: `roll ack ${k} counter not numeric` };
		counted += c[k];
	}
	if (counted > batch.sentClaims)
		return {
			ok: false,
			error: `roll ack accounts for ${counted} of ${batch.sentClaims} sent claims`,
		};
	return { ok: true, error: null };
}

// ─── W1213: the upward claim roll (credential-free transport) ───────────────

export interface RollOutcome {
	target: string;
	ok: boolean;
	sentClaims: number;
	error: string | null;
}

/** One roll push: POST {rollUrl}/roll with the machine-scoped TTL key —
 *  the hub resolves provenance FROM the key, so the payload carries no
 *  identity at all. W1213.2.1: a 2xx status alone is not acceptance — only
 *  an explicit, validated, batch-matched positive ack advances the cursor. */
export async function postRoll(
	target: SyncTarget,
	claims: RollEntry[],
): Promise<RollOutcome> {
	const sent = claims.length;
	const base = { target: String(target.rollUrl), sentClaims: sent };
	const rollKeyFile = target.rollKeyFile;
	if (!target.rollUrl || !rollKeyFile)
		return { ...base, ok: false, error: "roll not configured" };
	try {
		const token = readSyncToken(rollKeyFile);
		const res = await fetch(`${target.rollUrl}/roll`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[ROLL_KEY_HEADER]: token,
			},
			body: JSON.stringify({ claims }),
		});
		if (!res.ok) return { ...base, ok: false, error: `HTTP ${res.status}` };
		// W1213.2.1: the roll seam gets the same ack validation as ingest —
		// a hub rejection delivered as HTTP 200 {ok:false} must retain the
		// cursor, never stamp it.
		const ack = validateRollAck(await res.text(), { sentClaims: sent });
		if (!ack.ok)
			return { ...base, ok: false, error: ack.error ?? "roll ack rejected" };
		return { ...base, ok: true, error: null };
	} catch (e) {
		return {
			...base,
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

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
		// W1213.2: a 2xx status alone is not acceptance — only an explicit,
		// validated, batch-matched positive ack advances the cursor.
		const ack = validateIngestAck(await res.text(), {
			sentFacts,
			sentMetrics,
		});
		if (!ack.ok)
			return { ...base, ok: false, error: ack.error ?? "ingest ack rejected" };
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
	const rollOutcomes: RollOutcome[] = [];
	for (const target of config.targets) {
		if (target.hubId && target.hubId === config.localHub) continue;
		outcomes.push(await postTarget(target, collected.payload));
		// W1213: roll-capable targets ALSO take the claim roll — the board
		// ingest and the knowledge-api roll are separate faces, separate auth.
		if (target.rollUrl && target.rollKeyFile)
			rollOutcomes.push(await postRoll(target, collected.payload.claims));
	}
	const allOk = outcomes.length > 0 && outcomes.every((o) => o.ok === true);
	if (allOk) {
		for (const f of collected.payload.facts) state.facts[f.key] = f.version;
		state.metricsAt = Date.now();
		writeSyncState(statePath, state);
	}
	// W1213: the claims cursor stamps only when EVERY roll-capable target
	// accepted the pass (partial passes re-send; the hub side is idempotent).
	const rollAllOk =
		rollOutcomes.length > 0 && rollOutcomes.every((o) => o.ok === true);
	if (rollAllOk) {
		Object.assign(state.claims, collected.claimsCursor);
		writeSyncState(statePath, state);
	}
	return {
		disabled: false,
		configError: null,
		outcomes,
		skipped: collected.skipped,
	};
}
