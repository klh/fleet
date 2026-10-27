// hooks/lib/fleet-loop/decant-daily.ts — W1212: the daily decant→facts distiller.
// W1212.1: evidence is project-scoped and machine-stamped, collection rides
// the canonical store port (never a raw DB file), and the collection cursor
// is bounded — it advances only to the LAST PROCESSED claim's position, so
// a capped pass resumes instead of stranding unprocessed claims.
//
// One pass: THIS project's work-graph rows + THIS machine's decant archive
// → mechanical claims → content-addressed coord facts. Work rows come off
// the canonical GovernorStore port (GOVERNOR_STORE_URL → store.url →
// in-process), scoped WHERE project = ?; the decant archive stays a local
// headless ls. Credential-free by construction, hub-executable (W1211).
//
// Evidence identity includes project + origin (FAIL61346: work ids collide
// across projects — work_items is keyed (project, id), so a bare
// `work:<id>` evidence id made two projects' identical ids CAS-dedupe each
// other's REAL evidence away):
//   work:<projectKey>:<host>:<id>   session:<host>:<sessionId>
//
// The cursor (W1212.1) stores ONLY last-processed stream positions, per
// stream, in tuple order (row ts, row id); the next feed resumes strictly
// after it. A pass capped by --limit advances the cursor to the cut, never
// past unprocessed rows — the limit-2-of-4 rerun proof: run → 2 land,
// rerun → the remaining 2 land, nothing skipped forever.
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
//
// W1212.2 fence (FAIL61346 B3): EVERY write mode is version-pinned — creates
// ride --if-version 0 (create-only), reclaims and tombstones pin the EXACT
// version read this pass, so a human or newer edit that lands between the
// read and the write refuses the child instead of being overwritten. A
// stale refusal is a first-class outcome (never an error, never a silent
// overwrite): the pass holds its cursor and the next fire re-reads and
// re-decides on the moved row.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { type DailyRollResult, pushDailyRoll } from "../knowledge/decant-roll.ts";
import { projectIdentity, projectRootOf } from "../govdb/govdb-project.ts";
import { openStore } from "../govdb/govdb-store.ts";
import { REG } from "../govdb/govdb-util.ts";
import { redactSecrets } from "../knowledge/knowledge.ts";
import { runDecant } from "../knowledge/knowledge-sync.ts";
import {
	DECANT_DEFAULT_BIN,
	projectSessionMetrics,
	type SessionMetrics,
} from "../knowledge/knowledge-sync-policy.ts";

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
	/** stream position of the evidence row — the cursor advances only to
	 *  the LAST PROCESSED claim's position, never past unprocessed rows. */
	pos?: CursorPos;
}

// ─── evidence identity: project + origin provenance (W1212.1) ───────────────

/** machine provenance of every claim this runner stamps (os hostname — the
 *  same vocabulary the graph's `origin "<host>:<agent>"` stamps use). */
export const evidenceHost = (): string => hostname();

/** stable compound evidence id — project-scoped, host-stamped. Bare
 *  `work:<id>` collided across projects (work_items is keyed (project, id));
 *  the full project key in the id makes cross-project collision impossible. */
export function workEvidenceId(
	project: string,
	host: string,
	id: string,
): string {
	return `work:${project}:${host}:${id}`;
}

/** session ids are unique per machine, so host + opaque id is the stable
 *  session evidence identity (sessions carry no project axis). */
export function sessionEvidenceId(host: string, sessionId: string): string {
	return `session:${host}:${sessionId}`;
}

/** readable repo tail for claim values — provenance at a glance; uniqueness
 *  rides the FULL project key inside the evidence id, never this slug. */
export function projectSlug(project: string): string {
	return projectRootOf(project).split("/").filter(Boolean).pop() ?? project;
}

/** a stream position: (row ts, row id) — the total order the cursor
 *  resumes by. ts = updated_at (work) or endedAt-ms (session). */
export interface CursorPos {
	ts: number;
	id: string;
}

/** bounded collection cursor — ONLY last-processed positions, per stream.
 *  The next feed resumes strictly after it; absent/null = initial window. */
export interface DailyCursor {
	work: CursorPos | null;
	session: CursorPos | null;
}

// ─── evidence → claims (the distillation) ───────────────────────────────────

/** THIS project's DONE work rows → claims. The title passes the mechanical
 *  redaction gate before it lands anywhere; the result sha rides the claim
 *  so the completion is verifiable from the fact alone. Rows arrive in
 *  cursor order (updated_at, id) off the store port. */
export function distillWorkClaims(
	rows: {
		id: string;
		title: string;
		result_sha: string | null;
		updated_at: number;
	}[],
	prov: { project: string; host: string },
	windowStartMs: number,
): { claims: DailyClaim[]; skipped: string[] } {
	const claims: DailyClaim[] = [];
	const skipped: string[] = [];
	for (const r of rows) {
		if (r.updated_at < windowStartMs) continue;
		const evidenceId = workEvidenceId(prov.project, prov.host, r.id);
		const red = redactSecrets(r.title);
		if (red.rejected || red.hits.length > 0) {
			skipped.push(`${evidenceId}: secret pattern (${red.hits.join(", ")})`);
			continue;
		}
		const value = `done work item ${r.id} (${projectSlug(prov.project)}) "${r.title}" → sha ${r.result_sha ?? "none"}`;
		claims.push({
			key: claimKey(evidenceId, value),
			evidenceId,
			value,
			pos: { ts: r.updated_at, id: r.id },
		});
	}
	return { claims, skipped };
}

/** decant ls rows (already projected to SessionMetrics — structural fields
 *  only) in the window → claims. The claim is a mechanical shape summary:
 *  tool/model/duration/counts/tokens — never title/project_path (the
 *  content deny is structural: the projector cannot emit content). */
export function distillSessionClaims(
	rows: SessionMetrics[],
	prov: { host: string },
	windowStartMs: number,
): { claims: DailyClaim[]; skipped: string[] } {
	const claims: DailyClaim[] = [];
	const skipped: string[] = [];
	for (const s of rows) {
		if (!s.sessionId || !s.endedAt) continue;
		const endedMs = Date.parse(s.endedAt);
		if (!Number.isFinite(endedMs) || endedMs < windowStartMs) continue;
		const evidenceId = sessionEvidenceId(prov.host, s.sessionId);
		const dur =
			s.durationMs === null ? "-" : `${Math.round(s.durationMs / 1000)}s`;
		const value =
			`session ${s.tool ?? "-"} ${s.model ?? "-"} ran ${dur}, ` +
			`${s.messageCount ?? 0} msgs, ${s.inputTokens ?? 0}+${s.outputTokens ?? 0} tok`;
		claims.push({
			key: claimKey(evidenceId, value),
			evidenceId,
			value,
			pos: { ts: endedMs, id: s.sessionId },
		});
	}
	return { claims, skipped };
}

// ─── the decision table (CAS dedupe / reclaim / tombstone) ─────────────────

export type WriteMode = "create" | "reclaim";

export interface ClaimWrite {
	claim: DailyClaim;
	mode: WriteMode;
	/** the fact row version this decision pinned — creates expect 0
	 *  (create-only), reclaims the version read this pass. */
	expectedVersion: number;
}

export interface Tombstone {
	key: string;
	evidenceId: string;
	value: string;
	/** the fact row version read this pass — the exact CAS pin. */
	expectedVersion: number;
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
	/** the facts row version at read time — the exact CAS pin for
	 *  reclaim/tombstone (FAIL61346 B3: reads that omit version cannot
	 *  fence their writes). */
	version: number | null;
}

/** claim half of the table: create (absent) / reclaim (own retraction,
 *  evidence back) / dedupe (anything else — incl. a human-setter verdict,
 *  which a mechanical run never overwrites). Reclaims pin the read version
 *  (exact CAS): a row that moved between read and write refuses the child. */
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
			writes.push({ claim: c, mode: "create", expectedVersion: 0 });
		} else if (
			cur.setter === DAILY_CLAIM_STAMP.setter &&
			cur.verdict === "retracted" &&
			cur.version != null
		) {
			// a row without a readable version stays deduped: no pin, no write
			writes.push({ claim: c, mode: "reclaim", expectedVersion: cur.version });
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
 *  session evidence trusts only an exact (untruncated) listing. A row
 *  without a readable version is never retracted — no pin, no write. */
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
		if (cur.value == null || cur.version == null) continue;
		if (presentEvidence.has(entry.evidenceId)) continue;
		if (entry.evidenceId.startsWith("session:") && !presenceExact) continue;
		tombstones.push({
			key,
			evidenceId: entry.evidenceId,
			value: cur.value,
			expectedVersion: cur.version,
		});
	}
	return tombstones;
}

/** The decision table entry: claims half + tombstone half, one merged
 *  inventory. Creates are CAS create-only (--if-version 0) — a lost race
 *  against a concurrent run IS the dedupe, never a duplicate; a row this
 *  runner retracted comes back fresh when its evidence returns (reclaim);
 *  a human-setter verdict is never overwritten. Reclaims and tombstones
 *  pin the version read THIS pass (W1212.2): a row that moved between the
 *  read and the write refuses the child — the human/newer edit survives. */
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

/** argv for ONE fact write. EVERY mode is version-pinned (W1212.2): creates
 *  ride --if-version 0 (create-only CAS); reclaims re-stamp fresh and
 *  tombstones re-stamp retracted with the evidence as ref — both pin the
 *  EXACT version the decision read, so a human/newer edit that lands in
 *  between refuses the child. Confidence/setter mirror DAILY_CLAIM_STAMP. */
export function factSetArgs(
	key: string,
	value: string,
	evidenceId: string,
	mode: "create" | "reclaim" | "tombstone",
	expectedVersion: number,
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
	else if (mode === "reclaim")
		args.push("--if-version", String(expectedVersion), "--verdict", "fresh");
	else
		args.push(
			"--if-version",
			String(expectedVersion),
			"--verdict",
			"retracted",
			"--ref",
			evidenceId,
		);
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
		// explicit env: Bun children inherit the START-time environ, never the
		// live process.env — a store redirect (GOVERNOR_STORE_URL) set after
		// start silently never reaches the child (W1212.2 fixture catch)
		env: { ...process.env },
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

/** coord bin above this seam dir (repo worktree and installed generation
 *  share the hooks/lib/<seam> → hooks/bin layout). */
export const decantCoordBin = (): string =>
	resolve(import.meta.dir, "../../bin/coord.ts");

export interface DailyRunOpts {
	dbPath?: string | null;
	statePath?: string;
	decantBin?: string;
	cwd?: string;
	coordBin?: string;
	/** collection store — the canonical GovernorStore port (defaults to
	 *  openStore(): GOVERNOR_STORE_URL → store.url → in-process). */
	store?: DailyStore | null;
	/** project scope override (default projectIdentity(cwd)). */
	project?: string;
	/** machine provenance override (default os hostname). */
	host?: string;
	/** INITIAL lookback (ms back from now) before a cursor exists. */
	windowMs?: number;
	/** max fact children per run — bounds the fan-out. */
	limit?: number;
	dryRun?: boolean;
	/** W1220: fire the upward roll post-pass after the local writes (the
	 *  bin turns it on; callers without it stay local-only — tests and the
	 *  lib default never touch the network). The object form pins the roll
	 *  pass's config/state paths (tests); true uses the machine defaults. */
	roll?: boolean | { configPath?: string; statePath?: string };
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
	/** CAS-refused stale writes (W1212.2) — dirty for the state stamp. */
	stale: string[];
	/** dry-run view: the decision (modes + keys) that would fire. */
	planned: string[];
	skipped: string[];
	errors: string[];
	/** W1220: the upward roll post-pass outcome — present only when the
	 *  pass was requested (opts.roll) and not a dry run. Its errors NEVER
	 *  touch `ok` (the exit code stays the LOCAL result only). */
	roll?: DailyRollResult;
}

export const DAILY_LIMIT = 200;

type ApplyOutcome = {
	created: string[];
	reclaimed: string[];
	tombstoned: string[];
	deduped: string[];
	/** CAS-refused stale writes (W1212.2 seam) — a lost race, never an error;
	 *  stale holds the state stamp. Seeded by this module, classified by the
	 *  canonical version-CAS seam. */
	stale: string[];
	errors: string[];
};

/** fires the fact children. A create refused by the CAS (version moved —
 *  a concurrent run won) counts as dedupe, not failure; a reclaim or
 *  tombstone refused counts as stale — the fence doing its job, never an
 *  overwrite. Any other non-zero exit is an error. */
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
		stale: [],
		errors: [],
	};
	for (const w of writes) {
		const res = spawn(
			cmdOf(
				factSetArgs(
					w.claim.key,
					w.claim.value,
					w.claim.evidenceId,
					w.mode,
					w.expectedVersion,
				),
			),
			60_000,
		);
		if (res.code === 0) {
			(w.mode === "create" ? r.created : r.reclaimed).push(w.claim.key);
		} else if (res.out.includes("refused")) {
			if (w.mode === "create") r.deduped.push(w.claim.key);
			else r.stale.push(w.claim.key);
		} else {
			r.errors.push(`${w.claim.key}: ${res.out.slice(0, 200)}`);
		}
	}
	for (const t of tombstones) {
		const res = spawn(
			cmdOf(
				factSetArgs(
					t.key,
					t.value,
					t.evidenceId,
					"tombstone",
					t.expectedVersion,
				),
			),
			60_000,
		);
		if (res.code === 0) r.tombstoned.push(t.key);
		else if (res.out.includes("refused")) r.stale.push(t.key);
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
	/** last-processed positions per stream — the ONLY thing the cursor may
	 *  advance to. A limit cut lands here, never past unprocessed rows. */
	cursor: DailyCursor;
}

/** the collect + distill half of a run: THIS project's work rows off the
 *  canonical store port, THIS machine's decant archive, one bounded feed. */
export function collectDaily(
	prov: { project: string; host: string },
	limit: number,
	opts: {
		store: DailyStore | null;
		cursor?: DailyCursor;
		workStartMs: number;
		sessStartMs: number;
		decantBin?: string;
		cwd?: string;
	},
): CollectedDaily {
	const bin = opts.decantBin ?? DECANT_DEFAULT_BIN;
	const cwd = opts.cwd ?? process.cwd();
	const out: CollectedDaily = {
		claims: [],
		skipped: [],
		presentEvidence: new Set(),
		presenceExact: true,
		workOk: false,
		errors: [],
		cursor: {
			work: opts.cursor?.work ?? null,
			session: opts.cursor?.session ?? null,
		},
	};
	const work = collectWorkRows(opts.store, prov, {
		cursor: opts.cursor?.work ?? null,
		windowStartMs: opts.workStartMs,
	});
	// the work leg is the fatal one: empty presence + dead store must never
	// reach the tombstone half (that would retract everything inventoried)
	out.workOk = work.error === null;
	if (work.error) out.errors.push(work.error);
	const sessions = collectSessions(bin, cwd);
	if (sessions.error) out.errors.push(sessions.error);
	// an errored listing is as inexact as a truncated one — tombstones defer
	out.presenceExact = sessions.error === null && !sessions.truncated;
	const workDistilled = distillWorkClaims(work.rows, prov, opts.workStartMs);
	const sessDistilled = distillSessionClaims(
		sessions.sessions,
		prov,
		opts.sessStartMs,
	);
	for (const e of work.doneIds) {
		out.presentEvidence.add(workEvidenceId(prov.project, prov.host, e));
	}
	for (const id of sessions.presentIds) {
		out.presentEvidence.add(sessionEvidenceId(prov.host, id));
	}
	out.skipped.push(...workDistilled.skipped, ...sessDistilled.skipped);
	// one bounded feed, work stream first: the limit cut falls where it
	// falls, and the cursor records the LAST PROCESSED position per stream
	// so the next fire resumes instead of stranding the unprocessed tail.
	const nWork = Math.min(workDistilled.claims.length, limit);
	const nSess = Math.min(
		sessDistilled.claims.length,
		Math.max(0, limit - nWork),
	);
	out.claims.push(
		...workDistilled.claims.slice(0, nWork),
		...sessDistilled.claims.slice(0, nSess),
	);
	const total = workDistilled.claims.length + sessDistilled.claims.length;
	if (total > limit) {
		out.skipped.push(
			`+${total - limit} beyond limit ${limit} — cursor resumes next fire`,
		);
	}
	const lastWork = workDistilled.claims[nWork - 1];
	if (lastWork?.pos) out.cursor.work = lastWork.pos;
	const lastSess = sessDistilled.claims[nSess - 1];
	if (lastSess?.pos) out.cursor.session = lastSess.pos;
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
				"SELECT key, value, version, confidence_stamp FROM facts WHERE key LIKE 'decant.claim.%'",
			)
			.all() as {
			key: string;
			value: string | null;
			version: number | null;
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
	version: number | null;
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
		version: row.version,
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
		stale: [],
		planned: [],
		skipped: [],
		errors: [],
	};
}

/** the write half: fire the fact children — never on dry-run or a dead work
 *  store; a decant outage DEGRADES the pass (work claims still land, session
 *  tombstones defer via the inexact presence flag). Outcome classification
 *  only — the clean/dirty STATE STAMP lives in runDaily (cursor + inventory
 *  advance together, or nothing advances). */
function applyDaily(
	decision: DecideResult,
	r: DailyRunResult,
	opts: DailyRunOpts,
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
	r.stale = applied.stale;
	r.errors.push(...applied.errors);
}

/** One daily pass: state → windows → collect → decide → children → stamp.
 *  The state stamp (lastRunMs + inventory + CURSOR) advances only on a
 *  clean pass (errors 0 && stale 0): a dirty pass leaves the file alone —
 *  the next fire re-collects, CAS-idempotent.
 *  W1220: with opts.roll the upward roll post-pass rides AFTER the local
 *  writes — fail-open, its errors never touch the local result's ok. */
export async function runDaily(
	opts: DailyRunOpts = {},
): Promise<DailyRunResult> {
	const nowMs = (opts.now ?? Date.now)();
	const statePath = opts.statePath ?? decantDailyStatePath();
	const state = readState(statePath);
	const initialStart = nowMs - (opts.windowMs ?? 24 * 3600_000);
	const workStartMs = state.cursor?.work?.ts ?? initialStart;
	const sessStartMs = state.cursor?.session?.ts ?? initialStart;
	const limit = opts.limit ?? DAILY_LIMIT;
	const r = emptyResult(Math.min(workStartMs, sessStartMs));
	const store = opts.store !== undefined ? opts.store : openStore();
	const collected = collectDaily(
		{
			project: opts.project ?? projectIdentity(opts.cwd ?? process.cwd()),
			host: opts.host ?? evidenceHost(),
		},
		limit,
		{
			store,
			cursor: state.cursor,
			workStartMs,
			sessStartMs,
			decantBin: opts.decantBin,
			cwd: opts.cwd,
		},
	);
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
	applyDaily(decision, r, opts, collected.workOk);
	r.ok = r.errors.length === 0 && r.stale.length === 0;
	if (!opts.dryRun && r.ok) {
		// clean-pass stamp: the cursor advances to the last-processed
		// positions only — a capped cut resumes, nothing strands
		writeState(statePath, {
			lastRunMs: nowMs,
			inventory: decision.inventory,
			cursor: collected.cursor,
		});
	}
	// W1220 dual-write: the LOCAL result is already banked; the upward roll
	// rides after it — a sink outage lands in r.roll.errors and the next
	// daily run retries; the local ok/exit never moves.
	if (opts.roll && !opts.dryRun) {
		const roll = typeof opts.roll === "object" ? opts.roll : {};
		r.roll = await pushDailyRoll({ dbPath: opts.dbPath, ...roll });
	}
	return r;
}

// ─── machine-local state: the cursor + the claim inventory ──────────────────

export interface InventoryEntry {
	evidenceId: string;
	ts: number;
}

/** 0600 cursor + inventory: the collection cursor carries ONLY the
 *  last-processed stream positions (the next feed resumes after them);
 *  lastRunMs is a write-only freshness stamp, never a window. Inventory
 *  maps every key this runner wrote to its evidenceId — the bounded,
 *  exact candidate set for the tombstone scan. */
export interface DailyState {
	lastRunMs: number;
	inventory: Record<string, InventoryEntry>;
	cursor?: DailyCursor;
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
		const st: DailyState = {
			lastRunMs: typeof s.lastRunMs === "number" ? s.lastRunMs : 0,
			inventory,
		};
		const cursor = parseCursor(s.cursor);
		if (cursor) st.cursor = cursor;
		return st;
	} catch {
		return { lastRunMs: 0, inventory: {} };
	}
}

/** tolerant cursor parse: keep the valid halves, drop the field entirely
 *  when neither stream position survives (absent = initial window). */
function parseCursor(v: unknown): DailyCursor | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const c = v as Record<string, unknown>;
	const work = posOf(c.work);
	const sess = posOf(c.session);
	if (!work && !sess) return undefined;
	return { work, session: sess };
}

function posOf(v: unknown): CursorPos | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const p = v as Record<string, unknown>;
	return typeof p.ts === "number" && typeof p.id === "string"
		? { ts: p.ts, id: p.id }
		: null;
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
	/** every DONE id in THIS project, window-less — presence oracle. */
	doneIds: Set<string>;
	error: string | null;
}

/** structural slice of the canonical GovernorStore port this module reads
 *  through — a bun:sqlite Database satisfies it, and so does the HTTP
 *  binding, so collection rides GOVERNOR_STORE_URL / store.url unchanged
 *  (W92: consumers bind to the store, never to a DB file path). */
export interface DailyStore {
	query(sql: string): {
		all(...params: unknown[]): unknown[];
	};
}

/** THIS project's DONE work rows through the CANONICAL store port: feed =
 *  the cursor-resumable claim window in tuple order (updated_at, id),
 *  presence = the full project DONE set. Fail-soft (error note; sessions
 *  still distill); never opens a raw DB file. */
export function collectWorkRows(
	store: DailyStore | null,
	prov: { project: string; host: string },
	feed: { cursor: CursorPos | null; windowStartMs: number },
): CollectedWork {
	const out: CollectedWork = { rows: [], doneIds: new Set(), error: null };
	if (!store) {
		out.error = "work store unavailable";
		return out;
	}
	try {
		out.rows = (
			feed.cursor
				? store
						.query(
							"SELECT id, title, result_sha, updated_at FROM work_items WHERE state = 'DONE' AND project = ? AND (updated_at > ? OR (updated_at = ? AND id > ?)) ORDER BY updated_at, id",
						)
						.all(prov.project, feed.cursor.ts, feed.cursor.ts, feed.cursor.id)
				: store
						.query(
							"SELECT id, title, result_sha, updated_at FROM work_items WHERE state = 'DONE' AND project = ? AND updated_at >= ? ORDER BY updated_at, id",
						)
						.all(prov.project, feed.windowStartMs)
		) as WorkRow[];
		const ids = store
			.query("SELECT id FROM work_items WHERE state = 'DONE' AND project = ?")
			.all(prov.project) as { id: string }[];
		for (const r of ids) out.doneIds.add(r.id);
	} catch (e) {
		out.error = `work store query failed: ${e instanceof Error ? e.message : String(e)}`;
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
	// deterministic claim-feed order: (endedAt ms, sessionId) — the session
	// cursor resumes by this total order, so equal-ended rows cannot skip
	out.sessions.sort((a, b) => {
		const da = endedMsOf(a);
		const db = endedMsOf(b);
		if (da !== db) return da - db;
		return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
	});
	return out;
}

/** endedAt ms with unparseable/absent stamps sorted last (they never claim,
 *  but must not disturb the deterministic order of the rows that do). */
function endedMsOf(s: SessionMetrics): number {
	if (!s.endedAt) return Number.MAX_SAFE_INTEGER;
	const ms = Date.parse(s.endedAt);
	return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
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
