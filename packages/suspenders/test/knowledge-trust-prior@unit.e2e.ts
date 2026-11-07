// knowledge-trust-prior@unit.e2e.ts — W2846 per-origin trust priors: tier
// derivation (owner_verified > distilled > lane_written), config-over-code
// (knowledge.trust_priors machine conf, never code constants), the recall
// ranking fold, the prose-card prior tag, and the distill scheduler boost
// (origin_prior_h × trust_prior on kg_nodes.props).
import { expect, test } from "@playwright/test";
import { setting } from "@klh/settings";
import {
	originTierOf,
	trustPriorOf,
	trustPriors,
} from "../hooks/lib/knowledge/trust-prior.ts";
import {
	knowledgeSearch,
	proseCards,
	withTrust,
	type KnowledgeHit,
} from "../hooks/lib/knowledge/knowledge.ts";
import { addEntry, knowledgeDb } from "./fixtures/distill-world.ts";
import { searchDb, seedRow } from "./fixtures/trust-prior-search.ts";
import { syncEntries } from "../hooks/lib/knowledge/distill/sink.ts";
import { distillDefaults } from "../hooks/lib/knowledge/distill/config.ts";
import {
	pickBatch,
	stampVisit,
} from "../hooks/lib/knowledge/distill/visits.ts";

test("tier derivation: active beats distilled beats lane-written", () => {
	// state IS the promote act (human-only gate) — the owner-verified tier
	expect(originTierOf({ state: "active", origin_kind: "lesson" })).toBe(
		"owner_verified",
	);
	expect(originTierOf({ state: "active", origin_kind: null })).toBe(
		"owner_verified",
	);
	// distilled rows are single-model (W953 cap 0.6) — their own tier
	expect(originTierOf({ state: "candidate", origin_kind: "distilled" })).toBe(
		"distilled",
	);
	// everything else is lane-written, whatever its content classification
	expect(originTierOf({ state: "candidate", origin_kind: "lesson" })).toBe(
		"lane_written",
	);
	expect(originTierOf({ state: null, origin_kind: null })).toBe("lane_written");
});

test("default ladder owner(1) > distilled(0.6) > lane(0.4) from settings", () => {
	const p = trustPriors();
	expect(p.owner_verified).toBe(1);
	expect(p.distilled).toBe(0.6);
	expect(p.lane_written).toBe(0.4);
	expect(p.owner_verified).toBeGreaterThan(p.distilled);
	expect(p.distilled).toBeGreaterThan(p.lane_written);
	expect(setting("knowledge.trust_priors").distilled).toBe(0.6);
	expect(trustPriorOf({ state: "active", origin_kind: null })).toBe(1);
	expect(trustPriorOf({ state: "candidate", origin_kind: "distilled" })).toBe(
		0.6,
	);
	expect(trustPriorOf({ state: null, origin_kind: null })).toBe(0.4);
});

test("recall ranking folds the prior: promoted outranks lane at equal text", () => {
	const db = searchDb();
	// three rows, identical text otherwise — the ladder must order them
	const lane = seedRow(db, {
		topic: "prior ordering probe",
		fact: "identical trust probe text zqprior",
		originKind: "lesson",
		state: "candidate",
	});
	const dist = seedRow(db, {
		topic: "prior ordering probe",
		fact: "identical trust probe text zqprior",
		originKind: "distilled",
		state: "candidate",
	});
	const owner = seedRow(db, {
		topic: "prior ordering probe",
		fact: "identical trust probe text zqprior",
		originKind: "lesson",
		state: "active",
	});
	const hits = knowledgeSearch(
		db,
		"identical trust probe text",
	) as KnowledgeHit[];
	const ids = hits.map((h) => h.id);
	expect(ids).toContain(lane);
	expect(ids.indexOf(owner)).toBeLessThan(ids.indexOf(dist));
	expect(ids.indexOf(dist)).toBeLessThan(ids.indexOf(lane));
	db.close();
});

test("prose cards and withTrust carry the prior tag", () => {
	const db = searchDb();
	seedRow(db, {
		topic: "card prior probe",
		fact: "card renders the prior tag zqcard",
		originKind: "distilled",
		state: "candidate",
	});
	const hits = knowledgeSearch(db, "card renders prior tag") as KnowledgeHit[];
	const card = proseCards("card renders prior tag", hits);
	expect(card).toContain("prior distilled 0.6");
	const withPrior = withTrust(hits).find((h) => h.kind === "knowledge");
	expect(withPrior?.trust_prior).toBe(0.6);
	db.close();
});

test("distill scheduler: trusted origins revisit sooner (origin_prior_h × prior)", () => {
	const db = knowledgeDb();
	const lane = addEntry(db, {
		topic: "lane row",
		fact: "scheduler prior probe zqsched",
		originKind: "lesson",
		state: "candidate",
	});
	const owner = addEntry(db, {
		topic: "promoted row",
		fact: "scheduler prior probe zqsched",
		originKind: "lesson",
		state: "active",
	});
	syncEntries(db, 1);
	const props = (kid: number): number =>
		(
			JSON.parse(
				db
					.query("SELECT props FROM kg_nodes WHERE ref = ?")
					.get(`knowledge:${kid}`).props as string,
			) as { trust_prior: number }
		).trust_prior;
	expect(props(lane)).toBe(0.4);
	expect(props(owner)).toBe(1);
	// both visited at the same moment: the origin boost orders the next batch
	const cfg = distillDefaults({ enabled: true, min_revisit_h: 0 });
	const node = (kid: number) =>
		db
			.query("SELECT id, hash, usage FROM kg_nodes WHERE ref = ?")
			.get(`knowledge:${kid}`) as {
			id: number;
			hash: string | null;
			usage: number;
		};
	const now = 100_000_000;
	for (const kid of [lane, owner])
		stampVisit(db, node(kid).id, "extract", node(kid), "ok", now);
	const order = pickBatch(db, cfg, "extract", 2, now + 10 * 3_600_000).map(
		(n) => n.key,
	);
	expect(order).toEqual([`knowledge:${owner}`, `knowledge:${lane}`]);
	db.close();
});
