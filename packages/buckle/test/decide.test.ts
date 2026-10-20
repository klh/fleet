// test/decide.test.ts — W136 §4 semantics: must never substitutes, prefer
// degrades by policy, no-hint = proven-latency ordering, the W136 escalation
// gate, latency classes.
import { describe, expect, test } from "bun:test";
import type { CandidateRow } from "../src/candidates.ts";
import {
	compareCandidates,
	decideRoute,
	latencyClass,
	mayEscalate,
} from "../src/decide.ts";
import { parseHint } from "../src/hints.ts";
import type { Prefs } from "../src/policy.ts";

let seq = 0;
const row = (over: Partial<CandidateRow> = {}): CandidateRow => ({
	candidate_id: `h:${String(9000 + seq++)}:m`,
	kind: "local",
	host: "h",
	port: 9000 + seq,
	model: "m",
	dialect: "openai",
	group: "glm-5.3-flash",
	capability_text: "fast cheap glm-5.3-flash",
	dep: {
		group: "glm-5.3-flash",
		url: `http://h:${String(9000 + seq)}`,
		dialect: "openai",
	},
	healthy: true,
	estimate_ms: null,
	calls: 0,
	errors: 0,
	load: 0,
	last_used: null,
	...over,
});

const HINT = (raw: string | null) => {
	if (!raw) return null;
	const r = parseHint(raw);
	return r.ok ? r.hint : null;
};

const PREFS_OPEN: Prefs = { cost_speed: "balanced", allow_cloud: true };
const decide = (
	hintRaw: string | null,
	candidates: CandidateRow[],
	prefs: Prefs = PREFS_OPEN,
	dialect: "openai" | "anthropic" = "openai",
	group = "",
) =>
	decideRoute({
		hint: HINT(hintRaw),
		hintRaw: hintRaw ?? "",
		group,
		candidates,
		prefs,
		dialect,
	});

describe("must (law 2)", () => {
	test("full fit → policy, ordered by proven-latency", () => {
		const a = row({ estimate_ms: 900, calls: 5 });
		const b = row({ estimate_ms: 400, calls: 5 });
		const r = decide("must fast", [a, b]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.decision).toBe("policy");
			expect(r.sel.head.candidate_id).toBe(b.candidate_id);
			expect(r.sel.fit).toBe(1);
		}
	});
	test("no healthy full fit → no_healthy_fit, never a substitute", () => {
		const r = decide("must speed", [row(), row({ healthy: false })]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.err.code).toBe("no_healthy_fit");
			expect(r.err.why).toContain("must never substitutes");
		}
	});
	test("must cloud + gate closed → cloud_forbidden", () => {
		const cloud = row({ kind: "cloud", host: "cloud.example" });
		const r = decide("must cloud", [cloud], {
			cost_speed: "balanced",
			allow_cloud: false,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.err.code).toBe("cloud_forbidden");
	});
	test("must local never selects cloud even when warranted", () => {
		const cloud = row({ kind: "cloud", capability_text: "frontier reasoning" });
		const local = row({ capability_text: "local general" });
		const r = decide("must local", [cloud, local]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.kind).toBe("local");
	});
});

describe("prefer (law 3)", () => {
	test("full fit wins; head below full fit degrades and says so", () => {
		const good = row({ capability_text: "fast general" });
		const better = row({ capability_text: "fast general reasoning" });
		const r = decide("prefer reasoning", [good, better]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.candidate_id).toBe(better.candidate_id);
			expect(r.sel.decision).toBe("policy");
		}
		const r2 = decide("prefer reasoning", [good]);
		expect(r2.ok).toBe(true);
		if (r2.ok) {
			expect(r2.sel.decision).toBe("degraded");
			expect(r2.sel.fit).toBe(0);
		}
	});
	test("prefer cloud + gate closed → degraded local (never refused)", () => {
		const local = row({ capability_text: "local general" });
		const r = decide("prefer cloud", [local], {
			cost_speed: "balanced",
			allow_cloud: false,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.kind).toBe("local");
			expect(r.sel.decision).toBe("degraded");
		}
	});
});

describe("no hint (law 4)", () => {
	test("healthy → proven → effMs → errors → LRU (belt parity)", () => {
		const unproven = row({ calls: 0 });
		const provenSlow = row({ estimate_ms: 900, calls: 3 });
		const provenFast = row({ estimate_ms: 200, calls: 3 });
		const unhealthy = row({ healthy: false, estimate_ms: 1, calls: 3 });
		const r = decide(null, [unproven, provenSlow, unhealthy, provenFast]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const ids = r.sel.ordered.map((c) => c.candidate_id);
			expect(ids).toEqual([
				provenFast.candidate_id,
				provenSlow.candidate_id,
				unproven.candidate_id,
				unhealthy.candidate_id,
			]);
			expect(r.sel.decision).toBe("policy");
		}
	});
	test("load penalty bends effMs", () => {
		const loaded = row({ estimate_ms: 100, calls: 2, load: 10 });
		const calm = row({ estimate_ms: 150, calls: 2 });
		const r = decide(null, [loaded, calm]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.candidate_id).toBe(calm.candidate_id);
	});
});

describe("escalation gate (W136 §5.2)", () => {
	const cloud = new Set(["gpt-5.2"]);
	const base = {
		group: "gpt-5.2",
		tier: "COMPLEX",
		prefs: PREFS_OPEN,
		cloudGroups: cloud,
	};
	test("all conditions AND-ed", () => {
		expect(mayEscalate({ ...base, attempts: 2 })).toBe(true);
		expect(mayEscalate({ ...base, attempts: 1 })).toBe(false);
		expect(
			mayEscalate({
				...base,
				attempts: 2,
				prefs: { ...PREFS_OPEN, allow_cloud: false },
			}),
		).toBe(false);
		expect(
			mayEscalate({
				...base,
				attempts: 2,
				prefs: { ...PREFS_OPEN, cost_speed: "cost" },
			}),
		).toBe(false);
		expect(mayEscalate({ ...base, attempts: 2, tier: "SIMPLE" })).toBe(false);
		expect(mayEscalate({ ...base, attempts: 2, tier: "MEDIUM" })).toBe(false);
		expect(
			mayEscalate({
				...base,
				attempts: 2,
				tier: "SIMPLE",
				prefs: { ...PREFS_OPEN, cost_speed: "quality" },
			}),
		).toBe(true); // quality mode warrants regardless of tier
		expect(mayEscalate({ ...base, attempts: 2, group: "local-swarm" })).toBe(
			false,
		); // non-cloud rung is not an escalation
	});
});

describe("latency classes", () => {
	test("unproven | fast | medium | slow thresholds", () => {
		expect(latencyClass(null)).toBe("unproven");
		expect(latencyClass(138)).toBe("fast");
		expect(latencyClass(499)).toBe("fast");
		expect(latencyClass(500)).toBe("medium");
		expect(latencyClass(1999)).toBe("medium");
		expect(latencyClass(2000)).toBe("slow");
	});
	test("compareCandidates is the exported law-4 comparator", () => {
		const a = row({ estimate_ms: 100, calls: 2 });
		const b = row({ estimate_ms: 200, calls: 2 });
		expect(compareCandidates(a, b)).toBeLessThan(0);
		expect(compareCandidates(b, a)).toBeGreaterThan(0);
	});
});

describe("W426 cross-dialect eligibility", () => {
	const antRow = (over: Partial<CandidateRow> = {}) =>
		row({ dialect: "anthropic", ...over });

	test("default: other-dialect rows are invisible", () => {
		const r = decide(null, [antRow()]);
		expect(r.ok).toBe(false);
	});

	test("allowCross: cross rows eligible but ranked behind same-dialect", () => {
		const same = row();
		const cross = antRow({ estimate_ms: 1, calls: 9 }); // provably faster
		const r = decideRoute({
			hint: null,
			hintRaw: "",
			group: "other-group",
			candidates: [cross, same],
			prefs: PREFS_OPEN,
			dialect: "openai",
			allowCross: true,
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.candidate_id).toBe(same.candidate_id);
	});

	test("allowCross: cross row delivers when it is the only row", () => {
		const r = decideRoute({
			hint: null,
			hintRaw: "",
			group: "other-group",
			candidates: [antRow()],
			prefs: PREFS_OPEN,
			dialect: "openai",
			allowCross: true,
		});
		expect(r.ok).toBe(true);
	});
});

describe("W690 explicit-model pins (W694 M1-M4)", () => {
	const PIN = "glm-5.3-flash";
	const antRow = (over: Partial<CandidateRow> = {}) =>
		row({ dialect: "anthropic", ...over });

	test("pin scopes to the group's rows — other groups invisible even when faster", () => {
		const pinned = row({ estimate_ms: 10, calls: 5 });
		const faster = row({ group: "other-group", estimate_ms: 1, calls: 9 });
		const r = decide(null, [pinned, faster], PREFS_OPEN, "openai", PIN);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.candidate_id).toBe(pinned.candidate_id);
	});

	test("no matching rows → the old whole-pool preference walk", () => {
		const only = row();
		const r = decide(null, [only], PREFS_OPEN, "openai", "no-such-group");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.candidate_id).toBe(only.candidate_id);
	});

	test("pin + allowCross: every pinned row listed exactly once (W694 M1)", () => {
		const same = row();
		const cross = antRow();
		const r = decideRoute({
			hint: null,
			hintRaw: "",
			group: PIN,
			candidates: [same, cross],
			prefs: PREFS_OPEN,
			dialect: "openai",
			allowCross: true,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			const ids = r.sel.ordered.map((c) => c.candidate_id);
			expect(ids).toEqual([same.candidate_id, cross.candidate_id]);
			expect(r.sel.seen).toBe(2);
		}
	});

	test("count_tokens-style pin (allowCross:false) scopes to the request dialect (W694 M2)", () => {
		const same = row();
		const cross = antRow();
		const r = decide(null, [same, cross], PREFS_OPEN, "openai", PIN);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.candidate_id).toBe(same.candidate_id);
			expect(r.sel.seen).toBe(1);
		}
		const crossOnly = decide(null, [antRow()], PREFS_OPEN, "openai", PIN);
		expect(crossOnly.ok).toBe(false);
		if (!crossOnly.ok) expect(crossOnly.err.code).toBe("no_route");
	});

	test("all-unhealthy pin → no_healthy_fit naming the pin (W694 M3)", () => {
		const r = decide(
			null,
			[row({ healthy: false }), row({ healthy: false })],
			PREFS_OPEN,
			"openai",
			PIN,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.err.code).toBe("no_healthy_fit");
			expect(r.err.why).toContain("pin 'glm-5.3-flash'");
			expect(r.err.why).not.toContain("vs pin");
		}
	});

	test("an explicit policy fallback replaces an unhealthy pin and names the delivered group", () => {
		const dead = row({ group: "claude-sonnet-5", healthy: false });
		const glm = row({ group: "glm-5.3-flash", model: "zai-glm-5.3-flash" });
		const unrelated = row({ group: "other", estimate_ms: 1, calls: 10 });
		const r = decideRoute({
			hint: null,
			hintRaw: "",
			group: "claude-sonnet-5",
			candidates: [dead, glm, unrelated],
			prefs: PREFS_OPEN,
			dialect: "openai",
			allowCross: true,
			fallbackGroups: ["glm-5.3-flash"],
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.group).toBe("glm-5.3-flash");
			expect(r.sel.decision).toBe("fallback");
			expect(r.sel.why).toContain("configured fallback claude-sonnet-5");
		}
	});

	test("a must hint and a closed cloud gate cannot use the configured fallback", () => {
		const dead = row({ group: "claude-sonnet-5", healthy: false });
		const glm = row({ group: "glm-5.3-flash", kind: "cloud" });
		const base = {
			group: "claude-sonnet-5",
			candidates: [dead, glm],
			dialect: "openai" as const,
			allowCross: true,
			fallbackGroups: ["glm-5.3-flash"],
		};
		const must = decideRoute({
			...base,
			hint: HINT("must model:claude*"),
			hintRaw: "must model:claude*",
			prefs: PREFS_OPEN,
		});
		expect(must.ok).toBe(false);
		const closed = decideRoute({
			...base,
			hint: null,
			hintRaw: "",
			prefs: { cost_speed: "balanced", allow_cloud: false },
		});
		expect(closed.ok).toBe(false);
	});

	test("mixed-health pin heads the healthy row", () => {
		const dead = row({ healthy: false, estimate_ms: 1, calls: 9 });
		const alive = row({ estimate_ms: 900, calls: 5 });
		const r = decide(null, [dead, alive], PREFS_OPEN, "openai", PIN);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.candidate_id).toBe(alive.candidate_id);
	});

	test("must vs pin conflict names both demands (W694 M3)", () => {
		const r = decide("must model:other*", [row()], PREFS_OPEN, "openai", PIN);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.err.code).toBe("no_healthy_fit");
			expect(r.err.why).toContain(`vs pin '${PIN}'`);
			expect(r.err.why).toContain("must never substitutes");
		}
	});

	test("must agreeing with the pin delivers inside it", () => {
		const tagged = row({ capability_text: "fast glm-5.3-flash" });
		const r = decide("must fast", [tagged], PREFS_OPEN, "openai", PIN);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.candidate_id).toBe(tagged.candidate_id);
			expect(r.sel.decision).toBe("policy");
		}
	});

	test("must cloud + gate closed keeps owner-gate precedence over the pin", () => {
		const cloud = row({ kind: "cloud", host: "cloud.example" });
		const r = decide(
			"must cloud",
			[cloud],
			{ cost_speed: "balanced", allow_cloud: false },
			"openai",
			PIN,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.err.code).toBe("cloud_forbidden");
	});

	test("unpinned must keeps the plain no-fit error", () => {
		const r = decide("must model:other*", [row()], PREFS_OPEN, "openai", "");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.err.why).toContain("no healthy full fit");
			expect(r.err.why).not.toContain("vs pin");
		}
	});
});

describe("W709 pin cloud gate (W694 H3)", () => {
	const PIN = "glm-5.3-flash";
	const CLOSED: Prefs = { cost_speed: "balanced", allow_cloud: false };

	test("pinned cloud group + gate closed → cloud_forbidden, never the cloud head", () => {
		const cloud = row({ kind: "cloud", host: "cloud.example" });
		for (const hintRaw of [null, "prefer fast"]) {
			const r = decide(hintRaw, [cloud], CLOSED, "openai", PIN);
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.err.code).toBe("cloud_forbidden");
				expect(r.err.why).toContain(`pin '${PIN}'`);
			}
		}
	});

	test("mixed pin + gate closed → local row heads, cloud row invisible", () => {
		const cloud = row({
			kind: "cloud",
			host: "cloud.example",
			estimate_ms: 1,
			calls: 9,
		});
		const local = row({ estimate_ms: 900, calls: 5 });
		const r = decide(null, [cloud, local], CLOSED, "openai", PIN);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.candidate_id).toBe(local.candidate_id);
			expect(r.sel.ordered.every((c) => c.kind === "local")).toBe(true);
		}
	});

	test("pinned cloud group + gate open still delivers the pin", () => {
		const cloud = row({ kind: "cloud", host: "cloud.example" });
		const r = decide(null, [cloud], PREFS_OPEN, "openai", PIN);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.kind).toBe("cloud");
	});

	test("gate-closed pin + non-cloud must: owner gate precedes the must conflict", () => {
		const cloud = row({ kind: "cloud", host: "cloud.example" });
		const r = decide("must model:other*", [cloud], CLOSED, "openai", PIN);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.err.code).toBe("cloud_forbidden");
			expect(r.err.why).toContain(`pin '${PIN}'`);
		}
	});
});

describe("auto (W228) — the addressable default", () => {
	test("auto = law-4 ordering: proven candidate heads over unproven, decision policy", () => {
		const proven = row({ estimate_ms: 120, calls: 9 });
		const unproven = row({ estimate_ms: null });
		const r = decide("auto", [unproven, proven]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.sel.head.candidate_id).toBe(proven.candidate_id);
			expect(r.sel.decision).toBe("policy");
			expect(r.sel.fit).toBe(0);
			expect(r.sel.total).toBe(0);
			expect(r.sel.verb).toBe("auto");
		}
	});

	test("gate-closed: auto never heads cloud, policy still answers", () => {
		const cloud = row({
			kind: "cloud",
			host: "cloud.example",
			estimate_ms: 300,
			calls: 4,
		});
		const localProven = row({ estimate_ms: 150, calls: 7 });
		const r = decide("auto", [cloud, localProven], {
			cost_speed: "balanced",
			allow_cloud: false,
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.sel.head.kind).toBe("local");
	});

	test("the three-way distinction on one pool: must local refuses, prefer local degrades, auto delivers", () => {
		const cloud = row({
			kind: "cloud",
			host: "cloud.example",
			estimate_ms: 300,
			calls: 4,
		});
		const must = decide("must local", [cloud]);
		expect(must.ok).toBe(false);
		if (!must.ok) expect(must.err.code).toBe("no_healthy_fit");

		const prefer = decide("prefer local", [cloud]);
		expect(prefer.ok).toBe(true);
		if (prefer.ok) {
			expect(prefer.sel.head.kind).toBe("cloud");
			expect(prefer.sel.decision).toBe("degraded");
		}

		const auto = decide("auto", [cloud]);
		expect(auto.ok).toBe(true);
		if (auto.ok) {
			expect(auto.sel.head.kind).toBe("cloud");
			expect(auto.sel.decision).toBe("policy");
			expect(auto.sel.fit).toBe(0);
		}
	});
});
