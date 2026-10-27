// confidence.test.ts — W953: policy trust bands, band validation, the
// adversarial stamp rules (independence/evidence/consensus/verdict), and the
// append-only history contract. In-memory sqlite; the ledger DDL under test
// is the module's own CONFIDENCE_HISTORY_DDL (shipped shape, verbatim).
import { expect, test } from "./pw";
import { Database } from "bun:sqlite";
import {
	bandLabel,
	bandOf,
	glyphFor,
	makeStamp,
	parseStamp,
	renderStamp,
	validateConfidence,
	familyOf,
	parseSetterKind,
	isCandidate,
	meetsThreshold,
	CANDIDATE_THRESHOLD,
	CONFIDENCE_BANDS,
	CONFIDENCE_HISTORY_DDL,
	CONFIDENCE_HISTORY_INDEX_DDL,
	CONFIDENCE_MIN,
	CONFIDENCE_THRESHOLDS,
	ConfidenceError,
	STAMP_VERDICTS,
	type ConfidenceStamp,
} from "../hooks/lib/confidence.ts";
import { STAMP_VERDICTS as VERDICTS_FROM_VERDICT_MODULE } from "../hooks/lib/confidence-verdict.ts";

test.describe("band mapping", () => {
	test("edges map to the six policy bands", () => {
		const cases: [number, string][] = [
			[0.1, "machine-raw"],
			[0.35, "machine-raw"],
			[0.4, "machine-derived"],
			[0.6, "single-model"],
			[0.79, "single-model"],
			[0.8, "model-reviewed"],
			[0.89, "model-reviewed"],
			[0.9, "multi-model"],
			[0.99, "multi-model"],
			[1.0, "human-reviewed"],
		];
		for (const [v, name] of cases)
			expect(bandOf(v).name).toBe(name);
	});
});

test.describe("glyphs", () => {
	test("six glyphs, one per band", () => {
		const glyphs = CONFIDENCE_BANDS.map((b) => b.glyph);
		expect(glyphs).toEqual(["·", "○", "◔", "◑", "◕", "●"]);
		expect(glyphFor(0.35)).toBe("·");
		expect(glyphFor(0.5)).toBe("○");
		expect(glyphFor(0.7)).toBe("◔");
		expect(glyphFor(0.85)).toBe("◑");
		expect(glyphFor(0.95)).toBe("◕");
		expect(glyphFor(1.0)).toBe("●");
	});

	test("bandLabel joins glyph + label", () => {
		expect(bandLabel(0.4)).toBe("machine-derived");
		expect(bandLabel(1.0)).toBe("human-reviewed");
	});
});

test.describe("threshold matrix (binding owner verdict)", () => {
	test("surfaces grade instead of gate below the floor", () => {
		expect(CONFIDENCE_THRESHOLDS["board/search"]).toBe(0);
		expect(CONFIDENCE_THRESHOLDS["lane-brief"]).toBe(0.6);
		expect(CONFIDENCE_THRESHOLDS.consult).toBe(0.8);
		expect(CONFIDENCE_THRESHOLDS.benchmark).toBe(0.8);
		expect(CONFIDENCE_THRESHOLDS.policy).toBe(1.0);
	});

	test("isCandidate + meetsThreshold", () => {
		expect(CANDIDATE_THRESHOLD).toBe(0.6);
		expect(isCandidate(0.4)).toBe(true);
		expect(isCandidate(0.6)).toBe(false);
		expect(meetsThreshold("consult", 0.85)).toBe(true);
		expect(meetsThreshold("consult", 0.7)).toBe(false);
		expect(meetsThreshold("policy", 1.0)).toBe(true);
		expect(meetsThreshold("policy", 0.9)).toBe(false);
	});
});

test.describe("validateConfidence", () => {
	test("accepts the policy range", () => {
		expect(validateConfidence(0.1)).toBe(CONFIDENCE_MIN);
		expect(validateConfidence(1)).toBe(1);
		expect(validateConfidence(0.42)).toBe(0.42);
	});

	test("refuses out-of-policy values", () => {
		for (const bad of [0, 0.05, 1.5, -1, Number.NaN, "0.8", null])
			expect(() => validateConfidence(bad)).toThrow();
	});

	test("rounds float drift (REAL columns)", () => {
		expect(validateConfidence(0.30000000000000004)).toBe(0.3);
	});
});

test.describe("setter grammar + families", () => {
	test("parseSetterKind sorts the three kinds", () => {
		expect(parseSetterKind("human")).toBe("human");
		expect(parseSetterKind("model:glm-5.3-flash")).toBe("model");
		expect(parseSetterKind("mechanical:decant")).toBe("mechanical");
		for (const bad of ["Model:x", "model:", "mech:x", "", "ai:x"])
			expect(parseSetterKind(bad)).toBeNull();
	});

	test("familyOf: vendor segment; mechanical = own family; human alone", () => {
		expect(familyOf("model:model-model")).toBe("model");
		expect(familyOf("model:glm-5.3-flash")).toBe("glm");
		expect(familyOf("model:claude-sonnet-5.5")).toBe("claude");
		expect(familyOf("mechanical:decant")).toBe("mechanical:decant");
		expect(familyOf("human")).toBe("human");
	});
});

test.describe("makeStamp: first stamps + raises", () => {
	test("first mechanical stamp without evidence (decant ingest shape)", () => {
		const s = makeStamp({ value: 0.4, setter: "mechanical:decant" });
		expect(s.value).toBe(0.4);
		expect(s.prior).toBeNull();
		expect(s.hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test("raise requires evidence", () => {
		const base = makeStamp({ value: 0.4, setter: "mechanical:decant" });
		expect(() =>
			makeStamp({ value: 0.6, setter: "model:glm-5.3", prior: base }),
		).toThrow(ConfidenceError);
	});

	test("raise with fresh evidence cites the prior", () => {
		const base = makeStamp({ value: 0.4, setter: "mechanical:decant" });
		const up = makeStamp({
			value: 0.6,
			setter: "model:glm-5.3",
			evidence: "checked A",
			prior: base,
		});
		expect(up.prior?.setter).toBe("mechanical:decant");
		expect(up.prior?.value).toBe(0.4);
	});
});

test.describe("recycled evidence", () => {
	test("a raise citing the prior's own evidence is denied", () => {
		const base = makeStamp({
			value: 0.4,
			setter: "mechanical:decant",
			evidence: "docs/x.md",
		});
		expect(() =>
			makeStamp({
				value: 0.6,
				setter: "model:glm-5.3",
				evidence: "docs/x.md",
				prior: base,
			}),
		).toThrow(ConfidenceError);
	});
});

test.describe("0.8 independence gate", () => {
	test("same-family self-review denied", () => {
		const base = makeStamp({
			value: 0.6,
			setter: "model:glm-5.3",
			evidence: "e1",
		});
		expect(() =>
			makeStamp({
				value: 0.8,
				setter: "model:glm-5.3-flash",
				evidence: "checked t1..t9",
				prior: base,
			}),
		).toThrow(ConfidenceError);
	});

	test("independent family + checked evidence accepted, cites prior", () => {
		const base = makeStamp({
			value: 0.6,
			setter: "model:glm-5.3",
		});
		const up = makeStamp({
			value: 0.8,
			setter: "model:claude-sonnet-5.5",
			evidence: "checked A",
			prior: base,
		});
		expect(up.value).toBe(0.8);
		expect(up.prior?.setter).toBe("model:glm-5.3");
	});
});

test.describe("0.9 consensus gate", () => {
	test("two families + two evidences reach 0.9", () => {
		const a = makeStamp({
			value: 0.6,
			setter: "model:glm-0.3",
			evidence: "check-A",
		});
		const b = makeStamp({
			value: 0.85,
			setter: "model:claude-sonnet-5.5",
			evidence: "check-B",
		});
		const c = makeStamp({
			value: 0.9,
			setter: "model:gemini-3",
			evidence: "check-C",
			prior: b,
			chain: [a, b],
		});
		expect(c.value).toBe(0.9);
	});
});

test.describe("same evidence is not consensus", () => {
	test("same evidence across families is NOT consensus", () => {
		const a = makeStamp({
			value: 0.4,
			setter: "mechanical:decant",
		});
		const b = makeStamp({
			value: 0.4,
			setter: "model:claude-sonnet-5.5",
			evidence: "same-doc",
		});
		expect(() =>
			makeStamp({
				value: 0.9,
				setter: "model:gemini-3",
				evidence: "same-doc",
				prior: b,
				chain: [a, b],
			}),
		).toThrow(ConfidenceError);
	});
});

test.describe("verdict lifecycle + 1.0 law", () => {
	test("superseded/contradicted refuse without ref", () => {
		const base = makeStamp({ value: 0.4, setter: "mechanical:decant" });
		expect(() =>
			makeStamp({
				value: 0.4,
				setter: "mechanical:decant",
				verdict: "superseded",
				prior: base,
			}),
		).toThrow(ConfidenceError);
	});
});

test.describe("superseded with ref", () => {
	test("accepted + renders the walk link", () => {
		const base = makeStamp({ value: 0.4, setter: "mechanical:decant" });
		const s = makeStamp({
			value: 0.4,
			setter: "mechanical:decant",
			verdict: "superseded",
			ref: "kb:77",
			prior: base,
		});
		expect(s.verdict).toBe("superseded");
		expect(renderStamp(s)).toContain("→ kb:77");
	});
});

test.describe("enum convergence (W955)", () => {
	test("confidence.ts re-exports the verdict module's enum — same ref", () => {
		expect(STAMP_VERDICTS).toBe(VERDICTS_FROM_VERDICT_MODULE);
	});
});

test.describe("append-only history ledger", () => {
	function freshDb(): Database {
		const db = new Database(":memory:");
		db.run(CONFIDENCE_HISTORY_DDL);
		db.run(CONFIDENCE_HISTORY_INDEX_DDL);
		return db;
	}

	test("raise appends; the earlier ledger row survives untouched", () => {
		const db = freshDb();
		const base = makeStamp({ value: 0.4, setter: "mechanical:decant" });
		const up = makeStamp({
			value: 0.6,
			setter: "model:glm-5.3",
			evidence: "checked ledger",
			prior: base,
		});
		expect(up.value).toBe(0.6);
		const put = (s: ConfidenceStamp) =>
			db.query(
				"INSERT INTO confidence_history (ts, tbl, row_key, value, setter, evidence, verdict, ref, prior, prior_setter, prior_ts, by_sid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				s.ts, "facts.w953", "k1", s.value, s.setter,
				s.evidence ?? null, s.verdict ?? null, s.ref ?? null,
				s.prior?.value ?? null, s.prior?.setter ?? null,
				s.prior?.ts ?? null, "autow953",
			);
		put(base);
		put(up);
		const rows = db
			.query(
				"SELECT value FROM confidence_history WHERE row_key = 'k1' ORDER BY id",
			)
			.all();
		expect(rows.length).toBe(2);
		expect(rows[0]?.value).toBe(0.4);
		expect(rows[1]?.value).toBe(0.6);
	});

	test("parseStamp/renderStamp round-trip", () => {
		const s = makeStamp({
			value: 0.3,
			setter: "mechanical:knowledge-sync",
			evidence: "hub:nas",
		});
		const back = parseStamp(JSON.stringify(s));
		expect(back).not.toBeNull();
		expect(back?.value).toBe(0.3);
		expect(back?.hash).toBe(s.hash);
	});
});

test.describe("1.0 law", () => {
	test("only a human setter may stamp 1.0", () => {
		expect(() =>
			makeStamp({ value: 1.0, setter: "model:glm-5.3", evidence: "x" }),
		).toThrow(ConfidenceError);
		const h = makeStamp({ value: 1.0, setter: "human" });
		expect(h.value).toBe(1.0);
	});
});
