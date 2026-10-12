// test/router-walk.test.ts — Router.walkSelected + the W136 escalation gate
// in-process (mocked fetchImpl — no network): selected candidate delivered
// first, must-domain closed, cloud rungs only under the gate.
import { describe, expect, test } from "bun:test";
import { CandidateTable } from "../src/candidates.ts";
import { Cooldowns } from "../src/cooldown.ts";
import { decideRoute } from "../src/decide.ts";
import { parseHint } from "../src/hints.ts";
import { parsePolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const POLICY = parsePolicy(`
gateway:
  num_retries: 1
  allowed_fails: 99
  cooldown_time: 30
  fallbacks:
    glm-5.3-flash: [gpt-5.2]
tags:
  glm-5.3-flash: [fast, cheap, general]
  gpt-5.2: [frontier, reasoning, code]
`);

function poolOf(entries: Array<[string, string[]]>): UpstreamPool {
	const map = new Map(entries);
	return {
		groups: () => [...map.keys()],
		deployments: (g) =>
			(map.get(g) ?? []).map((url) => ({
				group: g,
				url,
				dialect: "openai" as const,
			})),
	};
}

const OK = (): Response => Response.json({ ok: true });
const FAIL = (): Response => Response.json({ e: 1 }, { status: 500 });

/** In-process walk rig: real table + real decide + real Router, mocked
 *  fetch. Returns the executed dep urls in order. */
function rig(
	entries: Array<[string, string[]]>,
	opts: { allowCloud: boolean; tier: string },
) {
	const pool = poolOf(entries);
	const cooldowns = new Cooldowns(99, 30);
	const table = new CandidateTable({ pool, policy: POLICY, cooldowns });
	const prefs = {
		cost_speed: "balanced" as const,
		allow_cloud: opts.allowCloud,
	};
	const executed: string[] = [];
	const router = new Router(POLICY, {
		pool,
		cooldowns,
		sleepMs: async () => {},
		fetchImpl: async (dep) => {
			executed.push(dep.group);
			return dep.group === "gpt-5.2" ? OK() : FAIL();
		},
	});
	const decide = (raw: string | null) => {
		const h = raw ? parseHint(raw) : null;
		return decideRoute({
			hint: h?.ok ? h.hint : null,
			hintRaw: raw ?? "",
			candidates: table.snapshot(),
			prefs,
			dialect: "openai",
		});
	};
	return { router, decide, executed, table };
}

const REQ = (sel: ReturnType<typeof decideRoute>, tier: string) => ({
	group: "glm-5.3-flash",
	dialect: "openai" as const,
	path: "/v1/chat/completions",
	body: { model: "glm-5.3-flash" } as Record<string, unknown>,
	key: "",
	sel: sel.ok ? sel.sel : undefined,
	tier,
});

describe("walkSelected", () => {
	test("gate open + COMPLEX: local fails twice → cloud rung delivers", async () => {
		const { router, decide, executed } = rig(
			[
				["glm-5.3-flash", ["http://127.0.0.1:1"]],
				["gpt-5.2", ["http://cloud"]],
			],
			{ allowCloud: true, tier: "COMPLEX" },
		);
		const sel = decide(null);
		const r = await router.execute(REQ(sel, "COMPLEX"));
		expect(r.kind).toBe("upstream");
		if (r.kind === "upstream") expect(r.tier).toBe("gpt-5.2");
		expect(executed).toEqual(["glm-5.3-flash", "glm-5.3-flash", "gpt-5.2"]);
	});

	test("gate closed (SIMPLE): cloud rung skipped, exhausted", async () => {
		const { router, decide, executed } = rig(
			[
				["glm-5.3-flash", ["http://127.0.0.1:1"]],
				["gpt-5.2", ["http://cloud"]],
			],
			{ allowCloud: true, tier: "SIMPLE" },
		);
		const sel = decide(null);
		const r = await router.execute(REQ(sel, "SIMPLE"));
		expect(r.kind).toBe("exhausted");
		expect(executed.every((g) => g !== "gpt-5.2")).toBe(true);
	});

	test("must full fit: domain closed — no ladder substitution", async () => {
		const { router, decide, executed } = rig(
			[
				["glm-5.3-flash", ["http://127.0.0.1:1"]],
				["gpt-5.2", ["http://cloud"]],
			],
			{ allowCloud: true, tier: "COMPLEX" },
		);
		const sel = decide("must general");
		const r = await router.execute(REQ(sel, "COMPLEX"));
		// the fitted candidate fails → exhausted, NEVER a cloud substitute
		// (law 2 applied to delivery, not just selection)
		expect(r.kind).toBe("exhausted");
		expect(executed).toEqual(["glm-5.3-flash", "glm-5.3-flash"]);
	});
});

// W209: the escalation gate covers prefer/no-hint HEADS too. The cloud
// group sorts first in the pool below, so the no-hint/prefer head IS the
// cloud row — the walk must not deliver it at attempts=0 (W136 §5.2:
// prefs AND tier-warrant AND failed-twice). Only must's demanded set
// bypasses.
describe("walkSelected cloud heads (W209)", () => {
	// cloud group first → the unproven, tiebroken head is the cloud row
	const CLOUD_FIRST: Array<[string, string[]]> = [
		["gpt-5.2", ["http://cloud"]],
		["glm-5.3-flash", ["http://127.0.0.1:1"]],
	];

	test("no-hint COMPLEX: cloud head gated, local tried twice, then ladder escalates", async () => {
		const { router, decide, executed } = rig(CLOUD_FIRST, {
			allowCloud: true,
			tier: "COMPLEX",
		});
		const sel = decide(null);
		const r = await router.execute(REQ(sel, "COMPLEX"));
		expect(r.kind).toBe("upstream");
		if (r.kind === "upstream") expect(r.tier).toBe("gpt-5.2");
		// gated at attempts=0, local earns the escalation with two failures
		expect(executed).toEqual(["glm-5.3-flash", "glm-5.3-flash", "gpt-5.2"]);
	});

	test("no-hint SIMPLE: cloud head gated, never delivered", async () => {
		const { router, decide, executed } = rig(CLOUD_FIRST, {
			allowCloud: true,
			tier: "SIMPLE",
		});
		const sel = decide(null);
		const r = await router.execute(REQ(sel, "SIMPLE"));
		expect(r.kind).toBe("exhausted");
		expect(executed.every((g) => g !== "gpt-5.2")).toBe(true);
	});

	test("prefer tag with cloud head: gated like no-hint (SIMPLE)", async () => {
		const { router, decide, executed } = rig(CLOUD_FIRST, {
			allowCloud: true,
			tier: "SIMPLE",
		});
		const sel = decide("prefer reasoning");
		const r = await router.execute(REQ(sel, "SIMPLE"));
		expect(r.kind).toBe("exhausted");
		expect(executed.every((g) => g !== "gpt-5.2")).toBe(true);
	});

	test("must WITH demand: the demanded cloud candidate still delivers ungated", async () => {
		const { router, decide, executed } = rig(CLOUD_FIRST, {
			allowCloud: true,
			tier: "SIMPLE",
		});
		const sel = decide("must reasoning");
		const r = await router.execute(REQ(sel, "SIMPLE"));
		expect(r.kind).toBe("upstream");
		if (r.kind === "upstream") expect(r.tier).toBe("gpt-5.2");
		expect(executed).toEqual(["gpt-5.2"]); // attempts=0, demanded set
	});

	test("bare must (empty demand): not a demanded set — cloud head gated", async () => {
		const { router, decide, executed } = rig(CLOUD_FIRST, {
			allowCloud: true,
			tier: "SIMPLE",
		});
		const sel = decide("must");
		const r = await router.execute(REQ(sel, "SIMPLE"));
		expect(r.kind).toBe("exhausted");
		expect(executed.every((g) => g !== "gpt-5.2")).toBe(true);
	});
});
