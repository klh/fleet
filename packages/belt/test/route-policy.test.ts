// route-policy.test.ts — W96 hint grammar: parse + fit + verb semantics.
// Pure tests — no fleet, no network: hintFit takes a structural candidate
// (kind, machine, model, tags), so the grammar is provable without booting
// the dashboard or touching metrics.db.
import { describe, expect, test } from "bun:test";
import {
	healthyFirst,
	hintFit,
	hintTotal,
	localProbe,
	parseHint,
	preferOrdered,
} from "../bin/route-policy.ts";

const cand = (
	kind: string,
	machine: string,
	model: string,
	tags: string,
): { kind: string; machine: string; model: string; tags: string } => ({
	kind,
	machine,
	model,
	tags,
});

const LOCAL_REASON = cand(
	"local",
	"m5max",
	"mlx-community/Qwen3.5-35B-A3B-4bit",
	"reason multi-step reasoning, planning, hard analysis, determinate answers mlx-community/Qwen3.5-35B-A3B-4bit",
);

describe("parseHint", () => {
	test("must cloud", () => {
		const p = parseHint("must cloud");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.hint.verb).toBe("must");
			expect(p.hint.location).toEqual({ kind: "cloud" });
			expect(p.hint.tags).toEqual([]);
			expect(p.hint.model).toBeUndefined();
		}
	});

	test("prefer local distill reasoning — the flagship hint", () => {
		const p = parseHint("prefer local distill reasoning");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.hint.verb).toBe("prefer");
			expect(p.hint.location).toEqual({ kind: "local" });
			expect(p.hint.tags).toEqual(["distill", "reasoning"]);
		}
	});

	test("prefer host:nas model:qwen* — host + glob model", () => {
		const p = parseHint("prefer host:nas model:qwen*");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.hint.location).toEqual({ host: "nas" });
			expect(p.hint.model).toBe("qwen*");
		}
	});

	test("rejections — verb, empty host/model, duplicates, token flood", () => {
		expect(parseHint("gimme fast").ok).toBe(false);
		expect(parseHint("prefer host:").ok).toBe(false);
		expect(parseHint("prefer model:").ok).toBe(false);
		expect(parseHint("prefer local cloud").ok).toBe(false);
		expect(parseHint("must model:a model:b").ok).toBe(false);
		expect(parseHint("prefer a b c d e f g h i j k l").ok).toBe(false);
	});

	test("rejections — the no-verb why names all three verbs", () => {
		const r = parseHint("gimme fast");
		expect(r.ok).toBe(false);
		if (!r.ok)
			expect(r.why).toBe(
				"hint must start with 'prefer', 'auto' or 'must', got 'gimme'",
			);
	});
});

describe("hintFit + hintTotal — verb semantics", () => {
	test("flagship hint fully fits the local reason specialist", () => {
		const p = parseHint("prefer local distill reasoning");
		if (!p.ok) throw new Error("parse failed");
		expect(hintFit(LOCAL_REASON, p.hint)).toBe(2);
		expect(hintTotal(p.hint)).toBe(2);
	});

	test("tags are OR: one matching tag satisfies the tag group", () => {
		const p = parseHint("prefer local distill reasoning");
		if (!p.ok) throw new Error("parse failed");
		const extract = cand(
			"local",
			"m5max",
			"mlx-community/Qwen3-4B-Instruct-2507-4bit",
			"extract structured extraction, json shaping, summarization",
		);
		expect(hintFit(extract, p.hint)).toBe(1);
	});

	test("model:qwen* glob matches case-insensitively", () => {
		const p = parseHint("prefer model:qwen*");
		if (!p.ok) throw new Error("parse failed");
		expect(hintTotal(p.hint)).toBe(1);
		expect(hintFit(LOCAL_REASON, p.hint)).toBe(1);
	});

	test("cloud candidate misses the local location group", () => {
		const p = parseHint("prefer local distill reasoning");
		if (!p.ok) throw new Error("parse failed");
		const cloud = cand("cloud", "zai", "glm-5.3", "reasoning code general");
		expect(hintFit(cloud, p.hint)).toBe(1);
	});

	test("host: matches machine name case-insensitively", () => {
		const p = parseHint("prefer host:M5Max");
		if (!p.ok) throw new Error("parse failed");
		expect(hintFit(LOCAL_REASON, p.hint)).toBe(1);
	});
});

describe("auto verb (W228) — the addressable default", () => {
	test("bare 'auto' parses; carries no constraint groups", () => {
		const p = parseHint("auto");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.hint.verb).toBe("auto");
			expect(p.hint.location).toBeUndefined();
			expect(p.hint.model).toBeUndefined();
			expect(p.hint.tags).toEqual([]);
		}
	});
	test("'auto' + constraint tokens → rejected", () => {
		expect(parseHint("auto local reasoning").ok).toBe(false);
	});
	test("auto fits everything at 0 — hintFit/hintTotal stay inert", () => {
		const p = parseHint("auto");
		if (!p.ok) throw new Error("parse failed");
		expect(hintFit(LOCAL_REASON, p.hint)).toBe(0);
		expect(hintTotal(p.hint)).toBe(0);
	});
});

// ─── W986.4: health as an eligibility/ranking guard for soft prefer ───
const spec = (over: Record<string, unknown>) => ({
	machine: "m5max",
	port: 8902,
	model: "m",
	protocol: "openai",
	kind: "local",
	roles: ["reason"],
	tags: "",
	healthy: true,
	estimate_ms: null,
	calls: 0,
	load_5m: 0,
	errors: 0,
	last_used: null,
	probe_ms: null,
	...over,
});

describe("prefer + health guard (W986.4)", () => {
	const hint = parseHint("prefer local distill reasoning");
	if (!hint.ok) throw new Error("parse failed");
	const unhealthyFull = spec({
		port: 8906,
		healthy: false,
		tags: "reason distill reasoning",
	});
	const healthyPartial = spec({ tags: "extract" });

	test("bare preferOrdered still ranks the unhealthy full fit first", () => {
		const ordered = preferOrdered([unhealthyFull, healthyPartial], hint.hint);
		expect(ordered[0]).toBe(unhealthyFull);
	});

	test("healthyFirst demotes it — the healthy fallback executes", () => {
		const ordered = preferOrdered([unhealthyFull, healthyPartial], hint.hint);
		expect(healthyFirst(ordered)?.[0]).toBe(healthyPartial);
	});

	test("no healthy candidate at all → null (fail fast, no tokens)", () => {
		expect(healthyFirst([unhealthyFull, spec({ healthy: false })])).toBeNull();
	});

	test("all healthy keeps the preferOrdered order untouched", () => {
		const a = spec({ tags: "reason distill reasoning" });
		const b = spec({ tags: "extract" });
		expect(healthyFirst(preferOrdered([b, a], hint.hint))).toEqual([a, b]);
	});
});

describe("localProbe — non-2xx /v1/models is unhealthy (W986.4)", () => {
	const withFetch = async (
		res: Response | Error,
		run: () => Promise<void>,
	): Promise<void> => {
		const orig = globalThis.fetch;
		globalThis.fetch = (() =>
			res instanceof Error
				? Promise.reject(res)
				: Promise.resolve(res)) as typeof fetch;
		try {
			await run();
		} finally {
			globalThis.fetch = orig;
		}
	};

	test("HTTP 500 from /v1/models → unhealthy", async () => {
		await withFetch(new Response("boom", { status: 500 }), async () => {
			expect(await localProbe(8906)).toBe(false);
		});
	});

	test("HTTP 200 → healthy", async () => {
		await withFetch(Response.json({ object: "list", data: [] }), async () => {
			expect(await localProbe(8902)).toBe(true);
		});
	});

	test("connection refused → unhealthy", async () => {
		await withFetch(new Error("ECONNREFUSED"), async () => {
			expect(await localProbe(8906)).toBe(false);
		});
	});
});
