// test/verdict-repeat.test.ts — W896: the dispatch/resume repeat-verdict
// gate. A lane that re-closes on the verbatim verdict its previous attempt
// banked is operator-gated (FAILED + NEED_DECISION, verdict on the card via
// the fail note) instead of re-spawned; a fresh or changed verdict banks the
// observation and dispatches normally. Unit core + real-CLI integration on
// the shared scratch-HOME dispatch harness.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	capsuleBankedAt,
	parseVerdictObservation,
	verdictOfCapsule,
	verdictRepeats,
} from "../scripts/lib/verdict-repeat.ts";
import { verdictGateNote } from "../scripts/lib/verdict-repeat-gate.ts";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { REPO, tool, dispatch, addItem } = dispatchHarness(afterAll, {
	tag: "w896-verdict",
});

const VERDICT = "parent operator-gated - nothing new";

/** A dead lane registry row: pid dead, worktree unoccupied, attempt 1. */
const deadLane = (id: string, sid: string): Record<string, unknown> => ({
	sid,
	item: id,
	pid: 99999999,
	branch: `suspenders/${id}`,
	worktree: join(REPO, ".worktrees", id),
	launchedAt: 1,
	attempt: 1,
	host: "scratch",
});

describe("verdict-repeat decision core", () => {
	test("verdictOfCapsule reads the done text, empty when none", () => {
		expect(verdictOfCapsule({ done: "  nothing new  " })).toBe("nothing new");
		expect(verdictOfCapsule({ done: "", next: "x" })).toBe("");
		expect(verdictOfCapsule(null)).toBe("");
	});
	test("capsuleBankedAt parses the bank ts, 0 when absent", () => {
		expect(capsuleBankedAt({ ts: "1690000000000" })).toBe(1690000000000);
		expect(capsuleBankedAt({ ts: "junk" })).toBe(0);
		expect(capsuleBankedAt(null)).toBe(0);
	});
	test("parseVerdictObservation reads stored JSON, null on unset/corrupt", () => {
		expect(
			parseVerdictObservation('{"verdict":"v","ts":42} (v3)\n<schema note>'),
		).toEqual({ verdict: "v", ts: 42 });
		expect(parseVerdictObservation("(unset)")).toBeNull();
		expect(parseVerdictObservation("garbage")).toBeNull();
		expect(parseVerdictObservation('{"ts":42} (v1)')).toBeNull();
	});
	test("verdictRepeats gates only on re-banked verbatim repeat", () => {
		expect(verdictRepeats({ verdict: "v", ts: 100 }, "v", 200)).toBe(true);
		// unchanged capsule = crash that never closed, not a verdict
		expect(verdictRepeats({ verdict: "v", ts: 100 }, "v", 100)).toBe(false);
		expect(verdictRepeats({ verdict: "v", ts: 100 }, "w", 200)).toBe(false);
		expect(verdictRepeats(null, "v", 200)).toBe(false);
		expect(verdictRepeats({ verdict: "v", ts: 0 }, "v", 200)).toBe(false);
		expect(verdictRepeats({ verdict: "v", ts: 100 }, "", 200)).toBe(false);
	});
	test("verdictGateNote carries the verdict verbatim", () => {
		expect(verdictGateNote(VERDICT)).toContain(VERDICT);
	});
});

describe("W896 gate: verbatim re-close operator-gates", () => {
	test("re-dispatch flips the item instead of re-spawning", async () => {
		const id = await addItem("verdict repeat gate fixture");
		const sid = `autow${id.slice(1)}`;
		expect(tool("work.ts", "take", id, "--as", sid).code).toBe(0);
		const caps = tool("coord.ts", "capsule", "set", "--as", sid, `--done=${VERDICT}`);
		expect(caps.code).toBe(0);
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		const stored = '{"verdict":"parent operator-gated - nothing new","ts":1000}';
		const obs = tool("coord.ts", "fact", "set", `lane.${sid}.verdict-last`, "--text", stored, "--source", "dispatch");
		expect(obs.code).toBe(0);
		writeFileSync(join(REPO, ".fleet", "lanes.json"), JSON.stringify([deadLane(id, sid)]));
		const result = dispatch("--item", id);
		expect(result.out).toContain("operator-gated");
		expect(result.out).toContain(VERDICT);
		expect(result.out).toContain("STOP");
		const row = JSON.parse(tool("work.ts", "show", id, "--json").out) as { state: string };
		expect(row.state).toBe("FAILED");
		expect(tool("coord.ts", "fact", "get", `lane.${sid}.verdict-last`).out).toContain("(unset)");
	});
});

describe("W896 gate: fresh verdict banks the observation", () => {
	test("no gate fires, dispatch proceeds, observation recorded", async () => {
		const id = await addItem("verdict repeat negative fixture");
		const sid = `autow${id.slice(1)}`;
		expect(tool("work.ts", "take", id, "--as", sid).code).toBe(0);
		const caps = tool("coord.ts", "capsule", "set", "--as", sid, "--done=fresh look: files moved");
		expect(caps.code).toBe(0);
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(join(REPO, ".fleet", "lanes.json"), JSON.stringify([deadLane(id, sid)]));
		const result = dispatch("--item", id, "--no-belt", "--allow-ungoverned");
		expect(result.out).not.toContain("operator-gated");
		const raw = tool("coord.ts", "fact", "get", `lane.${sid}.verdict-last`).out;
		expect(raw).toContain("fresh look: files moved");
	});
});
