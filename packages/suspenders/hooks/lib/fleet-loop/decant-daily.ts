// hooks/lib/fleet-loop/decant-daily.ts — W1212: the daily decant→facts distiller.
//
// One pass: machine-local evidence (THIS machine's work graph rows + THIS
// machine's decant archive) → mechanical claims → content-addressed coord
// facts. The runner reads local stores only and never touches the network,
// so it is credential-free by construction and hub-executable (W1211).
// Machines never overlap: each store is machine-local — the first dedup.
//
// Degradation: a decant outage never blocks the work-store half — the pass
// degrades (work claims land, session tombstones defer) and the cursor
// holds, so the missed window re-collects next fire (CAS-idempotent). A
// dead work store is fatal: no evidence, no writes, no tombstones.
//
// Claims are content-addressed over (evidence-id + claim text):
//   key = decant.claim.<sha256(evidenceId \0 claim)[:16]>
// so an identical restatement hashes to an EXISTING key (CAS dedupe — the
// create is refused, zero duplicate claims) while a RESTATEMENT (changed
// text) hashes to a new key — claims version instead of colliding.
//
// Retraction rides tombstones, never deletion: evidence that vanished (a
// pruned archive session, an item that left DONE) has its claim re-stamped
// verdict=retracted — the row survives (log-compaction retention,
// latest-per-key wins); a returned evidence re-claims it fresh.
//
// Confidence mirrors the decant ingest floor (W950, decant/fleet/confidence.ts
// INGEST_STAMP): value 0.4, mechanical setter, verdict fresh — every write
// rides the fact-set CAS seam and appends to confidence_history.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { REG } from "../govdb/govdb-util.ts";
import { redactSecrets } from "../knowledge/knowledge.ts";
import {
	DECANT_DEFAULT_BIN,
	projectSessionMetrics,
	type SessionMetrics,
} from "../knowledge/knowledge-sync-policy.ts";
import { runDecant } from "../knowledge/knowledge-sync.ts";

// ─── the claim stamp + key ──────────────────────────────────────────────────

/** value/setter mirror decant/fleet/confidence.ts INGEST_STAMP (W950) with
 *  this runner's tool id; the verdict rides the lifecycle per write mode. */
export const DAILY_CLAIM_STAMP = {
	value: 0.4,
	setter: "mechanical:decant-daily",
	verdict: "fresh",
} as const;

/** Namespace every decant-daily fact lands in — the tombstone scan tracks
 *  it, and the knowledge-sync boundary gate (lesson.|finding. only) keeps
 *  the class machine-local (never crosses a hub boundary). */
export const CLAIM_PREFIX = "decant.claim.";

/** key = hash over (evidence-id + claim text) — 16 hex of sha256. */
export function claimKey(evidenceId: string, claim: string): string {
	const h = createHash("sha256")
		.update(`${evidenceId}\u0000${claim}`)
		.digest("hex")
		.slice(0, 16);
	return `${CLAIM_PREFIX}${h}`;
}

export interface DailyClaim {
	key: string;
	evidenceId: string;
	value: string;
}

// ─── evidence → claims (the distillation) ───────────────────────────────────

/** DONE work rows in the window → claims. The title passes the mechanical
 *  redaction gate before it lands anywhere; the result sha rides the claim
 *  so the completion is verifiable from the fact alone. */
export function distillWorkClaims(
	rows: {
		id: string;
		title: string;
		result_sha: string | null;
		updated_at: number;
	}[],
	windowStartMs: number,
): { claims: DailyClaim[]; skipped: string[] } {
	const claims: DailyClaim[] = [];
	const skipped: string[] = [];
	for (const r of rows) {
		if (r.updated_at < windowStartMs) continue;
		const evidenceId = `work:${r.id}`;
		const red = redactSecrets(r.title);
		if (red.rejected || red.hits.length > 0) {
			skipped.push(`${evidenceId}: secret pattern (${red.hits.join(", ")})`);
			continue;
		}
		const value = `done work item ${r.id} "${r.title}" → sha ${r.result_sha ?? "none"}`;
		claims.push({ key: claimKey(evidenceId, value), evidenceId, value });
	}
	return { claims, skipped };
}

/** decant ls rows (already projected to SessionMetrics — structural fields
 *  only) in the window → claims. The claim is a mechanical shape summary:
 *  tool/model/duration/counts/tokens — never title/project_path (the
 *  content deny is structural: the projector cannot emit content). */
export function distillSessionClaims(
	rows: SessionMetrics[],
	windowStartMs: number,
): { claims: DailyClaim[]; skipped: string[] } {
	const claims: DailyClaim[] = [];
	const skipped: string[] = [];
	for (const s of rows) {
		if (!s.sessionId || !s.endedAt) continue;
		const endedMs = Date.parse(s.endedAt);
		if (!Number.isFinite(endedMs) || endedMs < windowStartMs) continue;
		const evidenceId = `session:${s.sessionId}`;
		const dur =
			s.durationMs === null ? "-" : `${Math.round(s.durationMs / 1000)}s`;
		const value =
			`session ${s.tool ?? "-"} ${s.model ?? "-"} ran ${dur}, ` +
			`${s.messageCount ?? 0} msgs, ${s.inputTokens ?? 0}+${s.outputTokens ?? 0} tok`;
		claims.push({ key: claimKey(evidenceId, value), evidenceId, value });
	}
	return { claims, skipped };
}

// ─── the decision table (CAS dedupe / reclaim / tombstone) ─────────────────

export type WriteMode = "create" | "reclaim";

export interface ClaimWrite {
	claim: DailyClaim;
	mode: WriteMode;
}

export interface Tombstone {
	key: string;
	evidenceId: string;
	value: string;
}

export interface ClaimState {
	// current stamp verdict per fact key (null = row exists, no stamp)
	verdict: string | null;
	// the facts row's current value
	value: string | null;
}

export interface DecideResult {
	writes: ClaimWrite[];
	tombstones: Tombstone[];
	deduped: string[];
	/** merged inventory (existing ∪ this pass's writes) — the state stamp. */
	inventory: Record<string, InventoryEntry>;
}

export interface ExistingClaim {
	verdict: string | null;
	setter: string | null;
	value: string | null;
}

/** claim half of the table: create (absent) / reclaim (own retraction,
 *  evidence back) / dedupe (anything else — incl. a human-setter verdict,
 *  which a mechanical run never overwrites). */
function decideClaims(
	claims: DailyClaim[],
	existing: Record<string, ExistingClaim>,
	nowMs: number,
): {
	writes: ClaimWrite[];
	deduped: string[];
	inventory: Record<string, InventoryEntry>;
} {
	const writes: ClaimWrite[] = [];
	const deduped: string[] = [];
	const inventory: Record<string, InventoryEntry> = {};
	for (const c of claims) {
		const cur = existing[c.key];
		if (!cur) {
			writes.push({ claim: c, mode: "create" });
		} else if (
			cur.setter === DAILY_CLAIM_STAMP.setter &&
			cur.verdict === "retracted"
		) {
			writes.push({ claim: c, mode: "reclaim" });
		} else {
			deduped.push(c.key);
		}
		// deduped keys stay inventoried too: a claim written on a degraded
		// pass (cursor held) re-presents as a dedupe — the tombstone scan
		// must still track its evidence.
		inventory[c.key] = { evidenceId: c.evidenceId, ts: nowMs };
	}
	return { writes, deduped, inventory };
}

/** tombstone half: an inventoried row whose evidence no longer presents
 *  retracts (never deletes). Work evidence checks the live DONE set;
 *  session evidence trusts only an exact (untruncated) listing. */
function decideTombstones(
	state: DailyState,
	existing: Record<string, ExistingClaim>,
	claimed: Set<string>,
	presentEvidence: Set<string>,
	presenceExact: boolean,
): Tombstone[] {
	const tombstones: Tombstone[] = [];
	for (const [key, entry] of Object.entries(state.inventory)) {
		if (claimed.has(key)) continue;
		const cur = existing[key];
		if (!cur) continue;
		if (cur.setter !== DAILY_CLAIM_STAMP.setter) continue;
		if (cur.verdict === "retracted") continue;
		if (cur.value == null) continue;
		if (presentEvidence.has(entry.evidenceId)) continue;
		if (entry.evidenceId.startsWith("session:") && !presenceExact) continue;
		tombstones.push({ key, evidenceId: entry.evidenceId, value: cur.value });
	}
	return tombstones;
}

/** The decision table entry: claims half + tombstone half, one merged
 *  inventory. Creates are CAS create-only (--if-version 0) — a lost race
 *  against a concurrent run IS the dedupe, never a duplicate; a row this
 *  runner retracted comes back fresh when its evidence returns (reclaim);
 *  a human-setter verdict is never overwritten. */
export function decide(
	claims: DailyClaim[],
	existing: Record<string, ExistingClaim>,
	state: DailyState,
	presentEvidence: Set<string>,
	presenceExact: boolean,
	nowMs = Date.now(),
): DecideResult {
	const claimed = new Set(claims.map((c) => c.key));
	const half = decideClaims(claims, existing, nowMs);
	const tombstones = decideTombstones(
		state,
		existing,
		claimed,
		presentEvidence,
		presenceExact,
	);
	return {
		...half,
		tombstones,
		inventory: { ...state.inventory, ...half.inventory },
	};
}

// ─── the coord fact-set child (CAS seam) ────────────────────────────────────

/** argv for ONE fact write. Creates ride --if-version 0 (create-only CAS);
 *  reclaims re-stamp fresh; tombstones re-stamp retracted with the evidence
 *  as ref. Confidence/setter mirror DAILY_CLAIM_STAMP every time. */
export function factSetArgs(
	key: string,
	value: string,
	evidenceId: string,
	mode: "create" | "reclaim" | "tombstone",
): string[] {
	const args = [
		"fact",
		"set",
		key,
		"--text",
		value,
		"--source",
		"decant-daily",
		"--confidence",
		String(DAILY_CLAIM_STAMP.value),
		"--setter",
		DAILY_CLAIM_STAMP.setter,
		"--evidence",
		evidenceId,
	];
	if (mode === "create") args.push("--if-version", "0");
	else if (mode === "reclaim") args.push("--verdict", "fresh");
	else args.push("--verdict", "retracted", "--ref", evidenceId);
	return args;
}

export type FactSpawn = (
	cmd: string[],
	timeoutMs: number,
) => { code: number; out: string };

/** argv-array spawn — never a shell string. Output is the tail of the
 *  child's stdout+stderr (the CAS refusal line names the version). */
export const defaultFactSpawn: FactSpawn = (cmd, timeoutMs) => {
	const p = Bun.spawnSync(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});
	const out =
		`${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-3)
			.join(" | ");
	return { code: p.exitCode ?? 1, out };
};

/** coord bin next to this lib (repo worktree and installed generation
 *  share the hooks/lib → hooks/bin layout). */
export const decantCoordBin = (): string =>
	resolve(import.meta.dir, "../bin/coord.ts");

export interface DailyRunOpts {
	dbPath?: string | null;
	statePath?: string;
	decantBin?: string;
	cwd?: string;
	coordBin?: string;
	/** override the cursor window (ms back from now). */
	windowMs?: number;
	/** max fact children per run — bounds the fan-out. */
	limit?: number;
	dryRun?: boolean;
	now?: () => number;
	spawn?: FactSpawn;
}

export interface DailyRunResult {
	ok: boolean;
	windowStartMs: number;
	created: string[];
	deduped: string[];
	reclaimed: string[];
	tombstoned: string[];
	/** dry-run view: the decision (modes + keys) that would fire. */
	planned: string[];
	skipped: string[];
	errors: string[];
}

export const DAILY_LIMIT = 200;

type ApplyOutcome = {
	created: string[];
	reclaimed: string[];
	tombstoned: string[];
	deduped: string[];
	errors: string[];
};

/** fires the fact children. A create refused by the CAS (version moved —
 *  a concurrent run won) counts as dedupe, not failure. */
function applyFactWrites(
	spawn: FactSpawn,
	cmdOf: (args: string[]) => string[],
	writes: ClaimWrite[],
	tombstones: Tombstone[],
): ApplyOutcome {
	const r: ApplyOutcome = {
		created: [],
		reclaimed: [],
		tombstoned: [],
		deduped: [],
		errors: [],
	};
	for (const w of writes) {
		const res = spawn(
			cmdOf(
				factSetArgs(w.claim.key, w.claim.value, w.claim.evidenceId, w.mode),
			),
			60_000,
		);
		if (res.code === 0) {
			(w.mode === "create" ? r.created : r.reclaimed).push(w.claim.key);
		} else if (w.mode === "create" && res.out.includes("refused")) {
			r.deduped.push(w.claim.key);
		} else {
			r.errors.push(`${w.claim.key}: ${res.out.slice(0, 200)}`);
		}
	}
	for (const t of tombstones) {
		const res = spawn(
			cmdOf(factSetArgs(t.key, t.value, t.evidenceId, "tombstone")),
			60_000,
		);
		if (res.code === 0) r.tombstoned.push(t.key);
		else r.errors.push(`${t.key}: ${res.out.slice(0, 200)}`);
	}
	return r;
}

export interface CollectedDaily {
	claims: DailyClaim[];
	skipped: string[];
	presentEvidence: Set<string>;
	/** false when the session listing hit its cap — session tombstones defer. */
	presenceExact: boolean;
	/** the work-store leg answered — children may fire even when decant degraded. */
	workOk: boolean;
	errors: string[];
}

/** the machine-local collect + distill half of a run. */
export function collectDaily(
	windowStartMs: number,
	limit: number,
	opts: { dbPath?: string | null; decantBin?: string; cwd?: string } = {},
): CollectedDaily {
	const dbPath =
		opts.dbPath !== undefined ? opts.dbPath : `${REG()}/governor.db`;
	const bin = opts.decantBin ?? DECANT_DEFAULT_BIN;
	const cwd = opts.cwd ?? process.cwd();
	const out: CollectedDaily = {
		claims: [],
		skipped: [],
		presentEvidence: new Set(),
		presenceExact: true,
		workOk: false,
		errors: [],
	};
	const work = collectWorkRows(dbPath, windowStartMs);
	// the work leg is the fatal one: empty presence + dead store must never
	// reach the tombstone half (that would retract everything inventoried)
	out.workOk = work.error === null;
	if (work.error) out.errors.push(work.error);
	const sessions = collectSessions(bin, cwd);
	if (sessions.error) out.errors.push(sessions.error);
	// an errored listing is as inexact as a truncated one — tombstones defer
	out.presenceExact = sessions.error === null && !sessions.truncated;
	const workDistilled = distillWorkClaims(work.rows, windowStartMs);
	const sessDistilled = distillSessionClaims(sessions.sessions, windowStartMs);
	for (const e of work.doneIds) out.presentEvidence.add(`work:${e}`);
	for (const id of sessions.presentIds)
		out.presentEvidence.add(`session:${id}`);
	out.skipped.push(...workDistilled.skipped, ...sessDistilled.skipped);
	out.claims.push(...workDistilled.claims, ...sessDistilled.claims);
	if (out.claims.length > limit) {
		out.skipped.push(`+${out.claims.length - limit} beyond limit ${limit}`);
		out.claims.length = limit;
	}
	return out;
}

/** the decant.claim.* rows already in the store, stamps parsed. */
export function readExistingClaims(
	dbPath?: string | null,
): Record<string, ExistingClaim> {
	const path = dbPath !== undefined ? dbPath : `${REG()}/governor.db`;
	const existing: Record<string, ExistingClaim> = {};
	if (!path) return existing;
	let db: Database | null = null;
	try {
		db = new Database(path, { readonly: true, create: false });
	} catch {
		return existing;
	}
	try {
		const rows = db
			.query(
				"SELECT key, value, confidence_stamp FROM facts WHERE key LIKE 'decant.claim.%'",
			)
			.all() as {
			key: string;
			value: string | null;
			confidence_stamp: string | null;
		}[];
		for (const row of rows) existing[row.key] = stampOf(row);
	} catch {
		// missing facts table → empty map
	} finally {
		if (db) db.close();
	}
	return existing;
}

function stampOf(row: {
	value: string | null;
	confidence_stamp: string | null;
}): ExistingClaim {
	let stamp: { verdict?: string; setter?: string } | null = null;
	try {
		stamp = row.confidence_stamp
			? (JSON.parse(row.confidence_stamp) as {
					verdict?: string;
					setter?: string;
				})
			: null;
	} catch {
		stamp = null;
	}
	return {
		verdict: stamp?.verdict ?? null,
		setter: stamp?.setter ?? null,
		value: row.value,
	};
}

function emptyResult(windowStartMs: number): DailyRunResult {
	return {
		ok: false,
		windowStartMs,
		created: [],
		deduped: [],
		reclaimed: [],
		tombstoned: [],
		planned: [],
		skipped: [],
		errors: [],
	};
}

/** the write half: fire the fact children — never on dry-run or a dead work
 *  store; a decant outage DEGRADES the pass (work claims still land, session
 *  tombstones defer via the inexact presence flag). The cursor/inventory
 *  advance only on a clean pass: a degraded pass re-collects next fire, and
 *  CAS dedupe keeps the re-fires duplicate-free. */
function applyDaily(
	state: DailyState,
	statePath: string,
	decision: DecideResult,
	r: DailyRunResult,
	opts: DailyRunOpts,
	nowMs: number,
	workOk: boolean,
): void {
	r.deduped = decision.deduped;
	if (opts.dryRun || !workOk) return;
	const bun = process.execPath;
	const coordBin = opts.coordBin ?? decantCoordBin();
	const applied = applyFactWrites(
		opts.spawn ?? defaultFactSpawn,
		(args) => [bun, coordBin, ...args],
		decision.writes,
		decision.tombstones,
	);
	r.created = applied.created;
	r.reclaimed = applied.reclaimed;
	r.tombstoned = applied.tombstoned;
	r.deduped = [...decision.deduped, ...applied.deduped];
	r.errors.push(...applied.errors);
	const clean = r.errors.length === 0;
	writeState(statePath, {
		lastRunMs: clean ? nowMs : state.lastRunMs,
		inventory: clean ? decision.inventory : state.inventory,
	});
}

/** One daily pass: cursor → window → collect → decide → children → stamp.
 *  Cursor advances only on a clean pass (failure re-collects, CAS-idempotent). */
export function runDaily(opts: DailyRunOpts = {}): DailyRunResult {
	const nowMs = (opts.now ?? Date.now)();
	const statePath = opts.statePath ?? decantDailyStatePath();
	const state = readState(statePath);
	const windowStartMs =
		opts.windowMs !== undefined
			? nowMs - opts.windowMs
			: state.lastRunMs > 0
				? state.lastRunMs
				: nowMs - 24 * 3600_000;
	const limit = opts.limit ?? DAILY_LIMIT;
	const r = emptyResult(windowStartMs);
	const collected = collectDaily(windowStartMs, limit, {
		dbPath: opts.dbPath,
		decantBin: opts.decantBin,
		cwd: opts.cwd,
	});
	r.skipped.push(...collected.skipped);
	r.errors.push(...collected.errors);
	const decision = decide(
		collected.claims,
		readExistingClaims(opts.dbPath),
		state,
		collected.presentEvidence,
		collected.presenceExact,
		nowMs,
	);
	for (const w of decision.writes) r.planned.push(`${w.mode}:${w.claim.key}`);
	for (const t of decision.tombstones) r.planned.push(`tombstone:${t.key}`);
	applyDaily(state, statePath, decision, r, opts, nowMs, collected.workOk);
	r.ok = r.errors.length === 0;
	return r;
}

// ─── machine-local state: the cursor + the claim inventory ──────────────────

export interface InventoryEntry {
	evidenceId: string;
	ts: number;
}

/** 0600 cursor + inventory: lastRunMs windows the next collect; inventory
 *  maps every key this runner wrote to its evidenceId — the bounded,
 *  exact candidate set for the tombstone scan. */
export interface DailyState {
	lastRunMs: number;
	inventory: Record<string, InventoryEntry>;
}

export const decantDailyStatePath = (): string =>
	process.env.SUSPENDERS_DECANT_DAILY_STATE ??
	join(homedir(), ".claude-insights", "decant-daily-state.json");

export function readState(path: string): DailyState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return { lastRunMs: 0, inventory: {} };
		const s = parsed as Record<string, unknown>;
		const inventory: Record<string, InventoryEntry> = {};
		if (
			s.inventory &&
			typeof s.inventory === "object" &&
			!Array.isArray(s.inventory)
		)
			for (const [k, v] of Object.entries(s.inventory)) {
				if (!v || typeof v !== "object" || Array.isArray(v)) continue;
				const e = v as Record<string, unknown>;
				if (typeof e.evidenceId === "string" && typeof e.ts === "number")
					inventory[k] = { evidenceId: e.evidenceId, ts: e.ts };
			}
		return {
			lastRunMs: typeof s.lastRunMs === "number" ? s.lastRunMs : 0,
			inventory,
		};
	} catch {
		return { lastRunMs: 0, inventory: {} };
	}
}

export function writeState(path: string, state: DailyState): void {
	try {
		writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`, {
			mode: 0o600,
		});
	} catch {
		// the cursor is a window hint, not a ledger — a failed stamp just
		// widens the next window; CAS dedupe keeps the re-collect idempotent
	}
}

// ─── collect: machine-local evidence ────────────────────────────────────────

export interface WorkRow {
	id: string;
	title: string;
	result_sha: string | null;
	updated_at: number;
}

export interface CollectedWork {
	rows: WorkRow[];
	/** every DONE id, window-less — the work-evidence presence oracle. */
	doneIds: Set<string>;
	error: string | null;
}

/** THIS machine's DONE work rows: windowed for claims, full DONE set for
 *  presence. Readonly open, fail-soft (error note; sessions still distill). */
export function collectWorkRows(
	dbPath: string | null,
	windowStartMs: number,
): CollectedWork {
	const out: CollectedWork = { rows: [], doneIds: new Set(), error: null };
	if (!dbPath) {
		out.error = "work store unavailable";
		return out;
	}
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true, create: false });
	} catch {
		out.error = "work store not readable";
		return out;
	}
	try {
		out.rows = db
			.query(
				"SELECT id, title, result_sha, updated_at FROM work_items WHERE state = 'DONE' AND updated_at >= ? ORDER BY updated_at",
			)
			.all(windowStartMs) as WorkRow[];
		const ids = db
			.query("SELECT id FROM work_items WHERE state = 'DONE'")
			.all() as { id: string }[];
		for (const r of ids) out.doneIds.add(r.id);
	} catch (e) {
		out.error = `work store query failed: ${e instanceof Error ? e.message : String(e)}`;
	} finally {
		if (db) db.close();
	}
	return out;
}

export interface CollectedSessions {
	sessions: SessionMetrics[];
	/** every listed session id, window-less — session-evidence presence. */
	presentIds: Set<string>;
	/** true when the listing hit its cap — presence then inexact: the
	 *  session tombstone pass is skipped rather than retract on a cut view. */
	truncated: boolean;
	error: string | null;
}

export const SESSION_LS_CAP = 5000;

/** decant archive listing — machine-local, headless (ls only, never
 *  export/show/search), window-less for the presence oracle. */
export function collectSessions(
	bin: string,
	cwd: string,
	limit = SESSION_LS_CAP,
): CollectedSessions {
	const out: CollectedSessions = {
		sessions: [],
		presentIds: new Set(),
		truncated: false,
		error: null,
	};
	const fail = (msg: string): CollectedSessions => {
		out.error = msg;
		return out;
	};
	const sync = runDecant(bin, ["sync", "-q"], cwd);
	if (sync.code !== 0)
		return fail(`decant sync failed: ${sync.stderr.slice(0, 200)}`);
	const r = runDecant(
		bin,
		["ls", "--json", "--limit", String(limit), "--no-sync"],
		cwd,
	);
	if (r.code !== 0) return fail(`decant ls failed: ${r.stderr.slice(0, 200)}`);
	let rows: unknown;
	try {
		rows = JSON.parse(r.stdout);
	} catch {
		return fail("decant ls: unparseable output");
	}
	if (!Array.isArray(rows)) return fail("decant ls: not a list");
	out.truncated = rows.length >= limit;
	absorbSessionRows(rows, out);
	return out;
}

/** row projection into the collector: opaque ids into the presence set,
 *  structural metrics into the claim feed. */
function absorbSessionRows(rows: unknown[], out: CollectedSessions): void {
	for (const row of rows) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const m = projectSessionMetrics(row as Record<string, unknown>);
		if (m.sessionId) out.presentIds.add(m.sessionId);
		out.sessions.push(m);
	}
}
