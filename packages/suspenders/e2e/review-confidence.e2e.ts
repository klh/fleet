// W2803: confidence-gated second-opinion leg (hybrid judge cascade).
import { expect, test } from "@playwright/test";
import {
	confidenceOf,
	secondOpinion,
	strongerTierModel,
} from "../hooks/lib/gates/review-confidence.ts";

const classes = {
	spark: ["local-extract"],
	standard: ["glm-5.3-flash"],
	frontier: ["glm-5.3"],
};
const base = { model: "glm-5.3-flash", classes, band: [0.3, 0.9] as const };
const run = (
	verdict: "PASS" | "FAIL" | "ERROR",
	reply: string,
	second = "VERDICT: PASS\nCONFIDENCE: 0.95",
	wire = "glm-5.3",
) => {
	const asked: string[] = [];
	return secondOpinion({
		...base,
		band: [...base.band],
		verdict,
		reply,
		request: async (m) => {
			asked.push(m);
			return second;
		},
		servedWire: () => wire,
	}).then((r) => ({ ...r, asked }));
};

test("@unit confidence parse: last line wins, out-of-range rejected", () => {
	expect(confidenceOf("CONFIDENCE: 0.2\nCONFIDENCE: 0.8")).toBe(0.8);
	expect(confidenceOf("CONFIDENCE: 1.5")).toBeUndefined();
	expect(confidenceOf("VERDICT: PASS")).toBeUndefined();
});

test("@unit stronger tier walks routing-policy classes upward", () => {
	expect(strongerTierModel("local-extract", classes)).toBe("glm-5.3-flash");
	expect(strongerTierModel("glm-5.3-flash", classes)).toBe("glm-5.3");
	expect(strongerTierModel("glm-5.3", classes)).toBeUndefined();
});

test("@unit verdict without confidence fails closed", async () => {
	const r = await run("PASS", "VERDICT: PASS");
	expect(r.verdict).toBe("ERROR");
	expect(r.asked).toEqual([]);
});

test("@unit confident PASS banks without a second leg", async () => {
	const r = await run("PASS", "VERDICT: PASS\nCONFIDENCE: 0.95");
	expect(r.verdict).toBe("PASS");
	expect(r.asked).toEqual([]);
});

test("@unit FAIL never re-runs or downgrades, even in band", async () => {
	const r = await run("FAIL", "VERDICT: FAIL - x\nCONFIDENCE: 0.5");
	expect(r.verdict).toBe("FAIL");
	expect(r.asked).toEqual([]);
});

test("@unit in-band PASS: agree banks PASS on the stronger tier", async () => {
	const r = await run("PASS", "VERDICT: PASS\nCONFIDENCE: 0.5");
	expect(r.asked).toEqual(["glm-5.3"]);
	expect(r.verdict).toBe("PASS");
});

test("@unit in-band PASS: disagreement grades ERROR", async () => {
	const r = await run(
		"PASS",
		"VERDICT: PASS\nCONFIDENCE: 0.5",
		"VERDICT: FAIL - bug\nCONFIDENCE: 0.8",
	);
	expect(r.verdict).toBe("ERROR");
});

test("@unit in-band PASS: second-leg wire mismatch grades ERROR", async () => {
	const r = await run(
		"PASS",
		"VERDICT: PASS\nCONFIDENCE: 0.5",
		undefined,
		"chatgpt/gpt-6-sol",
	);
	expect(r.verdict).toBe("ERROR");
});
