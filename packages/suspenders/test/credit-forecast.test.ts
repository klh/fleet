// test/credit-forecast.test.ts — W566 premium-credit headroom forecast.
// Pure core exercised with injected now/paths/deps — no bus, no coord CLI,
// no real cache files (quota-sweep test doctrine).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	alertKeyOf,
	assess,
	appendSample,
	forecastHeadroom,
	forecastPush,
	loadSamples,
	parseMultipliers,
	policyFromArgv,
	shouldAlert,
	windowedDeltas,
} from "../hooks/lib/credit-forecast.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "credit-forecast-"));
	dirs.push(root);
	return root;
};

const H = 3_600_000;
const sample = (at: number, used: number, plan = "business") => ({
	at,
	used,
	limit: 50000,
	plan,
	multipliers: { opus: 15, sonnet: 1 },
	source: "dashboard",
});
describe("parseMultipliers", () => {
	test("pairs parse, junk drops", () => {
		expect(parseMultipliers("opus=15,sonnet=1")).toEqual({
			opus: 15,
			sonnet: 1,
		});
		expect(parseMultipliers("opus=15,oops,sonnet=x")).toEqual({ opus: 15 });
	});
});

describe("loadSamples", () => {
	test("missing file → empty, malformed drops, sorted", () => {
		expect(loadSamples("/nonexistent/credit-samples.jsonl")).toEqual([]);
		const root = tempRoot();
		const p = join(root, "samples.jsonl");
		writeFileSync(
			p,
			[
				JSON.stringify({ at: 200, used: 100, limit: 500 }),
				"not json at all",
				JSON.stringify({ at: 100, used: 50, limit: 500 }),
				JSON.stringify({ at: 300, used: "many", limit: 500 }),
				JSON.stringify({ at: 400, limit: 500 }),
			].join("\n"),
		);
		const s = loadSamples(p);
		expect(s.map((x) => x.at)).toEqual([100, 200]);
		expect(s[1]?.plan).toBe("unknown");
	});
});
describe("windowedDeltas", () => {
	test("per-window math, fallback anchor, min-span gate", () => {
		const now = 100 * H;
		const s = [sample(0, 29000), sample(50 * H, 29500), sample(100 * H, 29986)];
		const w = windowedDeltas(s, now);
		const by = (l: string) => w.find((x) => x.label === l);
		// 1h window: anchor falls back to first sample ≤ now−1h → 99h? none —
		// anchors are 0/50/100h; last ≤ 99h is 50h → span 50h, delta 486
		expect(by("1h")?.spanMs).toBe(50 * H);
		expect(by("1h")?.perHour).toBeCloseTo((486 / (50 * H)) * H, 5);
		// 24h + 7d share the 50h anchor
		expect(by("24h")?.perHour).toBeCloseTo((486 / (50 * H)) * H, 5);
		// samples closer than 5 min never extrapolate
		const thin = windowedDeltas(
			[sample(0, 29000), sample(60_000, 29500)],
			60_000,
		);
		expect(thin.every((x) => x.perHour === null)).toBe(true);
	});
});

describe("forecastHeadroom", () => {
	test("owner numbers: remaining + pct", () => {
		const f = forecastHeadroom([sample(0, 29986)], { now: H });
		expect(f.ok).toBe(true);
		expect(f.remaining).toBe(20014);
		expect(f.pctUsed).toBeCloseTo(59.972, 2);
	});
	test("negative burn never extrapolates; stale sample noted", () => {
		const f = forecastHeadroom(
			[sample(0, 29986), sample(10 * H, 29000)],
			{ now: 10 * H },
		);
		expect(f.runwayHours).toBeNull();
		expect(f.notes.some((n) => /top-up or correction/.test(n))).toBe(true);
		const g = forecastHeadroom([sample(0, 29986)], { now: 100 * H });
		expect(g.notes.some((n) => /h old/.test(n))).toBe(true);
	});
});
const fc = (over: any = {}): any => ({ ok: true, at: 0, used: 29986, limit: 50000, remaining: 20014, pctUsed: 60, plan: "business", multipliers: {}, source: "dashboard", windows: [], burnPerHour: 40, runwayHours: null, uncertainty: { low: null, high: null }, notes: [], ...over });
const pol = (over: any = {}): any => ({ queued: null, costPerItem: null, horizonHours: 48, overagePermitted: true, overageUnitCost: null, ...over });

describe("assess", () => {
	test("need arm: over pool → WARN with overage math", () => {
		const a = assess(fc(), pol({ queued: 700, costPerItem: 40, overageUnitCost: 0.04 }));
		expect(a.verdict).toBe("WARN");
		expect(a.arms).toContain("need");
		expect(a.overageUnits).toBe(7986);
		expect(a.overageCost).toBeCloseTo(319.44, 2);
		expect(a.lines.some((l) => /ALERT need/.test(l))).toBe(true);
	});
	test("overage not permitted → defer line, cost null", () => {
		const a = assess(fc(), pol({ queued: 700, costPerItem: 40, overagePermitted: false }));
		expect(a.overageCost).toBeNull();
		expect(a.lines.some((l) => /overage NOT permitted/.test(l))).toBe(true);
	});
	test("runway arm: pessimistic band drains before horizon", () => {
		const a = assess(fc({ uncertainty: { low: 400, high: 500 } }), pol());
		expect(a.arms).toContain("runway");
		expect(a.lines.some((l) => /ALERT runway/.test(l))).toBe(true);
	});
	test("OK when need fits and runway is long", () => {
		const a = assess(fc({ uncertainty: { low: 40, high: 50 } }), pol({ queued: 12, costPerItem: 40 }));
		expect(a.verdict).toBe("OK");
		expect(a.arms).toEqual([]);
	});
	test("budget unknown when queue/cost unconfigured (never inferred from tokens)", () => {
		const a = assess(fc(), pol());
		expect(a.lines.some((l) => /push budget: UNKNOWN/.test(l))).toBe(true);
	});
});
describe("dedupe", () => {
	const now = 1_000_000;
	test("first pass: warn alerts, ok/unknown stay quiet", () => {
		expect(shouldAlert(null, "warn:need", now, H)).toBe(true);
		expect(shouldAlert(null, "OK", now, H)).toBe(false);
		expect(shouldAlert(null, "UNKNOWN", now, H)).toBe(false);
	});
	test("key change re-alerts (escalation + recovery)", () => {
		expect(shouldAlert({ key: "warn:need", at: now }, "warn:need+runway", now, H)).toBe(true);
		expect(shouldAlert({ key: "warn:need", at: now }, "OK", now, H)).toBe(true);
	});
	test("same key re-alerts only after the window", () => {
		expect(shouldAlert({ key: "warn:need", at: now }, "warn:need", now + 1, H)).toBe(false);
		expect(shouldAlert({ key: "warn:need", at: now }, "warn:need", now + H + 1, H)).toBe(true);
	});
	test("alert key carries the fired arms", () => {
		expect(alertKeyOf({ verdict: "WARN", arms: ["runway", "need"] } as any)).toBe("warn:need+runway");
		expect(alertKeyOf({ verdict: "OK", arms: [] } as any)).toBe("OK");
	});
});

describe("policyFromArgv", () => {
	test("flags parse; absent flags leave the field unset", () => {
		const p = policyFromArgv(["forecast", "--queued", "12", "--cost-per-item", "40", "--horizon-hours", "24", "--overage-permitted", "--overage-cost", "0.04"]);
		expect(p.queued).toBe(12);
		expect(p.costPerItem).toBe(40);
		expect(p.horizonHours).toBe(24);
		expect(p.overagePermitted).toBe(true);
		expect(p.overageUnitCost).toBe(0.04);
		expect("overagePermitted" in policyFromArgv([])).toBe(false);
	});
});
describe("forecastPush", () => {
	test("act warn fires once, dedupes, escalates on new arm", () => {
		const root = tempRoot();
		const db = join(root, "s.jsonl");
		appendSample(db, sample(0, 29986));
		appendSample(db, sample(6 * H, 32386));
		// burn 400/h → remaining 17614/400 = 44h point runway; single rate →
		// band = point → pess 44h < 48h horizon → runway arm fires
		const seen: string[] = [];
		const st: { key: string; at: number }[] = [];
		const readSt = () => (st.length === 0 ? null : (st[st.length - 1] ?? null));
		const deps = {
			act: true,
			samplesPath: db,
			statePath: join(root, "state.json"),
			now: 6 * H,
			dedupeMs: 24 * H,
			policy: { queued: 12, costPerItem: 40, horizonHours: 48, overagePermitted: true } as any,
			emit: (kind: string) => seen.push(kind),
			broadcast: (n: string) => seen.push(`bc:${n}`),
			factSet: (k: string) => seen.push(`fact:${k}`),
			stateRead: readSt,
			stateWrite: (s: { key: string; at: number }) => st.push(s),
		};
		const first = forecastPush(deps);
		expect(first).toContain("WARN");
		expect(seen.filter((k) => k === "credit.headroom.warn")).toHaveLength(1);
		expect(seen.some((k) => k.startsWith("bc:"))).toBe(true);
		expect(seen.some((k) => k.startsWith("fact:copilot.credits.headroom"))).toBe(true);
		// same key inside the window → quiet, no extra emit
		expect(forecastPush({ ...deps, now: 6 * H + H })).toBeNull();
		expect(seen.filter((k) => k === "credit.headroom.warn")).toHaveLength(1);
		// state write recorded the key
		expect(readSt()?.key).toBe("warn:runway");
	});
	test("report-only never writes state or alerts", () => {
		const root = tempRoot();
		const db = join(root, "s.jsonl");
		appendSample(db, sample(0, 29986));
		appendSample(db, sample(6 * H, 32386));
		const seen: string[] = [];
		const line = forecastPush({
			act: false,
			samplesPath: db,
			now: 6 * H,
			policy: { queued: 12, costPerItem: 40, horizonHours: 48, overagePermitted: true } as any,
			emit: (kind: string) => seen.push(kind),
			stateRead: () => null,
			stateWrite: () => {},
		});
		expect(line).toContain("WARN");
		expect(seen).toEqual([]);
	});
	test("no samples → UNKNOWN, first pass stays silent", () => {
		const root = tempRoot();
		const line = forecastPush({
			act: true,
			samplesPath: join(root, "absent.jsonl"),
			now: 0,
			stateRead: () => null,
			stateWrite: () => {},
		});
		expect(line).toBeNull();
	});
});
describe("guarantees", () => {
	test("no reset ETA anywhere in the surfaces", () => {
		const f = forecastHeadroom([sample(0, 29986), sample(6 * H, 32386)], { now: 6 * H });
		const a = assess(f, pol({ queued: 12, costPerItem: 40 }));
		expect(/reset/i.test(JSON.stringify(f))).toBe(false);
		expect(/reset/i.test(JSON.stringify(a))).toBe(false);
	});
	test("scrub keeps /Users paths out of the alert note", () => {
		const seen: string[] = [];
		const root = tempRoot();
		const db = join(root, "s.jsonl");
		appendSample(db, sample(0, 29986));
		appendSample(db, sample(6 * H, 32386));
		forecastPush({
			act: true,
			samplesPath: db,
			now: 6 * H,
			policy: { queued: 12, costPerItem: 40, horizonHours: 48, overagePermitted: true } as any,
			emit: (_k: string, note: string) => seen.push(note),
			broadcast: (n: string) => seen.push(n),
			factSet: () => {},
			stateRead: () => null,
			stateWrite: () => {},
		});
		for (const n of seen) expect(n.includes("/Users/")).toBe(false);
	});
	test("appendSample round-trips through loadSamples", () => {
		const root = tempRoot();
		const db = join(root, "s.jsonl");
		appendSample(db, sample(5, 100, "business"));
		appendSample(db, sample(10, 150, "enterprise"));
		const s = loadSamples(db);
		expect(s.map((x) => [x.at, x.used, x.plan])).toEqual([
			[5, 100, "business"],
			[10, 150, "enterprise"],
		]);
	});
});
