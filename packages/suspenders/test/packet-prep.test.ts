// test/packet-prep.test.ts — W238: the offline task-agnostic packet-prep
// pass (hooks/lib/packet-prep.ts).
// 1) pointer extraction: slash paths + extension docs, order-stable dedupe
// 2) W112 pointer teeth: loss detection + honest degradation to input
// 3) compression: the blam packet tier fires (bytes saved, rules audited)
// 4) determinism: same input ⇒ identical result objects (engine law L6)
// 5) passthrough: empty/whitespace input is untouched, ratio 1
import { describe, expect, test } from "bun:test";
import {
	extractPointers,
	finalizePacket,
	type PacketPrepResult,
	pointerLoss,
	prepPacket,
} from "../hooks/lib/packet-prep.ts";

const DOC = [
	"Prior to the merge, read the AGENTS.md file.",
	"In order to ship, it is required to run the suite.",
	"- Read the AGENTS.md file.",
	"- Read the AGENTS.md file.",
	"At the present time the fleet runs on one version.",
].join("\n");

describe("W238 packet-prep: pointer extraction", () => {
	test("slash paths and extension docs, order-stable dedupe", () => {
		const pointers = extractPointers(
			"Edit packages/suspenders/hooks/lib/packet-prep.ts, then docs/x.md and packages/suspenders/hooks/lib/packet-prep.ts again; see AGENTS.md.",
		);
		expect(pointers).toEqual([
			"packages/suspenders/hooks/lib/packet-prep.ts",
			"docs/x.md",
			"AGENTS.md",
		]);
	});

	test("plain words and flags are not pointers", () => {
		expect(extractPointers("Run the build --dry-run now, then rest.")).toEqual(
			[],
		);
	});
});

describe("W238 packet-prep: W112 pointer teeth", () => {
	test("pointerLoss reports input pointers missing from output", () => {
		expect(
			pointerLoss(
				"Read docs/keep.md and docs/lost.md before starting.",
				"Read docs/keep.md before starting.",
			),
		).toEqual(["docs/lost.md"]);
		expect(pointerLoss("Read docs/keep.md.", "Read docs/keep.md.")).toEqual(
			[],
		);
	});

	test("degradation: a result that loses a pointer is refused — input served verbatim", () => {
		const input = "Read docs/keep.md and docs/lost.md before starting.";
		const synthetic = { text: "Read docs/keep.md before starting.", rules: ["dedupe:line"] };
		const r: PacketPrepResult = finalizePacket(input, synthetic);
		expect(r.degraded).toBe(true);
		expect(r.text).toBe(input);
		expect(r.lostPointers).toEqual(["docs/lost.md"]);
		expect(r.outBytes).toBe(r.inBytes);
	});

	test("live pass on pointer-bearing prose never degrades", () => {
		const r = prepPacket(DOC);
		expect(r.degraded).toBe(false);
		expect(r.lostPointers).toEqual([]);
		for (const p of r.pointers) expect(r.text).toContain(p);
	});
});

describe("W238 packet-prep: compression", () => {
	test("doc prose compresses with an audited rules list", () => {
		const r = prepPacket(DOC);
		expect(r.savedBytes).toBeGreaterThan(0);
		expect(r.ratio).toBeLessThan(1);
		expect(r.rules).toContain("phrase:prior-to");
		expect(r.rules).toContain("dedupe:sentence");
		expect(r.pointers).toContain("AGENTS.md");
	});

	test("determinism: same input, identical result objects", () => {
		expect(prepPacket(DOC)).toEqual(prepPacket(DOC));
	});

	test("empty input is a ratio-1 passthrough; whitespace-only compresses to empty", () => {
		const empty = prepPacket("");
		expect(empty.text).toBe("");
		expect(empty.savedBytes).toBe(0);
		expect(empty.ratio).toBe(1);
		expect(empty.degraded).toBe(false);
		const ws = prepPacket("  \n\t ");
		expect(ws.text).toBe("");
		expect(ws.degraded).toBe(false);
		expect(ws.savedBytes).toBe(5);
	});
});
