import { describe, expect, test } from "bun:test";
import {
	canSend,
	composeBrief,
	safeTrigger,
	triggerOf,
	verdictFeedback,
	type AutoEvent,
	type AutoItem,
} from "../hooks/lib/chatgpt-auto.ts";

const item: AutoItem = {
	id: "W7",
	title: "Review a rollout",
	description: "Public project work",
	tags: "fleet",
	owner_sid: "lane-7",
	state: "FAILED",
};
const event = (kind: string, note: string): AutoEvent => ({
	id: 42,
	source: "coordinator",
	kind,
	scope: "W7",
	payload: JSON.stringify({ project: "project", item: "W7", note }),
});

describe("ChatGPT auto trigger filter", () => {
	test("decision and GO broadcast select; ordinary broadcast does not", () => {
		expect(
			triggerOf(event("NEED_DECISION", "Choose a path"), item, 0, false)?.cls,
		).toBe("decision");
		expect(
			triggerOf(event("BROADCAST", "GO: review"), item, 0, false)?.cls,
		).toBe("go");
		expect(triggerOf(event("BROADCAST", "status"), item, 0, false)).toBeNull();
	});
	test("failure needs two relaunches; bench needs a landed row", () => {
		expect(
			triggerOf(event("work.failed", "stalled"), item, 2, false),
		).toBeNull();
		expect(
			triggerOf(event("work.failed", "stalled"), item, 3, false)?.cls,
		).toBe("failed");
		expect(triggerOf(event("work.landed", "merged"), item, 0, true)?.cls).toBe(
			"bench",
		);
	});
});

test("request identity and one-per-class hourly cooldown", () => {
	const t = triggerOf(event("NEED_DECISION", "Choose a path"), item, 0, false);
	expect(t?.identity).toBe("decision:W7:42");
	expect(canSend("QUEUED", null, 3_600_000)).toBe(true);
	expect(canSend("QUEUED", 1, 3_600_000)).toBe(false);
	expect(canSend("QUEUED", 0, 3_600_000)).toBe(true);
	expect(canSend("SENT", null, 3_600_000)).toBe(false);
});

test("private or scrubbed text never enters a brief", () => {
	const t = triggerOf(event("NEED_DECISION", "Choose a path"), item, 0, false);
	expect(t && safeTrigger(t)).toBe(true);
	expect(t && safeTrigger({ ...t, note: "IKEA project" })).toBe(false);
	expect(t && safeTrigger({ ...t, note: "key sk-test123456789" })).toBe(false);
	expect(t && safeTrigger({ ...t, scope: "ikea project" })).toBe(false);
});

test("bounded brief snapshot and final-line verdict", () => {
	const t = triggerOf(event("NEED_DECISION", "Choose a path"), item, 0, false);
	if (!t) throw new Error("missing trigger");
	expect(composeBrief(t, "C9")).toMatchInlineSnapshot(`
"Fleet co-supervisor request
Consult: C9
Trigger: decision (event 42)
Item: W7 Review a rollout
State: FAILED
Context: Choose a path
Question: What should the originating lane do next? State assumptions and missing evidence.
Reply through POST /api/consult-reply with your configured project, sid chatgpt-auto, this cid, and answer.
End the answer with exactly one line: VERDICT: PASS or VERDICT: FAIL - reason."
`);
	expect(composeBrief(t, "C9").split("\n").length).toBeLessThanOrEqual(80);
	expect(verdictFeedback("analysis\nVERDICT: PASS")).toBe("pass");
	expect(verdictFeedback("VERDICT: FAIL - missing evidence")).toBe("fail");
	expect(verdictFeedback("VERDICT: PASS\nextra")).toBeNull();
});
