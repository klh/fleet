// W304.2 — knob-gated inbound condense for the belt :4000 router. Pure
// module tests (router-condense.ts) — never binds :4000. Pins: knob off =
// byte-identical passthrough (same array identity, no metadata); knob on =
// protected surface survives (blam law L1), hedges survive (law L2), rules
// audited (law L5); metadata is deterministic — the input any future
// response-cache key must include (no belt-side cache exists today).
import { describe, expect, test } from "bun:test";
import { CONDENSE_VERSION } from "../../blam/src/condense/version.ts";
import {
	applyInboundCondense,
	CONDENSE_PREFS_DEFAULT,
	type CondenseMeta,
	resolveCondensePrefs,
} from "../bin/router-condense.ts";
import type { ChatMessage } from "../bin/router-core.ts";

const PROSE =
	"Hi there! Could you please fix the bug in src/app.ts? Thanks so much!";

describe("condense knob resolution", () => {
	test("default is OFF + caveman (dispatch traffic is pre-condensed at source)", () => {
		expect(resolveCondensePrefs(undefined)).toEqual(CONDENSE_PREFS_DEFAULT);
		expect(resolveCondensePrefs(null)).toEqual(CONDENSE_PREFS_DEFAULT);
		expect(resolveCondensePrefs("yes")).toEqual(CONDENSE_PREFS_DEFAULT);
		expect(CONDENSE_PREFS_DEFAULT.enabled).toBe(false);
		expect(CONDENSE_PREFS_DEFAULT.tier).toBe("caveman");
	});

	test("knob parses enabled/tier; unknown tier fails safe to caveman+off", () => {
		expect(resolveCondensePrefs({ enabled: true })).toEqual({
			enabled: true,
			tier: "caveman",
		});
		expect(resolveCondensePrefs({ tier: "politeness" })).toEqual({
			enabled: false,
			tier: "politeness",
		});
		expect(
			resolveCondensePrefs({ enabled: "yes", tier: "aggressive" }),
		).toEqual({ enabled: false, tier: "caveman" });
	});
});

describe("knob off — byte-identical passthrough", () => {
	test("same array identity, no metadata, content verbatim", () => {
		const msgs: ChatMessage[] = [
			{ role: "system", content: "Only touch X if just asked." },
			{ role: "user", content: PROSE },
		];
		const out = applyInboundCondense(msgs, CONDENSE_PREFS_DEFAULT);
		expect(out.meta).toBeNull();
		expect(out.messages).toBe(msgs);
		expect(out.messages[1].content).toBe(PROSE);
	});
});

describe("knob on — caveman inbound", () => {
	test("user prose condenses; protected path survives verbatim", () => {
		const out = applyInboundCondense([{ role: "user", content: PROSE }], {
			enabled: true,
		});
		const text = out.messages[0].content;
		expect(text).not.toBe(PROSE);
		expect(text).toContain("fix the bug");
		expect(text).toContain("src/app.ts"); // law L1: paths restored verbatim
		expect(out.meta?.version).toBe(CONDENSE_VERSION);
	});

	test("protected surface: fences, inline code, URLs stay verbatim; hedges survive", () => {
		const body = [
			"Please update ```py\nprint('hi')\n``` and check https://example.com/x",
			"the helper in `src/run.ts` should be very fast, really.",
		].join("\n");
		const out = applyInboundCondense([{ role: "user", content: body }], {
			enabled: true,
		});
		const text = out.messages[0].content;
		expect(text).toContain("```py\nprint('hi')\n```");
		expect(text).toContain("https://example.com/x");
		expect(text).toContain("`src/run.ts`");
		// law L2: hedges are meaning — the caveman tier never strips them
		expect(text).toContain("very fast, really");
	});

	test("system + assistant ride verbatim (user messages only)", () => {
		const sys = "You are a harness. Only touch X if just asked.";
		const asst = "Understood — I'll be very careful.";
		const user = "Could you please explain the event loop?";
		const out = applyInboundCondense(
			[
				{ role: "system", content: sys },
				{ role: "user", content: user },
				{ role: "assistant", content: asst },
			],
			{ enabled: true },
		);
		expect(out.messages[0].content).toBe(sys);
		expect(out.messages[2].content).toBe(asst);
		expect(out.messages[1].content).not.toBe(user);
	});

	test("never condenses a user message into nothing", () => {
		const only = "Hi there! Thanks so much!";
		const out = applyInboundCondense([{ role: "user", content: only }], {
			enabled: true,
		});
		expect(out.messages[0].content).toBe(only);
	});
});

describe("metadata — rules audit + cache-key surface", () => {
	test("rules counted, deduped, deterministic across runs", () => {
		const msgs: ChatMessage[] = [{ role: "user", content: PROSE }];
		const a = applyInboundCondense(msgs, { enabled: true })
			.meta as CondenseMeta;
		const b = applyInboundCondense(msgs, { enabled: true })
			.meta as CondenseMeta;
		expect(a).toEqual(b);
		expect(a.rules.length).toBe(new Set(a.rules).size);
		expect(a.rules).toContain("filler:greeting");
		expect(a.rules).toContain("filler:thanks");
	});

	test("tier choice is visible in metadata (a future cache key must include it)", () => {
		const dup =
			"The task is to parse the config. The task is to parse the config files.";
		const cav = applyInboundCondense([{ role: "user", content: dup }], {
			enabled: true,
			tier: "caveman",
		});
		const pol = applyInboundCondense([{ role: "user", content: dup }], {
			enabled: true,
			tier: "politeness",
		});
		expect(cav.meta?.tier).toBe("caveman");
		expect(pol.meta?.tier).toBe("politeness");
		// jaccard sentence dedupe is caveman-only → same input, different bytes
		expect(cav.messages[0].content).not.toBe(pol.messages[0].content);
		expect(cav.meta?.rules).toContain("dedupe:sentence");
		expect(pol.meta?.rules).not.toContain("dedupe:sentence");
	});
});
