// hooks/lib/knowledge-roll.ts — W1213: the UPWARD knowledge sync. W944
// pushed machine telemetry DOWN the pipe (facts land as candidate rows);
// W1212 mints machine-local, CAS'd knowledge claims into coord facts. This
// module carries the claim roll UP: machine → hub knowledge-api → the
// hub-side aggregate.
//
//   identity — a claim is hashed over (evidence-id + claim text): two
//     machines asserting the same evidence-id + claim collapse into ONE
//     aggregated row whose provenance counts the asserters; a DIFFERENT
//     claim about the same evidence-id is a new VERSION, never an overwrite
//     and never a dupe.
//   retractions — a tombstone entry rides the SAME hash (the facts row's
//     latest-per-key value carries tombstone: true next to the original
//     claim text); the aggregate flips to tombstoned and stops appearing —
//     append-only, never a delete.
//   transport — the hub knowledge-api accepts the roll under a SCOPED TTL
//     KEY minted per machine (the W1141 posture: the credential binds the
//     machine, so provenance is resolved from the key, never from the
//     payload). The operator's install write token keeps working (provenance
//     then rides the body's machine field) — no lockout, still no shared
//     secret on the wire from spokes.
//   ladder — CAS dedupe now (this file); Merkle anti-entropy (W1214) and
//     CRDT provenance counters are the Phase2/3 follow-ups. Interim ordering
//     is last-timestamp-wins with a MONOTONIC tombstone gate (W1213.3): an
//     assertion newer than a row's tombstone revives it; a stale assertion
//     against a tombstone is ignored; a retraction applies only while it is
//     not older than the row's provenance high-water mark — a replay of an
//     already-applied retraction is an idempotent dupe that never re-hides a
//     revived claim and never duplicates retract provenance.
import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./knowledge.ts";
import { REG } from "./govdb-util.ts";

// ─── claim identity ─────────────────────────────────────────────────────────

/** The machine facts namespace the roll collects (W1212's claim keys). */
export const CLAIM_FACT = /^claim\./;

/** The scoped TTL key header (both transport faces — api validation and
 *  the spoke push — import the ONE name). */
export const ROLL_KEY_HEADER = "x-klh-roll-key";

/** Wire clamp: claim text ≤ 2000 chars (the W944 fact-value bound). */
export const MAX_CLAIM_TEXT = 2000;
/** Wire clamp: evidence ids are short keys. */
export const MAX_EVIDENCE_ID = 256;
/** Wire clamp: one roll carries at most 200 entries (per-pass cap). */
export const MAX_ROLL_ENTRIES = 200;

/** The CAS/content key: sha256 over (evidence-id + claim text). NUL
 *  separator keeps the two fields unambiguous. Stable across machines —
 *  the same evidence+claim hashes identically on every pusher. */
export function claimHash(evidenceId: string, claim: string): string {
	return createHash("sha256")
		.update(`${evidenceId}\u0000${claim}`)
		.digest("hex");
}

/** A roll entry as it crosses the wire (and as it lands). */
export interface RollEntry {
	evidenceId: string;
	claim: string;
	confidence: number;
	ts: number;
	tombstone?: boolean;
}

/** facts value → roll entry. The value is JSON
 *  `{claim, confidence?, tombstone?}` (W1212's stamp shape); a plain-text
 *  value (no JSON) degrades to `{claim: text}` so pre-JSON rows still sync.
 *  Returns null when the row is not a well-formed claim (caller skips). */
export function parseClaimRow(key: string, value: string): RollEntry | null {
	if (!CLAIM_FACT.test(key)) return null;
	const evidenceId = key.slice("claim.".length).trim();
	if (!evidenceId || evidenceId.length > MAX_EVIDENCE_ID) return null;
	const text = typeof value === "string" ? value : "";
	if (!text.trim()) return null;
	let claim = text;
	let confidence: number | null = null;
	let tombstone = false;
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		try {
			const j = JSON.parse(trimmed) as Record<string, unknown>;
			const c = j.claim;
			if (typeof c !== "string" || !c.trim()) return null;
			claim = c;
			if (
				typeof j.confidence === "number" &&
				Number.isFinite(j.confidence) &&
				j.confidence >= 0 &&
				j.confidence <= 1
			)
				confidence = j.confidence;
			if (j.tombstone === true) tombstone = true;
		} catch {
			// JSON-shaped but unparseable → treat the whole value as claim text
		}
	}
	claim = claim.trim();
	if (!claim || claim.length > MAX_CLAIM_TEXT) return null;
	return {
		evidenceId,
		claim,
		confidence: confidence ?? 0.5,
		ts: 0,
		tombstone,
	};
}

// ─── hub-side aggregate (knowledge.db) ──────────────────────────────────────

export interface RollCounts {
	/** assertions merged into an existing non-tombstoned row */
	merged: number;
	/** rows created (new content — includes first-landing tombstones) */
	versions: number;
	/** rows flipped to tombstoned */
	tombstoned: number;
	/** events older than the row's current state (ignored, recorded): stale
	 *  assertions against a tombstone and stale retraction replays against a
	 *  live row (the W1213.3 monotonic gate) */
	stale: number;
	/** idempotent re-push: the machine already asserted this content, or the
	 *  retraction is already standing (W1213.3 — a replay never re-flips) */
	dupes: number;
}

/** Self-healing CREATE for the aggregate (the openKnowledgeDb doctrine).
 *  provenance is the append-only [{machine, ts, retract?}] list; tombstone
 *  rows keep everything (claims never delete). */
export function ensureRollTables(db: Database): void {
	db.run(
		"CREATE TABLE IF NOT EXISTS knowledge_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, claim_hash TEXT NOT NULL UNIQUE, evidence_id TEXT NOT NULL, claim TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, version INTEGER NOT NULL DEFAULT 1, tombstone INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, updated_at INTEGER NOT NULL, origin_machine TEXT NOT NULL, provenance TEXT NOT NULL, tombstone_ts INTEGER)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS knowledge_claims_evidence ON knowledge_claims (evidence_id, version)",
	);
}

/** One provenance entry: a machine asserting (or retracting) the claim. */
export interface ProvenanceEntry {
	machine: string;
	ts: number;
	retract?: boolean;
}

interface ClaimRow {
	id: number;
	claim_hash: string;
	evidence_id: string;
	claim: string;
	confidence: number;
	version: number;
	tombstone: number;
	ts: number;
	updated_at: number;
	origin_machine: string;
	provenance: string;
	tombstone_ts: number | null;
}

function validEntry(e: unknown): e is RollEntry {
	if (!e || typeof e !== "object" || Array.isArray(e)) return false;
	const r = e as Record<string, unknown>;
	if (
		typeof r.evidenceId !== "string" ||
		!r.evidenceId.trim() ||
		r.evidenceId.length > MAX_EVIDENCE_ID
	)
		return false;
	if (
		typeof r.claim !== "string" ||
		!r.claim.trim() ||
		r.claim.length > MAX_CLAIM_TEXT
	)
		return false;
	if (
		typeof r.confidence !== "number" ||
		!Number.isFinite(r.confidence) ||
		r.confidence < 0 ||
		r.confidence > 1
	)
		return false;
	if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return false;
	if (r.tombstone !== undefined && typeof r.tombstone !== "boolean")
		return false;
	return true;
}

/** Hub-side landing core, db-injected for tests. ONE BEGIN IMMEDIATE
 *  transaction per roll (serializes concurrent machine pushes so version
 *  assignment cannot race). Provenance appends only NEW machines; the
 *  aggregated confidence is the MAX asserted. */
export function aggregateClaims(
	db: Database,
	entries: unknown,
	machine: string,
	opts: { now?: number } = {},
): { ok: boolean; error?: string; counts?: RollCounts } {
	if (typeof machine !== "string" || !machine.trim() || machine.length > 128)
		return { ok: false, error: "bad machine" };
	if (!Array.isArray(entries))
		return { ok: false, error: "claims must be a list" };
	if (entries.length > MAX_ROLL_ENTRIES)
		return { ok: false, error: `too many claims (max ${MAX_ROLL_ENTRIES})` };
	for (const e of entries)
		if (!validEntry(e)) return { ok: false, error: "invalid claim entry" };
	ensureRollTables(db);
	const now = opts.now ?? Date.now();
	const counts: RollCounts = {
		merged: 0,
		versions: 0,
		tombstoned: 0,
		stale: 0,
		dupes: 0,
	};
	db.run("BEGIN IMMEDIATE");
	try {
		for (const raw of entries) {
			const e = raw as RollEntry;
			const h = claimHash(e.evidenceId, e.claim);
			const row = db
				.query("SELECT * FROM knowledge_claims WHERE claim_hash = ?")
				.get(h) as ClaimRow | undefined;
			if (row) {
				applyKnown(db, counts, row, e, machine, now);
				continue;
			}
			// new content: the version slot is per evidence-id — the first claim
			// for an evidence-id is v1, a DIFFERENT claim about it is v2+ (the
			// versioning guard: restatements version, never overwrite/collide)
			const maxV = db
				.query(
					"SELECT COALESCE(MAX(version), 0) AS v FROM knowledge_claims WHERE evidence_id = ?",
				)
				.get(e.evidenceId) as { v: number };
			const version = (maxV.v ?? 0) + 1;
			db.run(
				"INSERT INTO knowledge_claims (claim_hash, evidence_id, claim, confidence, version, tombstone, ts, updated_at, origin_machine, provenance, tombstone_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				h,
				e.evidenceId,
				e.claim,
				e.confidence,
				version,
				e.tombstone ? 1 : 0,
				now,
				now,
				machine,
				JSON.stringify([
					{ machine, ts: e.ts, ...(e.tombstone ? { retract: true } : {}) },
				]),
				e.tombstone ? e.ts : null,
			);
			if (e.tombstone) counts.tombstoned++;
			else counts.versions++;
		}
		db.run("COMMIT");
	} catch (err) {
		try {
			db.run("ROLLBACK");
		} catch {}
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	return { ok: true, counts };
}

// the known-hash branch: tombstone flip / revive / provenance merge
function applyKnown(
	db: Database,
	counts: RollCounts,
	row: ClaimRow,
	e: RollEntry,
	machine: string,
	now: number,
): void {
	let prov: ProvenanceEntry[] = [];
	try {
		prov = JSON.parse(row.provenance) as typeof prov;
	} catch {
		prov = [];
	}
	if (e.tombstone) {
		if (row.tombstone) {
			// W1213.3 idempotency: the standing retraction already covers this
			// event — the replay counts a dupe, never duplicating retract
			// provenance and never re-bumping tombstone_ts
			counts.dupes++;
			return;
		}
		// W1213.3 monotonicity: the retraction applies only while it is not
		// older than every event the row has seen (the provenance high-water
		// mark). B3: after assert 100 → tombstone 200 → revive 300, a replay
		// of the 200 tombstone is stale — no re-hide, no provenance churn.
		const hwm = prov.reduce((m, p) => Math.max(m, p.ts), 0);
		if (e.ts < hwm) {
			counts.stale++;
			return;
		}
		// a current retraction flips the row and records the retractor — it
		// wins ties with the row's last event (a machine retracting its own
		// assertion is authoritative over the aggregate's stored state)
		db.run(
			"UPDATE knowledge_claims SET tombstone = 1, tombstone_ts = ?, updated_at = ?, provenance = ? WHERE id = ?",
			e.ts,
			now,
			JSON.stringify([...prov, { machine, ts: e.ts, retract: true }]),
			row.id,
		);
		counts.tombstoned++;
		return;
	}
	if (row.tombstone) {
		if (e.ts > (row.tombstone_ts ?? 0)) {
			// revive: a NEWER assertion beats the tombstone (last-timestamp-
			// wins interim; W1214 replaces this with real anti-entropy)
			db.run(
				"UPDATE knowledge_claims SET tombstone = 0, tombstone_ts = NULL, confidence = MAX(confidence, ?), updated_at = ?, provenance = ? WHERE id = ?",
				e.confidence,
				now,
				JSON.stringify([...prov, { machine, ts: e.ts }]),
				row.id,
			);
			counts.merged++;
		} else counts.stale++;
		return;
	}
	if (prov.some((p) => p.machine === machine && !p.retract)) {
		// idempotent re-push: the machine already asserted this exact content
		counts.dupes++;
		return;
	}
	db.run(
		"UPDATE knowledge_claims SET confidence = MAX(confidence, ?), updated_at = ?, provenance = ? WHERE id = ?",
		e.confidence,
		now,
		JSON.stringify([...prov, { machine, ts: e.ts }]),
		row.id,
	);
	counts.merged++;
}

export interface ClaimView {
	id: number;
	evidenceId: string;
	claim: string;
	confidence: number;
	version: number;
	tombstone: boolean;
	ts: number;
	updatedAt: number;
	originMachine: string;
	provenance: ProvenanceEntry[];
	provenanceCount: number;
}

export interface AggregateView {
	claims: ClaimView[];
	/** per-tenant (machine) roll-up: what each machine asserted/retracted */
	tenants: { machine: string; asserted: number; retracted: number }[];
}

/** The read surface: aggregated facts, confidence-ranked (confidence DESC,
 *  then provenance breadth, then evidence). Tombstoned claims do NOT appear
 *  unless includeTombstones lifts them (ops/verify — the rows still exist). */
export function claimAggregateView(
	db: Database,
	opts: { includeTombstones?: boolean } = {},
): AggregateView {
	ensureRollTables(db);
	const rows = db
		.query(
			`SELECT * FROM knowledge_claims ${opts.includeTombstones ? "" : "WHERE tombstone = 0"} ORDER BY id`,
		)
		.all() as ClaimRow[];
	const claims: ClaimView[] = [];
	const tenants = new Map<string, { asserted: number; retracted: number }>();
	for (const r of rows) {
		let prov: ProvenanceEntry[] = [];
		try {
			prov = JSON.parse(r.provenance) as ProvenanceEntry[];
		} catch {
			prov = [];
		}
		for (const p of prov) {
			if (!tenants.has(p.machine))
				tenants.set(p.machine, { asserted: 0, retracted: 0 });
			const t = tenants.get(p.machine);
			if (!t) continue;
			if (p.retract) t.retracted++;
			else t.asserted++;
		}
		claims.push({
			id: r.id,
			evidenceId: r.evidence_id,
			claim: r.claim,
			confidence: r.confidence,
			version: r.version,
			tombstone: r.tombstone === 1,
			ts: r.ts,
			updatedAt: r.updated_at,
			originMachine: r.origin_machine,
			provenance: prov,
			provenanceCount: prov.filter((p) => !p.retract).length,
		});
	}
	claims.sort(
		(a, b) =>
			b.confidence - a.confidence ||
			b.provenanceCount - a.provenanceCount ||
			a.evidenceId.localeCompare(b.evidenceId) ||
			a.version - b.version,
	);
	return {
		claims,
		tenants: [...tenants.entries()]
			.map(([machine, t]) => ({ machine, ...t }))
			.sort((a, b) => b.asserted - a.asserted),
	};
}

// ─── scoped TTL keys (the credential-free transport) ────────────────────────

interface RollKeyEntry {
	hash: string;
	machine: string;
	expiresAt: number;
}

/** Mode-600 key store (config-over-code: SUSPENDERS_ROLL_KEYS_FILE moves it).
 *  Entries hold the sha256 of the key, never the key itself. */
export function rollKeysPath(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.SUSPENDERS_ROLL_KEYS_FILE ??
		`${env.HOME}/.cache/claude-governor/roll-keys.json`
	);
}

function readKeyFile(path: string): RollKeyEntry[] {
	try {
		const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const keys = Array.isArray(j.keys) ? j.keys : [];
		return keys.filter(
			(k): k is RollKeyEntry =>
				!!k &&
				typeof k === "object" &&
				typeof (k as RollKeyEntry).hash === "string" &&
				typeof (k as RollKeyEntry).machine === "string" &&
				typeof (k as RollKeyEntry).expiresAt === "number",
		);
	} catch {
		return [];
	}
}

function writeKeyFile(path: string, keys: RollKeyEntry[]): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ keys }, null, "\t")}\n`, {
		mode: 0o600,
	});
}

/** Mint one machine-scoped key: printed ONCE at mint time, only its hash is
 *  stored, expires after ttlHours (default 24h — the W1141 TTL posture). */
export function mintRollKey(
	machine: string,
	ttlHours = 24,
	opts: { path?: string; now?: number } = {},
): { key: string; machine: string; expiresAt: number } {
	if (typeof machine !== "string" || !machine.trim() || machine.length > 128)
		throw new Error("mintRollKey: machine required (≤128 chars)");
	const path = opts.path ?? rollKeysPath();
	const now = opts.now ?? Date.now();
	const key = `klhroll_${randomBytes(32).toString("hex")}`;
	const expiresAt = now + Math.max(1, ttlHours) * 3_600_000;
	const keys = readKeyFile(path).filter((k) => k.expiresAt > now);
	keys.push({
		hash: createHash("sha256").update(key).digest("hex"),
		machine,
		expiresAt,
	});
	writeKeyFile(path, keys);
	return { key, machine, expiresAt };
}

/** Validate a presented key → the bound machine, or null. Expired entries
 *  are pruned lazily on read. */
export function rollKeyOk(
	presented: string,
	opts: { path?: string; now?: number } = {},
): { ok: boolean; machine: string | null } {
	if (typeof presented !== "string" || !presented)
		return { ok: false, machine: null };
	const path = opts.path ?? rollKeysPath();
	const now = opts.now ?? Date.now();
	const keys = readKeyFile(path);
	const hash = createHash("sha256").update(presented).digest("hex");
	const hit = keys.find(
		(k) =>
			k.expiresAt > now &&
			k.hash.length === hash.length &&
			timingSafeEqual(Buffer.from(k.hash), Buffer.from(hash)),
	);
	return { ok: !!hit, machine: hit?.machine ?? null };
}

// ─── machine-side collection ────────────────────────────────────────────────

export interface CollectedClaims {
	send: RollEntry[];
	skipped: string[];
	/** facts-key → version for the sent set — the cursor the sync stamps only
	 *  when every roll target accepted the pass. */
	cursor: Record<string, number>;
}

/** The claim pass: facts rows in the claim.* namespace → roll entries.
 *  Same verification chain as the W944 facts pass — redactSecrets with a
 *  REJECT posture (stricter than local ingest), version-delta against the
 *  sync cursor (state.claims), 50-entries-per-pass cap. */
export function collectClaims(
	state: { claims?: Record<string, number> },
	opts: { dbPath?: string | null } = {},
): CollectedClaims {
	const send: RollEntry[] = [];
	const skipped: string[] = [];
	const cursor: Record<string, number> = {};
	if (opts.dbPath === null) return { send, skipped, cursor: {} };
	const dbPath = opts.dbPath ?? `${REG()}/governor.db`;
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true, create: false });
	} catch {
		return {
			send,
			skipped: ["claims: governor.db not readable"],
			cursor: {},
		};
	}
	if (db) {
		const rows = db
			.query(
				"SELECT key, value, version, ts, confidence FROM facts WHERE key LIKE 'claim.%' ORDER BY key",
			)
			.all() as {
			key: string;
			value: string | null;
			version: number;
			ts: number;
			confidence: number | null;
		}[];
		for (const r of rows) {
			if (!r.value) continue;
			if (state.claims?.[r.key] === r.version) continue; // cursor: sent already
			const e = parseClaimRow(r.key, r.value);
			if (!e) {
				skipped.push(`${r.key}: not a well-formed claim row`);
				continue;
			}
			const red = redactSecrets(e.claim);
			if (red.rejected || red.hits.length > 0) {
				skipped.push(`${r.key}: secret pattern (${red.hits.join(", ")})`);
				continue;
			}
			send.push({
				...e,
				confidence: e.confidence || r.confidence || 0.5,
				ts: r.ts,
			});
			cursor[r.key] = r.version;
			if (send.length >= 50) {
				skipped.push("claims: pass cap (50) — remainder rides the next pass");
				break;
			}
		}
	}
	db?.close();
	return { send, skipped, cursor };
}
