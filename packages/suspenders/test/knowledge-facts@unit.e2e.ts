// knowledge-facts@unit.e2e.ts — hub design phase 3: ONE knowledge store.
// lesson./finding./claim./decant.claim. rows move governor facts →
// knowledge.db knowledge_facts (idempotent, legacy-column tolerant,
// lesson.seen.* and control rows stay), decant claims carry origin_kind
// 'decant' + source_ref, read-only sync paths merge both stores, and new
// decant claims pass the Kev store/noise/review gate.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateDecantWrites } from "../hooks/lib/fleet-loop/decant-gate.ts";
import {
	isKnowledgeFactKey,
	listKnowledgeFacts,
	mergeKnowledgeFactsReadonly,
	migrateKnowledgeFacts,
} from "../hooks/lib/knowledge/knowledge-facts.ts";

const dir = mkdtempSync(join(tmpdir(), "knowledge-facts-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kbPath = join(dir, "knowledge.db");

function legacyGov() {
	const gov = new Database(":memory:");
	// pre-W953 shape: no confidence/provenance/stale columns
	gov.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	const ins = gov.query("INSERT INTO facts VALUES (?, ?, 'test', ?, ?)");
	ins.run("lesson.a", "lesson a", 2, 10);
	ins.run("lesson.seen.s1", "10", 1, 11);
	ins.run("finding.w1", "finding one", 1, 12);
	ins.run("claim.c1", "claim one", 1, 13);
	ins.run("decant.claim.d1", "decant one", 4, 14);
	ins.run("lane.x.capsule", "control", 1, 15);
	return gov;
}

test("migration moves knowledge rows only, intact, and is idempotent", () => {
	const gov = legacyGov();
	const open = () => new Database(kbPath);
	expect(migrateKnowledgeFacts(gov, open)).toBe(4);
	expect(
		gov.query("SELECT key FROM facts ORDER BY key").all().map((r) => r.key),
	).toEqual(["lane.x.capsule", "lesson.seen.s1"]);
	expect(migrateKnowledgeFacts(gov, open)).toBe(0);
	const kb = open();
	const rows = listKnowledgeFacts(kb, {
		prefixes: ["lesson.", "finding.", "claim.", "decant.claim."],
	});
	expect(rows.map((r) => [r.key, r.version])).toEqual([
		["claim.c1", 1],
		["decant.claim.d1", 4],
		["finding.w1", 1],
		["lesson.a", 2],
	]);
	const d = kb
		.query("SELECT origin_kind FROM knowledge_facts WHERE key = 'decant.claim.d1'")
		.get();
	expect(d.origin_kind).toBe("decant");
	kb.close();
});

test("seen-markers are never knowledge", () => {
	expect(isKnowledgeFactKey("lesson.seen.abc")).toBe(false);
	expect(isKnowledgeFactKey("lesson.x")).toBe(true);
	expect(isKnowledgeFactKey("decant.claim.1")).toBe(true);
	expect(isKnowledgeFactKey("lane.x")).toBe(false);
});

test("read-only merge: the knowledge store wins per key; missing kb falls back", () => {
	const gov = [
		{ key: "lesson.a", value: "stale gov copy" },
		{ key: "lesson.z", value: "old writer row" },
	];
	const merged = mergeKnowledgeFactsReadonly(gov, kbPath, ["lesson."]);
	expect(merged.map((r) => [r.key, r.value])).toEqual([
		["lesson.a", "lesson a"],
		["lesson.z", "old writer row"],
	]);
	expect(
		mergeKnowledgeFactsReadonly(gov, join(dir, "absent.db"), ["lesson."]),
	).toEqual(gov);
});

test("decant gate: store keeps, noise drops, unavailable parks; reclaims pass", async () => {
	const w = (key, mode = "create") => ({
		mode,
		claim: { key, evidenceId: `ev-${key}`, value: `v ${key}` },
	});
	const verdicts = { k1: "store", k2: "noise", k3: "unavailable", k4: "review" };
	const parked = [];
	const asked = [];
	const g = await gateDecantWrites(
		[w("k1"), w("k2"), w("k3"), w("k4"), w("k5", "reclaim")],
		{
			curate: async (i) => {
				asked.push(i.title);
				return {
					kind: i.kind,
					reference: i.reference,
					choice: verdicts[i.title],
					confidence: 0.9,
					model: "stub",
					suggestion: "",
				};
			},
			defer: (e) => parked.push(e),
			project: "p",
		},
	);
	expect(g.keep.map((x) => x.claim.key)).toEqual(["k1", "k4", "k5"]);
	expect(g.noise).toEqual(["k2"]);
	expect(g.deferred).toEqual(["k3"]);
	expect(asked).toEqual(["k1", "k2", "k3", "k4"]);
	expect(parked[0].kind).toBe("decant");
	expect(parked[0].text).toContain("source_ref: decant:ev-k3");
});
