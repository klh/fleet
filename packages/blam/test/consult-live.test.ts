// consult-live.test.ts — W934.2.2: the live consult benchmark runner
// (bench/consult/live.ts) against a scratch governor plane. Spawns the real
// coord CLI (temp HOME + fixture git repo); the expert is a scripted
// stand-in. Credentialless — no model, no network (kev pinned to a dead
// port). Two questions keep the spawn-heavy run bounded.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLiveBench } from "../bench/consult/live.ts";

setDefaultTimeout(120_000);

const QUESTIONS = [
	"why does the blam live bench route an unverified ask to the expert",
	"how does the blam live bench verify consult reuse on the plane",
];
const OUT = join(tmpdir(), `blam-consult-live-test-${Date.now()}`);

afterAll(() => {
	rmSync(OUT, { recursive: true, force: true });
});

test("live consult bench: matched arms complete and all properties hold", async () => {
	const report = await runLiveBench({ questions: QUESTIONS, out: OUT });
	// matched, complete round trips on the expert arm
	const expert = report.receipts.filter((r) => r.arm === "expert");
	const kb = report.receipts.filter((r) => r.arm === "kb");
	expect(expert).toHaveLength(QUESTIONS.length);
	expect(kb).toHaveLength(QUESTIONS.length);
	expect(expert.every((r) => r.outcome === "expert-answered")).toBe(true);
	expect(expert.every((r) => r.consultRef !== null)).toBe(true);
	// the reuse arm answers from the KB — never routed to a live lane
	expect(kb.every((r) => r.outcome === "kb-answered")).toBe(true);
	// kb asks carry the reuse answer text, expert asks the stand-in's answer
	expect(kb.every((r) => r.answerChars > 0)).toBe(true);
	// delivery + latency aggregates are consistent with the receipts
	const armKb = report.arms.find((a) => a.arm === "kb");
	const armExpert = report.arms.find((a) => a.arm === "expert");
	expect(armKb?.answered).toBe(QUESTIONS.length);
	expect(armExpert?.answered).toBe(QUESTIONS.length);
	expect(armExpert && armKb ? armKb.p50Ms <= armExpert.p50Ms : false).toBe(
		true,
	);
	expect(report.allHold).toBe(true);
});

test("parseOutcome maps the real CLI markers to outcomes", async () => {
	const { parseOutcome } = await import("../bench/consult/live.ts");
	expect(
		parseOutcome("✓ C1 answered from the knowledge base (learned from", 0),
	).toMatchObject({
		outcome: "kb-answered",
		consultRef: "C1",
	});
	expect(
		parseOutcome("✓ C2 answered from a verified fleet fact k#3", 0),
	).toMatchObject({
		outcome: "fact-answered",
		consultRef: "C2",
	});
	expect(parseOutcome("CONSULT C3 → blam-exp", 0)).toMatchObject({
		outcome: "routed-open",
		consultRef: "C3",
	});
	expect(
		parseOutcome("error: no ranked expert — nobody live has touched this", 1),
	).toMatchObject({ outcome: "refused", consultRef: null });
});
