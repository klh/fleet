// test/knowledge-consolidate.test.ts — W1227 consolidation flow: the pure
// similarity/band/winner layer, then the sweep → propose → dispose round
// trip on an isolated temp HOME (w208's isolation + query-bust import
// pattern). The CrewAI regression guards get their own tests: provenance is
// carried forward mechanically on approve-update, and competing explanations
// are never proposed against.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w1227-"));
// restore before afterAll cleanup: the rest of the suite shares this process —
// a leaked fixture HOME rides later spawns' {...process.env} spreads (W1124.11)
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const { openGovernorDb, openKnowledgeDb } = await import(
	`../hooks/lib/govdb.ts?w1227=${encodeURIComponent(HOME)}`
);

const DAY = 86_400_000;
const NOW = Date.now();
mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });

afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});

// seed one live knowledge row; disjoint token sets per fixture group keep
// unintended pair classifications out of the assertions
type SeedOpts = {
	topic: string;
	fact: string;
	confidence?: number;
	state?: string;
	updatedDaysAgo?: number;
	rating?: string;
	researchedDaysAgo?: number;
	source?: string;
	sourceRef?: string;
	sourceHash?: string;
	originSid?: string;
};

function seed(opts: SeedOpts): number {
	const kb = openKnowledgeDb();
	const updated = NOW - (opts.updatedDaysAgo ?? 0) * DAY;
	const r = kb
		.query(
			"INSERT INTO knowledge (ts, topic, fact, confidence, state, updated_at, rating, researched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			updated,
			opts.topic,
			opts.fact,
			opts.confidence ?? 0.8,
			opts.state ?? "active",
			updated,
			opts.rating ?? null,
			opts.researchedDaysAgo !== undefined
				? NOW - opts.researchedDaysAgo * DAY
				: null,
		);
	const id = Number(r.lastInsertRowid);
	if (opts.source || opts.sourceRef || opts.sourceHash || opts.originSid) {
		kb.query(
			"UPDATE knowledge SET source = ?, source_ref = ?, source_hash = ?, origin_sid = ? WHERE id = ?",
		).run(
			opts.source ?? "seed",
			opts.sourceRef ?? null,
			opts.sourceHash ?? null,
			opts.originSid ?? null,
			id,
		);
	}
	return id;
}

function row(id: number): {
	state: string;
	fact: string;
	version: number;
	superseded_by: number | null;
} {
	const kb = openKnowledgeDb();
	return kb
		.query(
			"SELECT state, fact, COALESCE(version, 1) AS version, superseded_by FROM knowledge WHERE id = ?",
		)
		.get(id) as {
		state: string;
		fact: string;
		version: number;
		superseded_by: number | null;
	};
}

function contributors(id: number): { sid: string; what: string }[] {
	const kb = openKnowledgeDb();
	const r = kb
		.query("SELECT contributors FROM knowledge WHERE id = ?")
		.get(id) as { contributors: string | null } | undefined;
	try {
		return JSON.parse(r?.contributors ?? "[]") as {
			sid: string;
			what: string;
		}[];
	} catch {
		return [];
	}
}

function proposal(id: number): {
	state: string;
	kind: string;
	reason: string;
	payload: string | null;
} {
	const kb = openKnowledgeDb();
	return kb
		.query(
			"SELECT state, kind, reason, payload FROM knowledge_proposals WHERE id = ?",
		)
		.get(id) as {
		state: string;
		kind: string;
		reason: string;
		payload: string | null;
	};
}

// open consolidate proposals keyed by their nominee row
function openProposals(): Map<
	number,
	{ id: number; kind: string; payload: string }
> {
	const kb = openKnowledgeDb();
	const out = new Map<number, { id: number; kind: string; payload: string }>();
	for (const r of kb
		.query(
			"SELECT id, knowledge_id, kind, payload FROM knowledge_proposals WHERE state = 'open' and kind LIKE 'consolidate-%'",
		)
		.all() as {
		id: number;
		knowledge_id: number;
		kind: string;
		payload: string;
	}[])
		out.set(r.knowledge_id, { id: r.id, kind: r.kind, payload: r.payload });
	return out;
}

function sourceOf(id: number): {
	source: string | null;
	sourceRef: string | null;
	sourceHash: string | null;
	originSid: string | null;
} {
	const kb = openKnowledgeDb();
	return kb
		.query(
			"SELECT source, source_ref AS sourceRef, source_hash AS sourceHash, origin_sid AS originSid FROM knowledge WHERE id = ?",
		)
		.get(id) as {
		source: string | null;
		sourceRef: string | null;
		sourceHash: string | null;
		originSid: string | null;
	};
}

let SqliteKnowledgeStore: new (
	db: Database,
) => import("../hooks/lib/knowledge-ports.ts").SqliteKnowledgeStore;
let consolidateSweep: typeof import("../hooks/lib/knowledge-consolidate.ts").consolidateSweep;
let classifyPair: typeof import("../hooks/lib/knowledge-consolidate.ts").classifyPair;
let consolidateTokens: typeof import("../hooks/lib/knowledge-consolidate.ts").consolidateTokens;
let jaccardOverlap: typeof import("../hooks/lib/knowledge-consolidate.ts").jaccardOverlap;
let consolidateBetter: typeof import("../hooks/lib/knowledge-consolidate.ts").consolidateBetter;
let consolidatedFact: typeof import("../hooks/lib/knowledge-consolidate.ts").consolidatedFact;
let CONSOLIDATE_MAX_ROWS: number;
type ConsolidateRowShape =
	import("../hooks/lib/knowledge-consolidate.ts").ConsolidateRow;

function gov(): Database {
	return openGovernorDb();
}

// governor open bootstraps the kb schema (v10 split); knowledge.db's own
// extra tables self-heal on every openKnowledgeDb.
function freshKb(): Database {
	return openGovernorDb() && openKnowledgeDb();
}

test("boot", async () => {
	const kb = freshKb();
	expect(kb).toBeDefined();
	({ SqliteKnowledgeStore } = await import("../hooks/lib/knowledge-ports.ts"));
	({
		consolidateSweep,
		classifyPair,
		consolidateTokens,
		jaccardOverlap,
		consolidateBetter,
		consolidatedFact,
		CONSOLIDATE_MAX_ROWS,
	} = await import("../hooks/lib/knowledge-consolidate.ts"));
	expect(openProposals().size).toBe(0);
});

test("tokens + jaccard: >2-char lowercase tokens, identical = 1, disjoint = 0", () => {
	const a = consolidateTokens("Retry Backoff caps lane-storms");
	expect(a.has("retry")).toBe(true);
	expect(a.has("caps")).toBe(true);
	expect(a.has("lane-storms")).toBe(true);
	expect(a.has("of")).toBe(false); // ≤2-char tokens dropped
	const b = consolidateTokens("retry backoff caps lane-storms");
	expect(jaccardOverlap(a, b)).toBe(1);
	expect(
		jaccardOverlap(a, consolidateTokens("wholly different words here")),
	).toBe(0);
	expect(jaccardOverlap(new Set(), new Set(["x"]))).toBe(0);
});

test("consolidateBetter + consolidatedFact: evidence > confidence > recency", () => {
	const mk = (o: Partial<ConsolidateRowShape>): ConsolidateRowShape => ({
		id: 0,
		topic: "",
		fact: "",
		confidence: 0.5,
		state: "active",
		ts: NOW,
		updatedAt: NOW,
		version: 1,
		source: null,
		sourceRef: null,
		sourceHash: null,
		originSid: null,
		rating: null,
		researchedAt: null,
		...o,
	});
	expect(consolidateBetter(mk({ rating: "verified" }), mk())).toBe(true);
	expect(
		consolidateBetter(mk({ researchedAt: 1 }), mk({ confidence: 0.99 })),
	).toBe(true);
	expect(
		consolidateBetter(mk({ confidence: 0.9 }), mk({ confidence: 0.5 })),
	).toBe(true);
	expect(
		consolidateBetter(mk({ updatedAt: NOW }), mk({ updatedAt: NOW - DAY })),
	).toBe(true);
	expect(consolidateBetter(mk(), mk())).toBe(true); // tie → deterministic
	const w = mk({ fact: "winner text" });
	const l = mk({ fact: "loser text" });
	expect(consolidatedFact(w, l)).toBe("winner text | loser text");
});

function bandRow(o: Partial<ConsolidateRowShape>): ConsolidateRowShape {
	return {
		id: 0,
		topic: "",
		fact: "",
		confidence: 0.5,
		state: "active",
		ts: NOW,
		updatedAt: NOW,
		version: 1,
		source: null,
		sourceRef: null,
		sourceHash: null,
		originSid: null,
		rating: null,
		researchedAt: null,
		...o,
	};
}

test("classifyPair: dup band deletes; below the floor retains", () => {
	// sim 1.0 → delete band
	const dup = classifyPair(
		bandRow({ topic: "same topic", fact: "exact duplicate text" }),
		bandRow({ topic: "same topic", fact: "exact duplicate text" }),
		0.45,
		0.75,
	);
	expect(dup.action).toBe("delete");
	expect(dup.mergedFact).toBeNull();
	// below the update floor → distinct, retain
	const far = classifyPair(
		bandRow({ topic: "alpha topic", fact: "unrelated words entirely" }),
		bandRow({ topic: "omega topic", fact: "different vocabulary set" }),
		0.45,
		0.75,
	);
	expect(far.action).toBe("retain");
});

test("classifyPair: partial band merges candidate sides, retains two promoted", () => {
	// sim 0.5, one side candidate → update; higher confidence wins
	const upd = classifyPair(
		bandRow({
			id: 1,
			topic: "cache warm cand00",
			fact: "cache warm improves lane latency",
			state: "candidate",
			confidence: 0.4,
		}),
		bandRow({
			id: 2,
			topic: "cache warm actv00",
			fact: "cache warm improves lane throughput",
			confidence: 0.9,
		}),
		0.5,
		0.75,
	);
	expect(upd.action).toBe("update");
	expect(upd.winner.id).toBe(2);
	expect(upd.loser.id).toBe(1);
	expect(upd.mergedFact).toBe(
		"cache warm improves lane throughput | cache warm improves lane latency",
	);
	// sim 0.5, both promoted → competing explanations, retained
	const comp = classifyPair(
		bandRow({ topic: "retry err1", fact: "retry backoff caps lane storms" }),
		bandRow({ topic: "retry err2", fact: "retry backoff caps lane floods" }),
		0.5,
		0.75,
	);
	expect(comp.action).toBe("retain");
});

test("planner: open-proposal block, dismiss cooldown, one nomination per loser", async () => {
	const { planConsolidation } = await import(
		"../hooks/lib/knowledge-consolidate.ts"
	);
	const txt = { topic: "planner probe", fact: "planner probe fact text" };
	const rows = [
		bandRow({ id: 11, confidence: 0.9, ...txt }),
		bandRow({ id: 12, confidence: 0.4, ...txt }),
	];
	// open proposal on the loser → silent block
	const blocked = {
		open: new Set([12]),
		dismissedAt: new Map<number, number>(),
	};
	expect(planConsolidation(rows, blocked, { now: NOW }).propose).toEqual([]);
	// fresh dismissal → cooldown skip (30d); aged dismissal → re-proposes
	const cool = {
		open: new Set<number>(),
		dismissedAt: new Map([[12, NOW - 10 * DAY]]),
	};
	expect(planConsolidation(rows, cool, { now: NOW }).propose).toEqual([]);
	const aged = {
		open: new Set<number>(),
		dismissedAt: new Map([[12, NOW - 40 * DAY]]),
	};
	expect(planConsolidation(rows, aged, { now: NOW }).propose.length).toBe(1);
	// one nomination per loser: triple identical rows → 2 drafts (not 3)
	const trio = [
		bandRow({ id: 21, confidence: 0.9, ...txt }),
		bandRow({ id: 22, confidence: 0.5, ...txt }),
		bandRow({ id: 23, confidence: 0.5, ...txt }),
	];
	const t = planConsolidation(
		trio,
		{ open: new Set(), dismissedAt: new Map() },
		{ now: NOW },
	);
	expect(t.propose.map((d) => d.nominee.id)).toEqual([22, 23]);
});

// the sweep round-trip fixtures — module scope so the dispose tests reuse them
let kA = 0;
let kB = 0;
let kC = 0;
let kD = 0;
let kE = 0;
let kF = 0;

test("sweep round-trip: dup + candidate-merge pairs mint proposals", () => {
	kA = seed({
		topic: "gateway auth",
		fact: "gateway auth uses signed mac tokens",
	});
	kB = seed({
		topic: "gateway auth",
		fact: "gateway auth uses signed mac tokens",
	});
	kC = seed({
		topic: "cache warm cand10",
		fact: "cache warm improves lane latency",
		state: "candidate",
		confidence: 0.4,
	});
	kD = seed({
		topic: "cache warm actv10",
		fact: "cache warm improves lane throughput",
		confidence: 0.9,
	});
	const res = consolidateSweep(openKnowledgeDb(), gov());
	const drafts = new Map(res.propose.map((d) => [d.nominee.id, d]));
	expect(drafts.get(kB)?.action).toBe("delete");
	expect(drafts.get(kC)?.action).toBe("update");
	expect(drafts.get(kC)?.winner.id).toBe(kD);
	kE = seed({ topic: "retry err20", fact: "retry backoff caps lane storms" });
	kF = seed({ topic: "retry err21", fact: "retry backoff caps lane floods" });
	const res2 = consolidateSweep(openKnowledgeDb(), gov());
	expect(res2.retainedCompeting.map((c) => [c.aId, c.bId])).toEqual(
		expect.arrayContaining([[kE, kF]]),
	);
	expect(res2.skipped).toBe(0);
	// proposals ride the minted payload verbatim
	const payload = JSON.parse(openProposals().get(kB)?.payload ?? "{}") as {
		action: string;
		nominee: { id: number; version: number };
		winner: { id: number; version: number };
	};
	expect(payload.action).toBe("delete");
	expect(payload.nominee.id).toBe(kB);
	expect(payload.nominee.version).toBe(1);
	expect(payload.winner.id).toBe(kA);
});

test("dispose approve delete: nominee retires superseded-by winner, version bumps", async () => {
	const store = new SqliteKnowledgeStore(openKnowledgeDb());
	const pid = openProposals().get(kB)?.id ?? 0;
	expect(pid).toBeGreaterThan(0);
	const res = await store.disposeProposal(pid, "approve", { by: "human" });
	expect(res.ok).toBe(true);
	expect(res.retired).toBe(true);
	const l = row(kB);
	expect(l.state).toBe("retired");
	expect(l.superseded_by).toBe(kA);
	expect(l.version).toBe(2); // CAS ledger bumped
	expect(row(kA).version).toBe(1); // winner untouched
	expect(row(kA).fact).toBe("gateway auth uses signed mac tokens");
	expect(proposal(pid).state).toBe("approved");
	// append-only note rides the nominee
	expect(
		contributors(kB).some((c) =>
			c.what.includes(`retired by consolidation into k#${kA}`),
		),
	).toBe(true);
});

test("dispose approve update: provenance carried forward, never dropped", async () => {
	// fresh pair with disjoint tokens: winner active (kD-like), nominee candidate
	const w = seed({
		topic: "merge base actv12",
		fact: "merge base grows lane yield",
		confidence: 0.9,
	});
	const n = seed({
		topic: "merge base cand12",
		fact: "merge base grows lane spend",
		state: "candidate",
		confidence: 0.4,
		source: "agent:lane-x",
		sourceRef: "docs/x.md",
		sourceHash: "hash-c12",
		originSid: "sid-x",
	});
	const before = sourceOf(w);
	consolidateSweep(openKnowledgeDb(), gov());
	const pid = openProposals().get(n)?.id ?? 0;
	expect(pid).toBeGreaterThan(0);
	const store = new SqliteKnowledgeStore(openKnowledgeDb());
	const res = await store.disposeProposal(pid, "approve", { by: "human" });
	expect(res.ok).toBe(true);
	expect(res.retired).toBe(true);
	expect(row(w).fact).toBe(
		"merge base grows lane yield | merge base grows lane spend",
	);
	expect(row(n).state).toBe("retired");
	expect(row(n).superseded_by).toBe(w);
	expect(row(w).version).toBe(2);
	// THE CrewAI guard: the winner's provenance is bit-identical post-merge
	expect(sourceOf(w)).toEqual(before);
	expect(
		contributors(w).some((c) => c.what.includes(`consolidated k#${n}`)),
	).toBe(true);
});

test("sweep cap: corpus past CONSOLIDATE_MAX_ROWS reports, does not sweep", () => {
	for (let i = 0; i <= CONSOLIDATE_MAX_ROWS; i++)
		seed({
			topic: `cap fill ${i}`,
			fact: `cap filler row number ${i} unique token${i}`,
		});
	const res = consolidateSweep(openKnowledgeDb(), gov());
	expect(res.overCap).toBe(true);
	expect(res.propose).toEqual([]);
	expect(res.pairs).toBe(0);
	// restore the corpus so later tests sweep a sub-cap fixture
	openKnowledgeDb()
		.query("DELETE FROM knowledge WHERE topic LIKE 'cap fill %'")
		.run();
});

test("CAS stale refusal: row moved since mint → proposal closes stale, nothing mutates", async () => {
	// a fresh dup pair for this test only
	const g = seed({ topic: "stale probe", fact: "stale probe fact text" });
	const h = seed({ topic: "stale probe", fact: "stale probe fact text" });
	consolidateSweep(openKnowledgeDb(), gov());
	const pid = openProposals().get(h)?.id ?? 0;
	expect(pid).toBeGreaterThan(0);
	const store = new SqliteKnowledgeStore(openKnowledgeDb());
	// the nominee moves after mint: a note() bumps the row version
	await store.note(h, "w1227-test", "touched after mint");
	const res = await store.disposeProposal(pid, "approve", { by: "human" });
	expect(res.ok).toBe(true);
	expect(res.stale).toBe(true);
	expect(res.retired).toBe(false);
	// neither row mutated
	expect(row(g).state).toBe("active");
	expect(row(h).state).toBe("active");
	expect(row(h).version).toBe(2); // the note() bump, nothing more
	expect(row(g).version).toBe(1);
	expect(proposal(pid).state).toBe("stale");
});

test("plane events: sweep emits knowledge.consolidate; approves emit knowledge.consolidated", () => {
	const evs = gov()
		.query(
			"SELECT kind FROM events WHERE scope = 'knowledge' AND kind IN ('knowledge.consolidate', 'knowledge.consolidated') ORDER BY ts",
		)
		.all() as { kind: string }[];
	const kinds = new Set(evs.map((e) => e.kind));
	expect(kinds.has("knowledge.consolidate")).toBe(true);
	expect(kinds.has("knowledge.consolidated")).toBe(true);
});

test("cli: knowledge-consolidate routes through coord", async () => {
	const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
	const p = Bun.spawnSync(
		["bun", coord, "knowledge-consolidate", "--as", "cli-w1227"],
		{
			cwd: import.meta.dir,
			env: { ...process.env, HOME },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(p.exitCode).toBe(0);
	expect(p.stdout.toString()).toContain("consolidate:");
});

test("maintenance registry: the consolidate task resolves at the package root", async () => {
	const { MAINTENANCE_TASKS, missingRunners } = await import(
		"../hooks/lib/fleet-loop/maintenance.ts"
	);
	const t = MAINTENANCE_TASKS.find((x) => x.name === "knowledge-consolidate");
	expect(t).toBeDefined();
	expect(t?.everySeconds).toBe(21_600);
	expect(missingRunners()).toEqual([]);
});
