// hooks/lib/knowledge-antientropy.ts — W1214: the db-touching face of the
// hub-to-hub knowledge anti-entropy. The pure tree math lives in
// knowledge-merkle.ts; THIS module owns the store access (tree build, slot
// reads, the W1213-rules content merge) and the pair-contact pass.
//
//   trees — the claims aggregate rides 256 shard roots + per-shard Merkle
//     trees over content hashes; the hub root binds all 256 in index order.
//   faces — aeRootFace / aeShardFace / aeLeavesFace / aeMergeFace are the
//     four peer endpoints (wired 1:1 in bin/knowledge-api.ts under /ae/*,
//     token-gated); keeping them as exported functions lets tests exercise
//     the protocol in-process against real logic, not a mock.
//   pass — aePass is the pair contact: root exchange (equal → stop, nothing
//     else is requested), divergent-shard descent, and a BIDIRECTIONAL
//     exchange at every divergent slot (pull theirs AND push mine — pull-
//     only would diverge forever on content drift, since the peer's copy
//     needs my rows too). Transfer volume is proportional to divergence:
//     HTTP calls = 2 root exchanges + 2 calls per divergent shard.
//
// Provenance/CRDT decision (the W1214 "decide then"): the W1213 rules are
// already a commutative, idempotent content merge when applied to full rows
// — confidence is a max-register, provenance a grow-only set normalized per
// (machine, retract?) with max ts, tombstone/origin are derived from the
// union — so no CRDT counters are added.
import type { Database } from "bun:sqlite";
import {
	AE_EMPTY_LEAF,
	AE_SHARDS,
	AE_SLOTS,
	AE_TREE_NODES,
	aeHubRoot,
	aeShardOf,
	aeSlotOf,
	buildShardNodes,
	canonicalRow,
	claimRowToWire,
	contentHash,
	diffShardTrees,
	parsePeerRow,
	normalizeProvenance,
	type AeRow,
	type AeWireRow,
} from "./knowledge-merkle.ts";
import { ensureRollTables, type ProvenanceEntry } from "./knowledge-roll.ts";

// ─── tree build + slot reads ────────────────────────────────────────────────

export interface AeTrees {
	/** The hub root: binds all AE_SHARDS shard roots in index order. */
	root: string;
	shardRoots: string[];
	/** Per-shard leaf (slot → content hash) vectors. */
	leaves: string[][];
}

/** Read every claims row once, hash canonically, place by hash prefix. The
 *  hash address space is hex-aligned to the store index: shard = the first
 *  two hex chars, slot = the next two, so slot reads ride the claim_hash
 *  UNIQUE index via LIKE 'ssee…%' prefixes. */
export function buildAeTrees(db: Database): AeTrees {
	ensureRollTables(db);
	const leaves: string[][] = [];
	for (let s = 0; s < AE_SHARDS; s++)
		leaves.push(new Array<string>(AE_SLOTS).fill(AE_EMPTY_LEAF));
	const rows = db
		.query(
			"SELECT claim_hash, evidence_id, claim, confidence, version, tombstone, origin_machine, provenance, tombstone_ts, scope FROM knowledge_claims",
		)
		.all() as {
		claim_hash: string;
		evidence_id: string;
		claim: string;
		confidence: number;
		version: number;
		tombstone: number;
		origin_machine: string;
		provenance: string;
		tombstone_ts: number | null;
		scope: string;
	}[];
	for (const r of rows) {
		const wire = claimRowToWire(r);
		if (wire === null) continue; // corrupt provenance: never ships
		const shard = aeShardOf(r.claim_hash);
		const slot = aeSlotOf(r.claim_hash);
		if (Number.isNaN(shard) || Number.isNaN(slot)) continue;
		leaves[shard][slot] = contentHash(wire);
	}
	const shardRoots = leaves.map((l) => buildShardNodes(l)[0]);
	return { root: aeHubRoot(shardRoots), shardRoots, leaves };
}

// ─── slot reads (the /ae/leaves face + the pass's pull set) ─────────────────

/** The rows of one shard-slot range, wire-ready. Empty range → no rows
 *  (an empty slot answers an empty list, never an error). */
export function loadSlotRows(
	db: Database,
	shard: number,
	slots: number[],
): AeWireRow[] {
	const prefix = `${shard.toString(16).padStart(2, "0")}`;
	const out: AeWireRow[] = [];
	for (const slot of slots) {
		const p = `${prefix}${slot.toString(16).padStart(2, "0")}`;
		const rows = db
			.query(
				"SELECT claim_hash, evidence_id, claim, confidence, version, tombstone, origin_machine, provenance, tombstone_ts, scope FROM knowledge_claims WHERE claim_hash LIKE ?",
			)
			.all(`${p}%`) as {
			claim_hash: string;
			evidence_id: string;
			claim: string;
			confidence: number;
			version: number;
			tombstone: number;
			origin_machine: string;
			provenance: string;
			tombstone_ts: number | null;
			scope: string;
		}[];
		for (const r of rows) {
			const wire = claimRowToWire(r);
			if (wire !== null) out.push(wire);
		}
	}
	return out;
}

// ─── the W1213-rules content merge ──────────────────────────────────────────

export interface AeMergeCounts {
	inserted: number;
	merged: number;
	unchanged: number;
}

export type AeMergeResult =
	| { ok: true; counts: AeMergeCounts }
	| { ok: false; error: string };

/** Land peer rows under the W1213 provenance rules as a CONTENT merge (see
 *  applyPeerRow for the per-row rules). One BEGIN IMMEDIATE per batch; a
 *  malformed wire row fails the whole batch; a corrupt LOCAL provenance row
 *  is skipped untouched. */
export function mergePeerRows(
	db: Database,
	rows: unknown,
	opts: { now?: number } = {},
): AeMergeResult {
	if (!Array.isArray(rows)) return { ok: false, error: "rows must be a list" };
	if (rows.length > 2000)
		return { ok: false, error: "too many rows (max 2000)" };
	const valid: AeWireRow[] = [];
	for (const w of rows) {
		const v = parsePeerRow(w);
		if (v === null) return { ok: false, error: "invalid peer row" };
		valid.push(v);
	}
	ensureRollTables(db);
	const now = opts.now ?? Date.now();
	const counts: AeMergeCounts = { inserted: 0, merged: 0, unchanged: 0 };
	db.run("BEGIN IMMEDIATE");
	try {
		for (const v of valid) applyPeerRow(db, v, now, counts);
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	return { ok: true, counts };
}

/** The stored db-row shape the merge reads (knowledge_claims + id). */
interface AeDbRow {
	id: number;
	claim_hash: string;
	evidence_id: string;
	claim: string;
	confidence: number;
	version: number;
	tombstone: number;
	origin_machine: string;
	provenance: string;
	tombstone_ts: number | null;
	scope: string;
}

function provOf(row: { provenance: string }): ProvenanceEntry[] | null {
	try {
		const p: unknown = JSON.parse(row.provenance);
		return Array.isArray(p) ? (p as ProvenanceEntry[]) : null;
	} catch {
		return null;
	}
}

/** Local row → canonical form (the merge's "before" side). Null when the
 *  stored provenance is corrupt — the caller skips, never corrupts further. */
function canonicalOf(row: AeDbRow): AeRow | null {
	const prov = provOf(row);
	if (prov === null) return null;
	return canonicalRow({
		claim_hash: row.claim_hash,
		evidence_id: row.evidence_id,
		claim: row.claim,
		confidence: row.confidence,
		tombstone: row.tombstone === 1,
		tombstone_ts: row.tombstone_ts,
		scope: row.scope,
		origin_machine: row.origin_machine,
		provenance: prov,
	});
}

// one row of the batch: insert (transferred version when its slot is free,
// else max+1) or the content merge over the provenance union.
function applyPeerRow(
	db: Database,
	v: AeWireRow,
	now: number,
	counts: AeMergeCounts,
): void {
	const local = db
		.query("SELECT * FROM knowledge_claims WHERE claim_hash = ?")
		.get(v.claim_hash) as AeDbRow | null;
	if (local === null) {
		insertPeerRow(db, v, now);
		counts.inserted++;
		return;
	}
	mergeKnownRow(db, local, v, now, counts);
}

// the known-hash branch: prove nothing changed (re-push = no-op) or land the
// union state — provenance union, max confidence, derived tombstone/origin.
function mergeKnownRow(
	db: Database,
	local: AeDbRow,
	v: AeWireRow,
	now: number,
	counts: AeMergeCounts,
): void {
	const before = canonicalOf(local);
	if (before === null) {
		counts.unchanged++; // corrupt local provenance: skip untouched
		return;
	}
	const union = normalizeProvenance([
		...(provOf(local) ?? []),
		...v.provenance,
	]);
	const target = canonicalRow({
		claim_hash: local.claim_hash,
		evidence_id: local.evidence_id,
		claim: local.claim,
		confidence: Math.max(local.confidence, v.confidence),
		tombstone: false,
		tombstone_ts: null,
		scope: local.scope,
		origin_machine: "",
		provenance: union,
	});
	if (contentHash(before) === contentHash(target)) {
		counts.unchanged++;
		return;
	}
	updatePeerRow(db, local.id, target, now);
	counts.merged++;
}

// the insert path: canonical form, with the W1213 versioning guard — the
// transferred ordinal only when its (evidence, version) slot is free, else
// max+1 (restatements version, never collide).
function insertPeerRow(db: Database, v: AeWireRow, now: number): void {
	const canon = canonicalRow(v);
	let version = v.version;
	const slotTaken = db
		.query(
			"SELECT id FROM knowledge_claims WHERE evidence_id = ? AND version = ?",
		)
		.get(canon.evidence_id, version);
	if (slotTaken !== null && slotTaken !== undefined) {
		const maxV = db
			.query(
				"SELECT COALESCE(MAX(version), 0) AS v FROM knowledge_claims WHERE evidence_id = ?",
			)
			.get(canon.evidence_id) as { v: number };
		version = (maxV.v ?? 0) + 1;
	}
	db.run(
		"INSERT INTO knowledge_claims (claim_hash, evidence_id, claim, confidence, version, tombstone, ts, updated_at, origin_machine, provenance, tombstone_ts, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		canon.claim_hash,
		canon.evidence_id,
		canon.claim,
		canon.confidence,
		version,
		canon.tombstone ? 1 : 0,
		now,
		now,
		canon.origin_machine,
		JSON.stringify(canon.provenance),
		canon.tombstone_ts,
		canon.scope,
	);
}

function updatePeerRow(
	db: Database,
	id: number,
	target: AeRow,
	now: number,
): void {
	db.run(
		"UPDATE knowledge_claims SET confidence = ?, tombstone = ?, tombstone_ts = ?, origin_machine = ?, provenance = ?, updated_at = ? WHERE id = ?",
		target.confidence,
		target.tombstone ? 1 : 0,
		target.tombstone_ts,
		target.origin_machine,
		JSON.stringify(target.provenance),
		now,
		id,
	);
}

// ─── the four peer faces (wired 1:1 under /ae/* in bin/knowledge-api.ts) ───

export interface AeRootView {
	ok: true;
	shards: number;
	slots: number;
	root: string;
	shardRoots: string[];
}

export interface AeShardView {
	ok: true;
	index: number;
	root: string;
	nodes: string[];
}

/** GET /ae/root — the hub root + the whole shard-root vector (one call:
 *  divergent shards come from comparing vectors, not 256 polls). */
export function aeRootFace(db: Database): AeRootView {
	const t = buildAeTrees(db);
	return {
		ok: true,
		shards: AE_SHARDS,
		slots: AE_SLOTS,
		root: t.root,
		shardRoots: t.shardRoots,
	};
}

/** GET /ae/shard?index=N — one shard's flat tree (511 node hashes). */
export function aeShardFace(
	db: Database,
	index: number,
): AeShardView | { ok: false; error: string } {
	if (!Number.isInteger(index) || index < 0 || index >= AE_SHARDS)
		return { ok: false, error: "shard index out of range" };
	const t = buildAeTrees(db);
	const nodes = buildShardNodes(t.leaves[index]);
	return { ok: true, index, root: nodes[0], nodes };
}

/** POST /ae/leaves {shard, slots} — the peer's rows under those slots. */
export function aeLeavesFace(
	db: Database,
	body: unknown,
): { ok: true; rows: AeWireRow[] } | { ok: false; error: string } {
	const b = body as { shard?: unknown; slots?: unknown };
	if (
		!Number.isInteger(b?.shard) ||
		(b.shard as number) < 0 ||
		(b.shard as number) >= AE_SHARDS
	)
		return { ok: false, error: "shard out of range" };
	const slots = b.slots;
	if (!Array.isArray(slots) || slots.length === 0 || slots.length > AE_SLOTS)
		return { ok: false, error: "slots must be a 1..256 list" };
	const idx = slots.map(Number);
	if (idx.some((s) => !Number.isInteger(s) || s < 0 || s >= AE_SLOTS))
		return { ok: false, error: "slot out of range" };
	return { ok: true, rows: loadSlotRows(db, b.shard as number, idx) };
}

/** POST /ae/merge {rows} — the W1213-rules content landing. Fails closed on
 *  any malformed row (422 at the wire, never a silent partial). */
export function aeMergeFace(db: Database, body: unknown): AeMergeResult {
	const b = body as { rows?: unknown };
	if (!b || !Array.isArray(b.rows))
		return { ok: false, error: "rows required" };
	return mergePeerRows(db, b.rows);
}

// ─── the pair-contact pass ──────────────────────────────────────────────────

export interface AePassResult {
	peer: string;
	ok: boolean;
	/** The pre-exchange roots already matched: NOTHING else was requested. */
	rootEqual: boolean;
	shardsDivergent: number;
	slotsDivergent: number;
	/** Rows landed locally from the peer / rows the peer accepted from us. */
	pulled: number;
	pushed: number;
	/** Post-exchange roots match (rebuilt locally, re-read from the peer). */
	converged: boolean;
	error: string | null;
}

export interface AePassOpts {
	token?: string;
	timeoutMs?: number;
	/** Fetch seam (tests); default global fetch. */
	fetchImpl?: typeof fetch;
}

/** The pass's transport: one JSON call closure over the peer, token header
 *  and timeout applied on every call. */
function aeClient(
	peerUrl: string,
	opts: AePassOpts,
): (
	path: string,
	init?: { method?: string; body?: string },
) => Promise<unknown> {
	const f = opts.fetchImpl ?? fetch;
	const headers: Record<string, string> = opts.token
		? { "x-klh-write-token": opts.token }
		: {};
	return async (path, init) => {
		const r = await f(`${peerUrl}${path}`, {
			...init,
			headers: {
				...headers,
				...(init?.body ? { "content-type": "application/json" } : {}),
			},
			signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
		});
		if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
		return r.json();
	};
}

/** Fetch + validate the peer's root answer: root string plus the full
 *  AE_SHARDS shard-root vector. Anything else is a protocol error. */
async function aeRemoteRoots(
	call: (
		path: string,
		init?: { method?: string; body?: string },
	) => Promise<unknown>,
): Promise<{ root: string; roots: string[] }> {
	const root = (await call("/ae/root")) as {
		root?: unknown;
		shardRoots?: unknown;
	};
	if (
		typeof root?.root !== "string" ||
		!Array.isArray(root.shardRoots) ||
		root.shardRoots.length !== AE_SHARDS
	)
		throw new Error("malformed /ae/root answer");
	return { root: root.root, roots: root.shardRoots as string[] };
}

type AeCall = (
	path: string,
	init?: { method?: string; body?: string },
) => Promise<unknown>;

// one divergent shard: descend to divergent slots, exchange BIDIRECTIONALLY
// (pull the peer's rows into the local merge; push ours onto /ae/merge).
async function aeExchangeShard(
	db: Database,
	call: AeCall,
	localLeaves: string[],
	shard: number,
	remoteNodes: string[],
	res: AePassResult,
): Promise<void> {
	const slots = diffShardTrees(buildShardNodes(localLeaves), remoteNodes);
	res.slotsDivergent += slots.length;
	const pullSlots: number[] = [];
	const pushSlots: number[] = [];
	for (const slot of slots) {
		if (remoteNodes[AE_SLOTS - 1 + slot] === AE_EMPTY_LEAF) {
			pushSlots.push(slot); // only we hold this range: theirs is empty
			continue;
		}
		pullSlots.push(slot);
		pushSlots.push(slot);
	}
	// snapshot OUR rows at the divergent slots BEFORE the pull lands peer
	// rows — the push set is the pre-exchange local state, never the pull's
	// echo (otherwise every pulled row bounces straight back to its origin).
	const mine = pushSlots.length > 0 ? loadSlotRows(db, shard, pushSlots) : [];
	if (pullSlots.length > 0) await aePullSlots(db, call, shard, pullSlots, res);
	if (mine.length > 0) await aePushRows(call, mine, res);
}

// the pull leg: fetch the peer's rows under the divergent slots and land
// them through the W1213-rules content merge.
async function aePullSlots(
	db: Database,
	call: AeCall,
	shard: number,
	pullSlots: number[],
	res: AePassResult,
): Promise<void> {
	const leaves = (await call("/ae/leaves", {
		method: "POST",
		body: JSON.stringify({ shard, slots: pullSlots }),
	})) as { rows?: unknown };
	if (!Array.isArray(leaves.rows))
		throw new Error("malformed /ae/leaves answer");
	const m = mergePeerRows(db, leaves.rows);
	if (!m.ok) throw new Error(`peer rows refused: ${m.error}`);
	res.pulled += m.counts.inserted + m.counts.merged;
}

// the push leg: hand our rows to the peer's /ae/merge (the peer lands them
// through the same content merge — no re-assertion, no provenance echo).
async function aePushRows(
	call: AeCall,
	mine: AeWireRow[],
	res: AePassResult,
): Promise<void> {
	const ack = (await call("/ae/merge", {
		method: "POST",
		body: JSON.stringify({ rows: mine }),
	})) as { ok?: unknown; error?: unknown };
	if (ack.ok !== true)
		throw new Error(
			typeof ack.error === "string" ? ack.error : "merge rejected",
		);
	res.pushed += mine.length;
}

/** One hub-pair anti-entropy exchange. Root equality short-circuits (the
 *  identical-hubs case requests NOTHING further); otherwise every divergent
 *  shard descends to divergent slots and exchanges bidirectionally — one
 *  exchange converges the pair, volume proportional to divergence. */
export async function aePass(
	db: Database,
	peerUrl: string,
	opts: AePassOpts = {},
): Promise<AePassResult> {
	const res: AePassResult = {
		peer: peerUrl,
		ok: false,
		rootEqual: false,
		shardsDivergent: 0,
		slotsDivergent: 0,
		pulled: 0,
		pushed: 0,
		converged: false,
		error: null,
	};
	const call = aeClient(peerUrl, opts);
	try {
		const local = buildAeTrees(db);
		const remote = await aeRemoteRoots(call);
		if (remote.root === local.root)
			return { ...res, ok: true, rootEqual: true, converged: true };
		for (let s = 0; s < AE_SHARDS; s++) {
			if (remote.roots[s] === local.shardRoots[s]) continue;
			res.shardsDivergent++;
			const sh = (await call(`/ae/shard?index=${s}`)) as { nodes?: unknown };
			if (!Array.isArray(sh.nodes) || sh.nodes.length !== AE_TREE_NODES)
				throw new Error("malformed /ae/shard answer");
			await aeExchangeShard(
				db,
				call,
				local.leaves[s],
				s,
				sh.nodes as string[],
				res,
			);
		}
		const after = buildAeTrees(db);
		const root2 = (await call("/ae/root")) as { root?: unknown };
		res.converged = typeof root2.root === "string" && root2.root === after.root;
		res.ok = true;
		return res;
	} catch (e) {
		return { ...res, error: e instanceof Error ? e.message : String(e) };
	}
}
