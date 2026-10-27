// confidence-verdict.test.ts — W955: verdict enum, ref-required enforcement,
// append-only history, self-downgrade/self-upgrade law, stale-row
// queryability, and the chain walk. In-memory sqlite; the confidence_history
// DDL mirrors confidence.ts CONFIDENCE_HISTORY_DDL (W953) so both modules
// can write the same table.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import {
	DEFAULT_EXCLUDED,
	REF_REQUIRED,
	STAMP_VERDICTS,
	VerdictError,
	appendConfidenceEvent,
	checkVerdictTransition,
	latestVerdict,
	validateVerdict,
	validateVerdictRef,
	verdictFilterClause,
	walkChain,
} from "../hooks/lib/confidence-verdict.ts";

const DDL = `CREATE TABLE confidence_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	tbl TEXT NOT NULL,
	row_key TEXT NOT NULL,
	value REAL NOT NULL,
	setter TEXT NOT NULL,
	evidence TEXT,
	verdict TEXT,
	ref TEXT,
	prior REAL,
	prior_setter TEXT,
	prior_ts INTEGER,
	by_sid TEXT)`;

function freshDb(): Database {
	const db = new Database(":memory:");
	db.run(DDL);
	return db;
}

const ev = (over: Partial<Parameters<typeof appendConfidenceEvent>[1]>) => ({
	tbl: "kb.knowledge",
	rowKey: 7,
	value: 0.5,
	setter: "model:glm-5.3-flash",
	verdict: "fresh" as const,
	...over,
});

test.describe("verdict enum validation", () => {
	test("all six verdicts validate", () => {
		expect(STAMP_VERDICTS).toEqual([
			"fresh",
			"stale",
			"confirmed",
			"retracted",
			"superseded",
			"contradicted",
		]);
		for (const v of STAMP_VERDICTS) expect(validateVerdict(v)).toBe(v);
	});

	test("unknown verdict refused", () => {
		for (const bad of ["archived", "", "FRESH", null, 42, undefined])
			expect(() => validateVerdict(bad)).toThrow(VerdictError);
	});
});

test.describe("ref-required enforcement", () => {
	test("superseded / contradicted REQUIRE ref", () => {
		expect(() => validateVerdictRef("superseded", null)).toThrow(VerdictError);
		expect(() => validateVerdictRef("contradicted", "  ")).toThrow(
			VerdictError,
		);
	});

	test("superseded / contradicted accept ref", () => {
		expect(validateVerdictRef("superseded", "kb:42")).toBe("kb:42");
		expect(validateVerdictRef("contradicted", " finding.ikea-foo ")).toBe(
			"finding.ikea-foo",
		);
	});

	test("fresh|stale|confirmed|retracted carry ref optional", () => {
		expect(validateVerdictRef("fresh", null)).toBeNull();
		expect(validateVerdictRef("stale", "src:report.md:12")).toBe(
			"src:report.md:12",
		);
		expect(validateVerdictRef("confirmed", null)).toBeNull();
		expect(validateVerdictRef("retracted", "owner-retract: dup")).toBe(
			"owner-retract: dup",
		);
	});

	test("append refuses lineage stamps without ref", () => {
		const db = freshDb();
		expect(() =>
			appendConfidenceEvent(db, ev({ verdict: "superseded", ref: null })),
		).toThrow(VerdictError);
	});
});

test.describe("append-only history", () => {
	test("full lifecycle keeps setter+ts at every hop, never rewritten", () => {
		const db = freshDb();
		const t0 = 1_760_000_000_000;
		const hops = [
			{ verdict: "fresh", setter: "mechanical:decant", value: 0.4, ts: t0 },
			{
				verdict: "confirmed",
				setter: "model:claude-sonnet-5",
				value: 0.8,
				ts: t0 + 1000,
			},
			{ verdict: "stale", setter: "human", value: 0.8, ts: t0 + 2000 },
			{
				verdict: "superseded",
				setter: "model:glm-5.3-flash",
				value: 0.6,
				ts: t0 + 3000,
				ref: "kb:99",
			},
		] as const;
		for (const h of hops)
			appendConfidenceEvent(db, {
				tbl: "kb.knowledge",
				rowKey: 7,
				value: h.value,
				setter: h.setter,
				verdict: h.verdict,
				ref: "ref" in h ? h.ref : null,
				now: h.ts,
			});
		// a later append does not disturb earlier rows
		const evs = walkChain(db, "kb.knowledge", 7).events;
		expect(evs.length).toBe(4);
		for (const [i, e] of evs.entries()) {
			expect(e.setter).toBe(hops[i].setter);
			expect(e.ts).toBe(hops[i].ts);
			expect(e.verdict).toBe(hops[i].verdict);
		}
		expect(latestVerdict(db, "kb.knowledge", 7)).toBe("superseded");
	});
});

test.describe("self-downgrade / self-upgrade law", () => {
	const prev = { value: 0.8, setter: "model:glm-5.3-flash" };

	test("self-downgrade allowed — value decrease, verdict-only moves", () => {
		checkVerdictTransition(prev, {
			value: 0.5,
			setter: prev.setter,
			verdict: "stale",
		});
		checkVerdictTransition(prev, {
			value: 0.8,
			setter: prev.setter,
			verdict: "retracted",
		});
	});

	test("self-upgrade capped at 0.7 — past that refused", () => {
		const low = { value: 0.5, setter: "model:glm-5.3-flash" };
		expect(() =>
			checkVerdictTransition(low, {
				value: 0.75,
				setter: low.setter,
				verdict: "confirmed",
			}),
		).toThrow(/self-upgrade caps at 0\.7/);
		// at the cap the raise stands
		checkVerdictTransition(low, {
			value: 0.7,
			setter: low.setter,
			verdict: "confirmed",
		});
	});

	test("a different setter's raise is not a self-upgrade", () => {
		checkVerdictTransition(
			{ value: 0.5, setter: "model:glm-5.3-flash" },
			{ value: 0.75, setter: "model:claude-sonnet-5", verdict: "confirmed" },
		);
	});
});

test.describe("stale rows queryable forever, filtered by default", () => {
	function dbWithVerdicts(): Database {
		const db = freshDb();
		db.run("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		for (const id of [1, 2, 3, 4, 5, 6])
			db.run("INSERT INTO items VALUES (?)", [id]);
		// row 1 stale · 2 fresh · 3 superseded · 4 contradicted · 5 retracted · 6 no history
		const cases: Array<[number, (typeof STAMP_VERDICTS)[number]]> = [
			[1, "stale"],
			[2, "fresh"],
			[3, "superseded"],
			[4, "contradicted"],
			[5, "retracted"],
		];
		for (const [id, v] of cases)
			appendConfidenceEvent(db, {
				tbl: "kb.knowledge",
				rowKey: id,
				value: 0.5,
				setter: "human",
				verdict: v,
				ref: REF_REQUIRED.includes(v) ? `kb:${id}` : null,
			});
		return db;
	}

	test("default filter hides every stale-class verdict, keeps fresh/no-history", () => {
		const db = dbWithVerdicts();
		// the row-key expr MUST be table-qualified — an unqualified id
		// shadow-resolves to ch.id inside the subquery and inverts the filter
		const { sql, binds } = verdictFilterClause(
			"CAST(items.id AS TEXT)",
			"kb.knowledge",
		);
		const ids = db
			.query(`SELECT id FROM items WHERE ${sql} ORDER BY id`)
			.all(...binds)
			.map((r) => r.id);
		expect(ids).toEqual([2, 6]);
		expect(DEFAULT_EXCLUDED).toEqual([
			"stale",
			"superseded",
			"contradicted",
			"retracted",
		]);
	});

	test("includeStale surfaces them — rows never deleted", () => {
		const db = dbWithVerdicts();
		const { sql, binds } = verdictFilterClause(
			"CAST(items.id AS TEXT)",
			"kb.knowledge",
			true,
		);
		const ids = db
			.query(`SELECT id FROM items WHERE ${sql} ORDER BY id`)
			.all(...binds)
			.map((r) => r.id);
		expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
		// and the ledger still holds every event — nothing was deleted
		for (const id of [1, 3, 5])
			expect(walkChain(db, "kb.knowledge", id).events.length).toBe(1);
	});
});

test.describe("chain walk", () => {
	test("what replaced me / what disproved me — one query, both directions", () => {
		const db = freshDb();
		appendConfidenceEvent(db, ev({ verdict: "fresh", rowKey: 42 }));
		appendConfidenceEvent(
			db,
			ev({ verdict: "stale", rowKey: 42, ref: "src:bench.md:3" }),
		);
		appendConfidenceEvent(
			db,
			ev({ verdict: "superseded", rowKey: 42, ref: "kb:43", value: 0.4 }),
		);
		appendConfidenceEvent(
			db,
			ev({ verdict: "contradicted", rowKey: 42, ref: "kb:51", value: 0.4 }),
		);
		const chain = walkChain(db, "kb.knowledge", 42);
		expect(chain.events.length).toBe(4);
		expect(chain.replacedBy).toEqual(["kb:43"]);
		expect(chain.contradictedBy).toEqual(["kb:51"]);
		// untouched row: empty chain, no fabricated lineage
		expect(walkChain(db, "kb.knowledge", 99)).toEqual({
			events: [],
			replacedBy: [],
			contradictedBy: [],
		});
	});
});
