// distill-graph@unit.e2e.ts — fork G: the knowledge graph and its jobs.
// Deterministic extraction + recall by path, crosslinks (embed + rerank),
// distilled candidates with provenance (never active), dedupe proposals
// (never deletes), drift marks after a source edit, contradiction flags,
// k-hop / path / about queries, hub-sync precedence, the hub lease, and the
// k=2 traversal benchmark on 10k nodes / 50k edges.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractEntities,
	refPath,
} from "../hooks/lib/knowledge/distill/extract.ts";
import {
	aboutTarget,
	contradictions,
	graphPath,
	neighbours,
	recallByPaths,
	upsertEdge,
	upsertNode,
} from "../hooks/lib/knowledge/distill/graph.ts";
import { DRIFT_REASON } from "../hooks/lib/knowledge/distill/jobs-local.ts";
import {
	acquireLease,
	releaseLease,
} from "../hooks/lib/knowledge/distill/lease.ts";
import { runOnce } from "../hooks/lib/knowledge/distill/runner.ts";
import { ensureDistillSchema } from "../hooks/lib/knowledge/distill/schema.ts";
import {
	exportGraphDelta,
	importGraphDelta,
} from "../hooks/lib/knowledge/distill/sync.ts";
import {
	addEntry,
	fileHash,
	knowledgeDb,
	world,
} from "./fixtures/distill-world.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "distill-graph-"));

test("extractors pull paths, packages, W-ids, shas, ports, labels, knobs, models", () => {
	const got = extractEntities(
		"W2274.3 broke packages/buckle/src/router-walk.ts:348 (@klh/telemetry) at 3c463b41; :8907 + com.suspenders.fleet-loop; SUSPENDERS_GC_DAYS on glm-5.3-flash",
	).map((e) => `${e.kind}:${e.key}`);
	for (const want of [
		"work_item:W2274.3",
		"code:packages/buckle/src/router-walk.ts",
		"package:telemetry",
		"package:buckle",
		"commit:3c463b41",
		"service::8907",
		"service:com.suspenders.fleet-loop",
		"config_key:SUSPENDERS_GC_DAYS",
		"model:glm-5.3-flash",
	])
		expect(got).toContain(want);
	expect(refPath("packages/x/y.ts:12 — why")).toBe("packages/x/y.ts");
	expect(refPath("not a path")).toBeNull();
});

test("extract writes about/applies_to edges; recall by path returns the file's lessons", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	const lesson = addEntry(db, {
		topic: "lesson: retry-after floor",
		fact: "router-walk sleeps on 429; cap via retry_after_cap_s",
		originKind: "lesson",
		sourceRef: "packages/buckle/src/router-walk.ts:348",
	});
	const finding = addEntry(db, {
		topic: "finding",
		fact: "packages/buckle/src/router-walk.ts mentioned in passing",
	});
	const w = world(db, { logDir: dir });
	try {
		const r = await runOnce(w.deps, { jobs: ["extract"] });
		expect(r.outcome).toBe("ok");
		const hits = aboutTarget(db, "packages/buckle/src/router-walk.ts");
		expect(hits.map((h) => h.knowledgeId)).toEqual([lesson, finding]);
		expect(hits[0].edge).toBe("about");
		expect(recallByPaths(db, ["buckle/src/router-walk.ts"])).toEqual([
			lesson,
			finding,
		]);
		expect(aboutTarget(db, "W9999")).toEqual([]);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("crosslink writes related candidate edges; distill lands a candidate with source_refs; dedupe proposes, never deletes", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	const fact =
		"buckle quota wall walk sleeps through retry after floor until lanes time out";
	const ids = [
		addEntry(db, {
			topic: "quota wall hang",
			fact,
			sourceRef: "packages/buckle/src/router-walk.ts",
		}),
		addEntry(db, { topic: "quota wall hang", fact: `${fact} again` }),
		addEntry(db, {
			topic: "quota wall hang seen",
			fact: `${fact} on the spoke`,
		}),
	];
	const unrelated = addEntry(db, {
		topic: "lit board",
		fact: "board tabs render with lit components and design tokens",
	});
	const w = world(db, {
		logDir: dir,
		withRerank: true,
		cfg: { cluster_min: 0.6, duplicate_min: 0.9 },
		chat: {
			answer: (system) =>
				system.includes("distill")
					? '```json\n{"topic": "buckle: cap retry-after", "fact": "Quota-wall 429s made buckle sleep through Retry-After; cap it so lanes get a fast answer.", "confidence": 0.9}\n```'
					: '{"contradicts": false, "reason": ""}',
			tokens: 50,
		},
	});
	try {
		await runOnce(w.deps, { jobs: ["crosslink"] });
		const related = db
			.query(
				"SELECT src, dst, state, created_by FROM kg_edges WHERE type = 'related'",
			)
			.all();
		expect(related.length).toBe(3);
		expect(
			related.every(
				(e) =>
					e.state === "candidate" && e.created_by === "crosslink:embed+rerank",
			),
		).toBe(true);
		const unrelatedNode = db
			.query("SELECT id FROM kg_nodes WHERE ref = ?")
			.get(`knowledge:${unrelated}`).id;
		expect(
			related.some((e) => e.src === unrelatedNode || e.dst === unrelatedNode),
		).toBe(false);
		expect(w.up.embed.requests.length).toBe(1); // one batched embeddings POST

		const before = db.query("SELECT COUNT(*) AS n FROM knowledge").get().n;
		await runOnce(w.deps, { jobs: ["dedupe"] });
		const props = db
			.query(
				"SELECT knowledge_id, kind, payload, state FROM knowledge_proposals",
			)
			.all();
		expect(props.length).toBeGreaterThan(0);
		expect(
			props.every((p) => p.kind === "distill-dedupe" && p.state === "open"),
		).toBe(true);
		expect(db.query("SELECT COUNT(*) AS n FROM knowledge").get().n).toBe(
			before,
		);
		expect(
			db
				.query("SELECT COUNT(*) AS n FROM knowledge WHERE state = 'retired'")
				.get().n,
		).toBe(0);
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM kg_edges WHERE type = 'duplicate_of' AND state = 'candidate'",
				)
				.get().n,
		).toBeGreaterThan(0);

		const r = await runOnce(w.deps, { jobs: ["distill"] });
		expect(r.tokens).toBe(50); // one cluster, one call — the others are the same signature
		const d = db
			.query(
				"SELECT id, state, origin_kind, provenance, confidence FROM knowledge WHERE origin_kind = 'distilled'",
			)
			.all();
		expect(d.length).toBe(1);
		expect(d[0].state).toBe("candidate");
		expect(d[0].confidence).toBeLessThanOrEqual(0.6);
		const prov = JSON.parse(d[0].provenance);
		for (const id of ids) expect(prov.source_refs).toContain(`knowledge:${id}`);
		expect(prov.source_refs).toContain("packages/buckle/src/router-walk.ts");
		const derived = db
			.query(
				"SELECT COUNT(*) AS n FROM kg_edges e JOIN kg_nodes n ON n.id = e.src WHERE e.type = 'derived_from' AND n.ref = ?",
			)
			.get(`knowledge:${d[0].id}`).n;
		expect(derived).toBe(3);
		expect(w.kevCalls.length).toBe(1);
		// re-running spends nothing: the cluster signature is remembered
		const again = await runOnce(w.deps, { jobs: ["distill"] });
		expect(again.tokens).toBe(0);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Kev noise drops the draft; Kev unavailable parks it without re-spending", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	for (let i = 0; i < 3; i++)
		addEntry(db, {
			topic: "spoke kickstart revives",
			fact: `routing policy fallbacks shape spoke kickstart revives buckle ${i}`,
		});
	let verdict = "unavailable";
	const w = world(db, {
		logDir: dir,
		cfg: { cluster_min: 0.6 },
		kev: () => verdict,
		chat: {
			answer: () =>
				'{"topic": "spoke revive", "fact": "Kickstart the spoke after editing routing-policy fallbacks."}',
			tokens: 40,
		},
	});
	try {
		await runOnce(w.deps, { jobs: ["crosslink"] });
		const r1 = await runOnce(w.deps, { jobs: ["distill"] });
		expect(r1.tokens).toBe(40);
		expect(db.query("SELECT state FROM distill_clusters").get().state).toBe(
			"pending-kev",
		);
		verdict = "store";
		db.run("DELETE FROM distill_visits");
		const r2 = await runOnce(w.deps, { jobs: ["distill"] });
		expect(r2.tokens).toBe(0); // the parked draft is re-asked, not re-generated
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM knowledge WHERE origin_kind = 'distilled' AND state = 'candidate'",
				)
				.get().n,
		).toBe(1);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("staleness marks hash drift after a source edit and clears its own mark", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	const file = join(dir, "src.ts");
	writeFileSync(file, "export const a = 1;\n");
	const id = addEntry(db, {
		topic: "a is one",
		fact: "src.ts exports a = 1",
		sourceRef: "src.ts",
		sourceHash: fileHash(file),
	});
	const w = world(db, { logDir: dir, cfg: { repo_roots: [dir] } });
	try {
		await runOnce(w.deps, { jobs: ["staleness"] });
		expect(
			db.query("SELECT stale_at FROM knowledge WHERE id = ?").get(id).stale_at,
		).toBeNull();
		writeFileSync(file, "export const a = 2;\n");
		await runOnce(w.deps, { jobs: ["staleness"] });
		const row = db
			.query("SELECT stale_at, stale_reason FROM knowledge WHERE id = ?")
			.get(id);
		expect(row.stale_at).not.toBeNull();
		expect(row.stale_reason).toBe(DRIFT_REASON);
		writeFileSync(file, "export const a = 1;\n");
		await runOnce(w.deps, { jobs: ["staleness"] });
		expect(
			db.query("SELECT stale_at FROM knowledge WHERE id = ?").get(id).stale_at,
		).toBeNull();
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("contradictions become candidate edges plus a proposal; pairs are judged once", async () => {
	const dir = tmp();
	const db = knowledgeDb();
	addEntry(db, {
		topic: "lane target",
		fact: "fleet loop lane target defaults to eight lanes per hub",
		state: "active",
	});
	const weak = addEntry(db, {
		topic: "lane target",
		fact: "fleet loop lane target defaults to twenty lanes per hub",
		state: "candidate",
	});
	const w = world(db, {
		logDir: dir,
		chat: {
			answer: () => '{"contradicts": true, "reason": "eight vs twenty"}',
			tokens: 20,
		},
	});
	try {
		await runOnce(w.deps, { jobs: ["crosslink"] });
		await runOnce(w.deps, { jobs: ["contradiction"] });
		const c = contradictions(db);
		expect(c.length).toBe(1);
		expect(c[0].state).toBe("candidate");
		const p = db
			.query("SELECT knowledge_id, kind FROM knowledge_proposals")
			.all();
		expect(p).toEqual([{ knowledge_id: weak, kind: "distill-contradiction" }]);
		const calls = w.up.chat.requests.length;
		db.run("DELETE FROM distill_visits");
		await runOnce(w.deps, { jobs: ["contradiction"] });
		expect(w.up.chat.requests.length).toBe(calls);
	} finally {
		w.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("k-hop neighbours, shortest path and rejected-edge pruning", () => {
	const db = new Database(":memory:");
	ensureDistillSchema(db);
	const n = ["a", "b", "c", "d"].map((k) =>
		upsertNode(db, { kind: "code", key: k }),
	);
	upsertEdge(db, {
		src: n[0],
		dst: n[1],
		type: "related",
		createdBy: "t",
		state: "active",
	});
	upsertEdge(db, {
		src: n[2],
		dst: n[1],
		type: "related",
		createdBy: "t",
		state: "active",
	});
	upsertEdge(db, {
		src: n[2],
		dst: n[3],
		type: "related",
		createdBy: "t",
		state: "active",
	});
	expect(neighbours(db, n[0], { depth: 1 }).map((x) => x.key)).toEqual(["b"]);
	expect(
		neighbours(db, n[0], { depth: 2 }).map((x) => [x.key, x.depth]),
	).toEqual([
		["b", 1],
		["c", 2],
	]);
	expect(graphPath(db, n[0], n[3])).toEqual([n[0], n[1], n[2], n[3]]);
	// a human rejection is never overwritten by a machine re-observation
	upsertEdge(db, {
		src: n[2],
		dst: n[3],
		type: "related",
		createdBy: "human",
		state: "rejected",
	});
	expect(
		upsertEdge(db, {
			src: n[2],
			dst: n[3],
			type: "related",
			createdBy: "crosslink",
			state: "candidate",
		}),
	).toBe(false);
	expect(graphPath(db, n[0], n[3])).toBeNull();
});

test("hub sync: keyed export, content-keyed entries, state precedence on import", () => {
	const a = knowledgeDb();
	const b = knowledgeDb();
	const ea = upsertNode(a, {
		kind: "entry",
		key: "knowledge:1",
		hash: "h1",
		ref: "knowledge:1",
	});
	const ca = upsertNode(a, { kind: "code", key: "packages/x.ts" });
	upsertEdge(
		a,
		{ src: ea, dst: ca, type: "about", createdBy: "extract", state: "active" },
		100,
	);
	// an unscrubbed decant node never leaves the machine
	upsertNode(a, {
		kind: "session",
		key: "decant:raw",
		props: { origin: "decant", scrubbed: false },
	});
	const delta = exportGraphDelta(a, 0);
	expect(delta.nodes.map((x) => x.key).sort()).toEqual([
		"content:h1",
		"packages/x.ts",
	]);
	// b already has the same entry content under its own row id
	const eb = upsertNode(b, {
		kind: "entry",
		key: "knowledge:77",
		hash: "h1",
		ref: "knowledge:77",
	});
	const cb = upsertNode(b, { kind: "code", key: "packages/x.ts" });
	upsertEdge(
		b,
		{ src: eb, dst: cb, type: "about", createdBy: "human", state: "rejected" },
		50,
	);
	importGraphDelta(b, delta);
	// rejected (human) outranks the peer's active, even though older
	expect(
		b.query("SELECT state FROM kg_edges WHERE src = ? AND dst = ?").get(eb, cb)
			.state,
	).toBe("rejected");
	expect(
		b.query("SELECT COUNT(*) AS n FROM kg_nodes WHERE kind = 'entry'").get().n,
	).toBe(1);
	expect(() =>
		importGraphDelta(b, { nodes: [{ kind: "nope" }], edges: [] }),
	).toThrow();
});

test("one distiller per hub: a live holder keeps the lease, a dead one is taken over", () => {
	const db = knowledgeDb();
	const alive = (pid) => ({
		birth: pid === process.pid ? "me" : "other",
		command: "bun",
	});
	expect(acquireLease(db, "n1", alive)).toBe(true);
	expect(acquireLease(db, "n1", alive)).toBe(true); // renew
	db.run("UPDATE distill_lease SET pid = 999999, birth = 'other'");
	expect(acquireLease(db, "n2", alive)).toBe(false); // holder alive
	expect(
		acquireLease(db, "n2", (pid) => (pid === 999999 ? false : alive(pid))),
	).toBe(true);
	expect(releaseLease(db, "n1")).toBe(false);
	expect(releaseLease(db, "n2")).toBe(true);
});

test("bench: k=2 traversal p50 on 10k nodes / 50k edges stays interactive", () => {
	const db = new Database(":memory:");
	ensureDistillSchema(db);
	const N = 10_000;
	db.transaction(() => {
		const ins = db.query(
			"INSERT INTO kg_nodes (kind, key, first_seen, last_seen) VALUES ('code', ?, 0, 0)",
		);
		for (let i = 0; i < N; i++) ins.run(`n${i}`);
		const e = db.query(
			"INSERT OR IGNORE INTO kg_edges (src, dst, type, created_by, state, at) VALUES (?, ?, 'related', 'b', 'active', 0)",
		);
		let x = 7;
		for (let i = 0; i < 50_000; i++) {
			x = (x * 1103515245 + 12345) % 2147483648;
			e.run((i % N) + 1, (x % N) + 1);
		}
	})();
	const times = [];
	for (let i = 0; i < 50; i++) {
		const t = performance.now();
		neighbours(db, ((i * 197) % N) + 1, { depth: 2, limit: 500 });
		times.push(performance.now() - t);
	}
	times.sort((p, q) => p - q);
	const p50 = times[25];
	test
		.info()
		.annotations.push({ type: "k2-p50-ms", description: p50.toFixed(2) });
	console.log(
		`[bench] k=2 neighbours p50 ${p50.toFixed(2)} ms (10k nodes / 50k edges)`,
	);
	expect(p50).toBeLessThan(100);
});
