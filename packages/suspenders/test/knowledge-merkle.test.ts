// test/knowledge-merkle.test.ts — W1214: hub-to-hub knowledge anti-entropy.
// Covers the three acceptance criteria (two divergent hubs converge after
// ONE exchange; identical hubs exchange nothing — root equality short-
// circuit; transfer volume proportional to divergence), the Merkle address
// space, the canonical content hash, and the W1213-rules content merge.
// The pair protocol rides an in-process Bun.serve stub wired to the REAL
// face functions (no mocked merge — the same code the bin serves).
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	AE_EMPTY_LEAF,
	AE_SHARDS,
	AE_SLOTS,
	AE_TREE_NODES,
	aeShardOf,
	aeSlotOf,
	buildShardNodes,
	canonicalOrigin,
	canonicalRow,
	contentHash,
	diffShardTrees,
	emptyShardNodes,
	normalizeProvenance,
	parsePeerRow,
} from "../hooks/lib/knowledge/knowledge-merkle.ts";
import {
	buildAeTrees,
	mergePeerRows,
	aeLeavesFace,
	aeMergeFace,
	aePass,
	aeRootFace,
	aeShardFace,
} from "../hooks/lib/knowledge/knowledge-antientropy.ts";
import {
	aggregateClaims,
	claimHash,
} from "../hooks/lib/knowledge/knowledge-roll.ts";

// ─── fixtures ───────────────────────────────────────────────────────────────

type Wire = {
	claim_hash: string;
	evidence_id: string;
	claim: string;
	confidence: number;
	tombstone: boolean;
	tombstone_ts: number | null;
	scope: string;
	origin_machine: string;
	provenance: { machine: string; ts: number; retract?: boolean }[];
	version: number;
};

const mkWire = (
	ev: string,
	claim: string,
	machine = "m1",
	ts = 100,
	version = 1,
	confidence = 0.5,
): Wire => ({
	claim_hash: claimHash(ev, claim, "fleet"),
	evidence_id: ev,
	claim,
	confidence,
	tombstone: false,
	tombstone_ts: null,
	scope: "fleet",
	origin_machine: machine,
	provenance: [{ machine, ts }],
	version,
});

// ─── address space + trees ──────────────────────────────────────────────────

test("addressing: shard/slot derive from the claim-hash prefix", () => {
	const h = claimHash("ev", "c", "fleet");
	expect(aeShardOf(h)).toBe(Number.parseInt(h.slice(0, 2), 16));
	expect(aeSlotOf(h)).toBe(Number.parseInt(h.slice(2, 4), 16));
	expect(aeShardOf(h)).toBeLessThan(AE_SHARDS);
	expect(aeSlotOf(h)).toBeLessThan(AE_SLOTS);
});

test("trees: identical sets build identical roots; any change moves them", () => {
	const seed = (db: Database): string => {
		for (const [ev, c] of [
			["e1", "c1"],
			["e2", "c2"],
			["e3", "c3"],
		])
			aggregateClaims(
				db,
				[
					{
						evidenceId: ev,
						claim: c,
						confidence: 0.5,
						ts: 100,
						scope: "fleet",
					},
				],
				"m1",
				{ now: 1000 },
			);
		return buildAeTrees(db).root;
	};
	const ta = seed(new Database(":memory:"));
	const tb = seed(new Database(":memory:"));
	expect(tb).toBe(ta); // identical hubs → byte-identical roots
	const tc = new Database(":memory:");
	seed(tc);
	aggregateClaims(
		tc,
		[
			{
				evidenceId: "e4",
				claim: "c4",
				confidence: 0.5,
				ts: 100,
				scope: "fleet",
			},
		],
		"m1",
		{ now: 1000 },
	);
	expect(buildAeTrees(tc).root).not.toBe(ta);
});

test("trees: empty shards build to the shared constant structure", () => {
	expect(emptyShardNodes()).toEqual(buildShardNodes([]));
	expect(emptyShardNodes().length).toBe(AE_TREE_NODES);
	expect(diffShardTrees(emptyShardNodes(), emptyShardNodes())).toEqual([]);
});

test("diff: exactly the divergent slots report, nothing else", () => {
	const leaves = new Array<string>(AE_SLOTS).fill(AE_EMPTY_LEAF);
	const other = [...leaves];
	leaves[7] = contentHash(mkWire("e1", "c1"));
	other[9] = contentHash(mkWire("e2", "c2"));
	const d = diffShardTrees(buildShardNodes(leaves), buildShardNodes(other));
	expect(d.sort()).toEqual([7, 9]);
	// a CONTENT drift on the same slot also reports (leaf = content hash)
	other[7] = contentHash({ ...mkWire("e1", "c1"), confidence: 0.9 });
	expect(
		diffShardTrees(buildShardNodes(leaves), buildShardNodes(other)).sort(),
	).toEqual([7, 9]);
});

// ─── canonical content ──────────────────────────────────────────────────────

test("contentHash: hub-local fields never affect it", () => {
	const w = mkWire("e1", "c1");
	const variants = [
		w,
		{ ...w, version: 99 },
		{ ...w, origin_machine: "ignored" }, // derived: canonicalOrigin wins
	];
	const base = contentHash(w);
	for (const v of variants) expect(contentHash(v)).toBe(base);
});

test("contentHash: provenance order and content both matter", () => {
	const w = mkWire("e1", "c1");
	// the same union in a different ORDER hashes identically (normalize sorts)
	expect(
		contentHash({
			...w,
			provenance: [
				{ machine: "m2", ts: 50 },
				{ machine: "m1", ts: 100 },
			],
		}),
	).toBe(
		contentHash({
			...w,
			provenance: [
				{ machine: "m1", ts: 100 },
				{ machine: "m2", ts: 50 },
			],
		}),
	);
	expect(
		contentHash({ ...w, provenance: [{ machine: "m1", ts: 101 }] }),
	).not.toBe(contentHash(w));
	expect(contentHash({ ...w, claim: "different" })).not.toBe(contentHash(w));
});

test("canonicalRow: tombstone and origin derive from the union", () => {
	const live = canonicalRow({
		...mkWire("e1", "c1"),
		origin_machine: "whatever",
	});
	expect(live.tombstone).toBe(false);
	expect(live.tombstone_ts).toBe(null);
	expect(live.origin_machine).toBe("m1"); // earliest asserter
	// a retraction not older than every assertion → tombstoned (ties → retract)
	const tombed = canonicalRow({
		...mkWire("e1", "c1"),
		tombstone: false,
		provenance: [
			{ machine: "m1", ts: 100 },
			{ machine: "m2", ts: 100, retract: true },
		],
	});
	expect(tombed.tombstone).toBe(true);
	expect(tombed.tombstone_ts).toBe(100);
	// a stale retraction never re-hides a revived claim
	const revived = canonicalRow({
		...mkWire("e1", "c1"),
		provenance: [
			{ machine: "m1", ts: 100 },
			{ machine: "m2", ts: 200, retract: true },
			{ machine: "m3", ts: 300 },
		],
	});
	expect(revived.tombstone).toBe(false);
	expect(canonicalOrigin([{ machine: "m2", ts: 50 }])).toBe("m2");
});

test("normalizeProvenance: union-normal form, max ts per key", () => {
	const norm = normalizeProvenance([
		{ machine: "m1", ts: 100 },
		{ machine: "m1", ts: 60 },
		{ machine: "m1", ts: 100 }, // exact dupe
		{ machine: "m2", ts: 50, retract: true },
		{ machine: "m2", ts: 30 },
	]);
	expect(norm).toEqual([
		{ machine: "m2", ts: 30 },
		{ machine: "m2", ts: 50, retract: true },
		{ machine: "m1", ts: 100 },
	]);
});

// ─── the wire validator ─────────────────────────────────────────────────────

test("parsePeerRow: strict — every field, nothing extra", () => {
	const w = mkWire("e1", "c1");
	expect(parsePeerRow(w)).not.toBeNull();
	expect(parsePeerRow({ ...w, extra: 1 })).toBeNull(); // unknown field
	expect(parsePeerRow({ ...w, claim_hash: "zz" })).toBeNull(); // not hex64
	expect(parsePeerRow({ ...w, version: 0 })).toBeNull();
	expect(parsePeerRow({ ...w, scope: "world" })).toBeNull();
	expect(parsePeerRow({ ...w, tombstone_ts: "soon" })).toBeNull();
	const noProv = { ...w } as Record<string, unknown>;
	delete noProv.provenance;
	expect(parsePeerRow(noProv)).toBeNull(); // missing field
	expect(parsePeerRow({ ...w, provenance: [] })).toBeNull(); // empty prov
	expect(
		parsePeerRow({ ...w, provenance: [{ machine: "", ts: 1 }] }),
	).toBeNull();
});

// ─── the merge (db-injected) ────────────────────────────────────────────────

test("mergePeerRows: insert, re-push no-op, union + max confidence", () => {
	const db = new Database(":memory:");
	expect(
		mergePeerRows(db, [mkWire("e1", "c1", "m1", 100)], { now: 500 }),
	).toEqual({
		ok: true,
		counts: { inserted: 1, merged: 0, unchanged: 0 },
	});
	// re-push: the identical row is a no-op
	expect(
		mergePeerRows(db, [mkWire("e1", "c1", "m1", 100)], { now: 500 }),
	).toEqual({
		ok: true,
		counts: { inserted: 0, merged: 0, unchanged: 1 },
	});
	// a different asserter: provenance grows, confidence is max()
	expect(
		mergePeerRows(db, [mkWire("e1", "c1", "m2", 200, 1, 0.9)], { now: 500 }),
	).toEqual({ ok: true, counts: { inserted: 0, merged: 1, unchanged: 0 } });
	const row = db
		.query(
			"SELECT confidence, origin_machine, provenance FROM knowledge_claims",
		)
		.get() as {
		confidence: number;
		origin_machine: string;
		provenance: string;
	};
	expect(row.confidence).toBe(0.9);
	expect(row.origin_machine).toBe("m1"); // still the earliest asserter
	expect(JSON.parse(row.provenance)).toEqual([
		{ machine: "m1", ts: 100 },
		{ machine: "m2", ts: 200 },
	]);
});

test("mergePeerRows: the transferred version is used only when its slot is free", () => {
	const db = new Database(":memory:");
	// v2 for ev-x arrives first, then another claim for ev-x transfers v2 → max+1
	expect(
		mergePeerRows(db, [mkWire("ev-x", "second", "m1", 100, 2)], { now: 1 }),
	).toEqual({
		ok: true,
		counts: { inserted: 1, merged: 0, unchanged: 0 },
	});
	expect(
		mergePeerRows(db, [mkWire("ev-x", "first", "m1", 90, 2)], { now: 1 }),
	).toEqual({
		ok: true,
		counts: { inserted: 1, merged: 0, unchanged: 0 },
	});
	const rows = db
		.query(
			"SELECT claim, version FROM knowledge_claims WHERE evidence_id = 'ev-x' ORDER BY version",
		)
		.all() as { claim: string; version: number }[];
	expect(rows.map((r) => r.version)).toEqual([2, 3]); // slot taken → max+1
});

test("mergePeerRows: tombstones converge from either direction", () => {
	// live locally, tombstoned remotely (later retraction) → tombstoned
	const a = new Database(":memory:");
	mergePeerRows(a, [mkWire("e1", "c1", "m1", 100)], { now: 1 });
	const t = {
		...mkWire("e1", "c1", "m2", 400),
		tombstone: true,
		tombstone_ts: 400,
		provenance: [
			{ machine: "m1", ts: 100 },
			{ machine: "m2", ts: 400, retract: true },
		],
	};
	expect(mergePeerRows(a, [t], { now: 2 })).toEqual({
		ok: true,
		counts: { inserted: 0, merged: 1, unchanged: 0 },
	});
	expect(
		a.query("SELECT tombstone, tombstone_ts FROM knowledge_claims").get(),
	).toEqual({
		tombstone: 1,
		tombstone_ts: 400,
	});
	// stale retraction (older than a revival) never re-hides
	const b = new Database(":memory:");
	mergePeerRows(b, [
		{
			...mkWire("e2", "c2", "m1", 300),
			provenance: [
				{ machine: "m1", ts: 100 },
				{ machine: "m2", ts: 200, retract: true },
				{ machine: "m3", ts: 300 },
			],
		},
	]);
	const stale = {
		...mkWire("e2", "c2"),
		tombstone: true,
		tombstone_ts: 200,
		provenance: [{ machine: "m2", ts: 200, retract: true }],
	};
	expect(mergePeerRows(b, [stale], { now: 3 })).toEqual({
		ok: true,
		counts: { inserted: 0, merged: 0, unchanged: 1 },
	});
	expect(b.query("SELECT tombstone FROM knowledge_claims").get()).toEqual({
		tombstone: 0,
	});
});

test("mergePeerRows: fails closed on a malformed batch, skips corrupt local rows", () => {
	const db = new Database(":memory:");
	mergePeerRows(db, [mkWire("e1", "c1")], { now: 1 });
	// corrupt the local provenance directly
	db.run("UPDATE knowledge_claims SET provenance = 'not-json'");
	expect(
		mergePeerRows(db, [mkWire("e1", "c1", "m2", 200)], { now: 2 }),
	).toEqual({
		ok: true,
		counts: { inserted: 0, merged: 0, unchanged: 1 },
	});
	expect(mergePeerRows(db, [{ junk: true }], { now: 2 }).ok).toBe(false);
	expect(mergePeerRows(db, "nope", { now: 2 }).ok).toBe(false);
});

// ─── the acceptance criteria, over the wire ─────────────────────────────────

type CallLog = { path: string; rows: number }[];
const serveHub = (
	db: Database,
	log: CallLog,
): { stop: () => void; url: string } => {
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const u = new URL(req.url);
			const body =
				req.method === "POST"
					? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
					: {};
			if (u.pathname === "/ae/root") {
				log.push({ path: "/ae/root", rows: 0 });
				return Response.json(aeRootFace(db));
			}
			if (u.pathname === "/ae/shard") {
				const idx = Number(u.searchParams.get("index"));
				log.push({ path: "/ae/shard", rows: 0 });
				const face = aeShardFace(db, idx);
				return Response.json(face, { status: face.ok ? 200 : 400 });
			}
			if (u.pathname === "/ae/leaves") {
				const face = aeLeavesFace(db, body);
				log.push({
					path: "/ae/leaves",
					rows: face.ok ? face.rows.length : 0,
				});
				return Response.json(face, { status: face.ok ? 200 : 422 });
			}
			if (u.pathname === "/ae/merge") {
				const face = aeMergeFace(db, body);
				log.push({
					path: "/ae/merge",
					rows: face.ok ? face.counts.inserted + face.counts.merged : 0,
				});
				return Response.json(face, { status: face.ok ? 200 : 422 });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	return {
		stop: () => server.stop(true),
		url: `http://127.0.0.1:${server.port}`,
	};
};

const rowsOf = (db: Database): { claim: string; tombstone: number }[] =>
	db
		.query("SELECT claim, tombstone FROM knowledge_claims ORDER BY claim")
		.all() as { claim: string; tombstone: number }[];

const rootOf = (db: Database): string => buildAeTrees(db).root;

const roll = (
	db: Database,
	ev: string,
	claim: string,
	conf: number,
	machine: string,
	ts: number,
	tombstone = false,
): void => {
	aggregateClaims(
		db,
		[
			{
				evidenceId: ev,
				claim,
				confidence: conf,
				ts,
				scope: "fleet",
				...(tombstone ? { tombstone: true } : {}),
			},
		],
		machine,
		{ now: 1000 },
	);
};

test("aePass: transfer volume proportional to divergence, not corpus", async () => {
	const dbA = new Database(":memory:");
	const dbB = new Database(":memory:");
	const corpus: {
		evidenceId: string;
		claim: string;
		confidence: number;
		ts: number;
		scope: string;
	}[] = [];
	for (let i = 0; i < 120; i++)
		corpus.push({
			evidenceId: `ev-${i}`,
			claim: `claim number ${i}`,
			confidence: 0.5,
			ts: 100 + i,
			scope: "fleet",
		});
	aggregateClaims(dbA, corpus, "m1", { now: 1000 });
	aggregateClaims(dbB, corpus, "m1", { now: 1000 });
	aggregateClaims(
		dbB,
		[
			{
				evidenceId: "ev-extra",
				claim: "the only divergent row",
				confidence: 0.8,
				ts: 999,
				scope: "fleet",
			},
		],
		"m1",
		{ now: 1000 },
	);
	const log: CallLog = [];
	const hub = serveHub(dbB, log);
	try {
		const r = await aePass(dbA, hub.url);
		expect(r.ok).toBe(true);
		expect(r.converged).toBe(true);
		// exactly the divergent row crossed, exactly one shard/slot diverged
		expect(r.pulled).toBe(1);
		expect(r.pushed).toBe(0);
		expect(r.shardsDivergent).toBe(1);
		expect(r.slotsDivergent).toBe(1);
		const rowCalls = log.filter(
			(c) => c.path === "/ae/leaves" || c.path === "/ae/merge",
		);
		expect(rowCalls.reduce((n, c) => n + c.rows, 0)).toBe(1);
		expect(rootOf(dbA)).toBe(rootOf(dbB));
	} finally {
		hub.stop();
	}
});

test("aePass: two divergent hubs converge after ONE exchange", async () => {
	const dbA = new Database(":memory:");
	const dbB = new Database(":memory:");
	roll(dbA, "e-shared", "shared claim text", 0.4, "m1", 100);
	roll(dbA, "e-a-only", "only on A", 0.6, "m1", 110);
	// same key on B but drifted content: higher confidence, second asserter
	roll(dbB, "e-shared", "shared claim text", 0.9, "m2", 150);
	roll(dbB, "e-b-only", "only on B", 0.7, "m2", 160);
	const hub = serveHub(dbB, []);
	try {
		const r = await aePass(dbA, hub.url);
		expect(r.ok).toBe(true);
		expect(r.converged).toBe(true);
		expect(r.pulled).toBe(2);
		expect(r.pushed).toBe(2);
		// one pass → byte-identical root vectors, both directions applied
		expect(rootOf(dbA)).toBe(rootOf(dbB));
		const shared = dbA
			.query(
				"SELECT confidence, origin_machine, provenance FROM knowledge_claims WHERE evidence_id = 'e-shared'",
			)
			.get() as {
			confidence: number;
			origin_machine: string;
			provenance: string;
		};
		expect(shared.confidence).toBe(0.9); // max-register wins
		expect(shared.origin_machine).toBe("m1"); // earliest asserter
		expect(
			JSON.parse(shared.provenance).map((p: { machine: string }) => p.machine),
		).toEqual(["m1", "m2"]);
	} finally {
		hub.stop();
	}
});

test("aePass: identical hubs exchange NOTHING (root equality short-circuit)", async () => {
	const seed = (db: Database): void => {
		roll(db, "e1", "c1", 0.5, "m1", 100);
		roll(db, "e2", "c2", 0.5, "m1", 101);
		roll(db, "e3", "c3", 0.5, "m1", 102);
	};
	const dbA = new Database(":memory:");
	const dbB = new Database(":memory:");
	seed(dbA);
	seed(dbB);
	const log: CallLog = [];
	const hub = serveHub(dbB, log);
	try {
		const r = await aePass(dbA, hub.url);
		expect(r.ok).toBe(true);
		expect(r.rootEqual).toBe(true);
		expect(r.converged).toBe(true);
		expect(r.pulled).toBe(0);
		expect(r.pushed).toBe(0);
		// the whole protocol was ONE root call — no shard, no row crossed
		expect(log.map((c) => c.path)).toEqual(["/ae/root"]);
	} finally {
		hub.stop();
	}
});

test("aePass: a remote retraction converges both hubs to the tombstone", async () => {
	const dbA = new Database(":memory:");
	const dbB = new Database(":memory:");
	roll(dbA, "e-t", "to be retracted", 0.5, "m1", 100);
	// B holds the same claim, tombstoned by a later retraction
	mergePeerRows(
		dbB,
		[
			{
				...mkWire("e-t", "to be retracted", "m2", 400),
				tombstone: true,
				tombstone_ts: 400,
				provenance: [
					{ machine: "m1", ts: 100 },
					{ machine: "m2", ts: 400, retract: true },
				],
			},
		],
		{ now: 1 },
	);
	const hub = serveHub(dbB, []);
	try {
		const r = await aePass(dbA, hub.url);
		expect(r.ok).toBe(true);
		expect(r.converged).toBe(true);
		expect(rowsOf(dbA)).toEqual(rowsOf(dbB));
		expect(rowsOf(dbA)).toEqual([{ claim: "to be retracted", tombstone: 1 }]);
	} finally {
		hub.stop();
	}
});
