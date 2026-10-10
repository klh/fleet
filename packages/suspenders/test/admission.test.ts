// tests for bin/admission.ts — pure logic + temp-file seams, no network.
// Temp dirs under process.cwd() (never /tmp); cleaned up after each test.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
	ZAI_HEAVY_CAP,
	PROGRESS_TTL_MS,
	isZaiHeavy,
	activeEntries,
	countActiveZaiHeavy,
	parseUntilMs,
	cooldownVerdict,
	mergeCooldown,
	combineVerdicts,
	admissionVerdict,
	dispatchVerdict,
	buildDegradationPlan,
	suggestLocalRoute,
	readProgressEntries,
	getCooldownFact,
	setCooldownFact,
	clearCooldownFact,
	type Verdict,
} from "../hooks/bin/admission.ts";
import type { QuotaVerdict } from "../hooks/bin/quota-window.ts";

const NOW = 1_790_000_000_000;

function quotaStub(code: 0 | 1 | 2, expiryInMin: number | null): QuotaVerdict {
	return {
		code,
		expiry: expiryInMin === null ? null : NOW + expiryInMin * 60_000,
		leftMin: expiryInMin,
		lines: [`quota stub code=${code}`],
	};
}

let tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
});

function tmpDir(): string {
	const d = mkdtempSync("admission-test-");
	tmpDirs.push(d);
	return d;
}

describe("z.ai-heavy signal", () => {
	test("matches z.ai / zai tokens in id or label", () => {
		expect(
			isZaiHeavy({ id: "x", label: "degradation-lane: z.ai-heavy reasoning" }),
		).toBe(true);
		expect(isZaiHeavy({ id: "zai-lane-1", label: "" })).toBe(true);
		expect(isZaiHeavy({ id: "x", label: "reasoning on z.ai glm-5.3" })).toBe(
			true,
		);
	});
	test("does not match unrelated labels", () => {
		expect(
			isZaiHeavy({ id: "wave-work", label: "work-lane: reading work.ts" }),
		).toBe(false);
		expect(isZaiHeavy({ id: "degradation", label: "unrelated" })).toBe(false);
	});
	test("countActiveZaiHeavy honors TTL", () => {
		const entries = [
			{ id: "a", at: NOW, done: 0, total: 3, label: "z.ai-heavy" },
			{
				id: "b",
				at: NOW - PROGRESS_TTL_MS - 1,
				done: 0,
				total: 3,
				label: "z.ai-heavy",
			},
			{ id: "c", at: NOW, done: 0, total: 3, label: "local work" },
		];
		expect(countActiveZaiHeavy(entries, NOW)).toBe(1);
		expect(countActiveZaiHeavy(entries, NOW, PROGRESS_TTL_MS)).toBe(1);
	});
});

describe("cooldown math", () => {
	test("active before until, inactive at/after", () => {
		expect(cooldownVerdict(String(NOW + 60_000), NOW)).toEqual({
			active: true,
			untilMs: NOW + 60_000,
			remainingSec: 60,
		});
		expect(cooldownVerdict(String(NOW + 60_000), NOW + 60_000)).toEqual({
			active: false,
			untilMs: NOW + 60_000,
			remainingSec: 0,
		});
		expect(cooldownVerdict(String(NOW + 60_000), NOW + 60_001)).toEqual({
			active: false,
			untilMs: NOW + 60_000,
			remainingSec: 0,
		});
	});
	test("null/garbage value → inactive", () => {
		expect(cooldownVerdict(null, NOW).active).toBe(false);
		expect(cooldownVerdict("not-a-date", NOW).active).toBe(false);
	});
	test("parseUntilMs: ms, s, iso, garbage", () => {
		expect(parseUntilMs("1790000060000")).toBe(1790000060000);
		expect(parseUntilMs("1790000060")).toBe(1790000060000);
		expect(parseUntilMs("2026-09-25T00:00:00Z")).toBe(
			Date.parse("2026-09-25T00:00:00Z"),
		);
		expect(Number.isNaN(parseUntilMs("junk"))).toBe(true);
	});
	test("mergeCooldown is extend-only", () => {
		expect(mergeCooldown(NOW + 999_000, NOW + 100_000, NOW)).toBe(
			NOW + 999_000,
		);
		expect(mergeCooldown(NOW + 100_000, NOW + 998_000, NOW)).toBe(
			NOW + 998_000,
		);
		expect(mergeCooldown(NOW - 1000, NOW + 100_000, NOW)).toBe(NOW + 100_000);
		expect(mergeCooldown(null, NOW + 100_000, NOW)).toBe(NOW + 100_000);
	});
});

describe("exit-code mapping", () => {
	test("combineVerdicts: deny(1) > unknown(2) > allow(0)", () => {
		for (const q of [0, 1, 2]) {
			for (const a of [0, 1, 2]) {
				const want: 0 | 1 | 2 =
					q === 1 || a === 1 ? 1 : q === 2 || a === 2 ? 2 : 0;
				expect(combineVerdicts(q, a)).toBe(want);
				expect(combineVerdicts(a, q)).toBe(want);
			}
		}
	});
});

describe("admissionVerdict (W2)", () => {
	const entry = (id: string, label: string, ageMs = 0) => ({
		id,
		at: NOW - ageMs,
		done: 0,
		total: 3,
		label,
	});
	test("allow below cap with no cooldown", () => {
		const v = admissionVerdict({
			nowMs: NOW,
			cooldownValue: null,
			entries: [entry("a", "z.ai-heavy")],
		});
		expect(v.exit).toBe(0);
		expect(v.lines.join(" ")).toMatch(/ALLOW/);
	});
	test("deny at cap with retry-after until oldest goes stale", () => {
		const entries = [
			entry("a", "z.ai-heavy", 0),
			entry("b", "zai lane", 60_000),
			entry("c", "z.ai", 120_000),
		];
		const v = admissionVerdict({ nowMs: NOW, cooldownValue: null, entries });
		expect(v.exit).toBe(1);
		expect(v.retryAfterSec).toBe(
			Math.ceil((NOW - 120_000 + PROGRESS_TTL_MS - NOW) / 1000),
		);
		expect(v.lines.join(" ")).toMatch(/cap 3\/3/);
	});
	test("deny during shared cooldown with remaining time as retry-after", () => {
		const v = admissionVerdict({
			nowMs: NOW,
			cooldownValue: String(NOW + 45_000),
			entries: [],
		});
		expect(v.exit).toBe(1);
		expect(v.retryAfterSec).toBe(45);
		expect(v.lines.join(" ")).toMatch(/cooldown active until/);
	});
	test("dbError → exit 2 unknown (fail-open-ish)", () => {
		const v = admissionVerdict({
			nowMs: NOW,
			cooldownValue: null,
			dbError: true,
			entries: [],
		});
		expect(v.exit).toBe(2);
	});
	test("stale heavies do not count toward cap", () => {
		const entries = [entry("a", "z.ai-heavy", PROGRESS_TTL_MS + 1)];
		const v = admissionVerdict({ nowMs: NOW, cooldownValue: null, entries });
		expect(v.exit).toBe(0);
		expect(v.lines.join(" ")).toMatch(/0\/3/);
	});
});

describe("dispatchVerdict (W21, quota stubbed)", () => {
	const allow: Verdict = { exit: 0, lines: ["admission: ALLOW — test"] };
	const deny: Verdict = { exit: 1, lines: ["admission: DENY — test"] };
	test("near-cliff quota + allow → exit 1 with reset time + local suggestion", () => {
		const dv = dispatchVerdict(quotaStub(1, 20), allow);
		expect(dv.exit).toBe(1);
		const text = dv.lines.join("\n");
		expect(text).toContain("predicted reset");
		expect(text).toContain(new Date(NOW + 20 * 60_000).toISOString());
		expect(text).toContain("8901");
		expect(text).toContain("8903");
	});
	test("unknown quota + allow → exit 2", () => {
		expect(dispatchVerdict(quotaStub(2, null), allow).exit).toBe(2);
	});
	test("safe quota + admission deny → exit 1", () => {
		expect(dispatchVerdict(quotaStub(0, 120), deny).exit).toBe(1);
	});
	test("safe + allow → exit 0", () => {
		expect(dispatchVerdict(quotaStub(0, 120), allow).exit).toBe(0);
	});
});

describe("buildDegradationPlan (W22)", () => {
	const entries = [
		{
			id: "heavy-1",
			at: NOW,
			done: 1,
			total: 3,
			label: "z.ai-heavy reasoning",
		},
		{
			id: "local-lane",
			at: NOW,
			done: 0,
			total: 3,
			label: "code impl and refactor",
		},
	];
	test("near-cliff: heavy queued, local keeps running", () => {
		const plan = buildDegradationPlan(quotaStub(1, 30), entries, NOW);
		expect(plan.verdict).toBe("near-cliff");
		expect(plan.degraded).toBe(true);
		expect(plan.resetAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
		expect(plan.queuedBehindReset.map((q) => q.id)).toEqual(["heavy-1"]);
		expect(plan.queuedBehindReset[0].retryAfterMinutes).toBe(30);
		expect(plan.keepOnLocal.map((k) => k.id)).toEqual(["local-lane"]);
	});
});

describe("buildDegradationPlan blackout + route table", () => {
	test("blackout (quota unknown): resetAt null, retryAfter null, keep-on-local populated", () => {
		const plan = buildDegradationPlan(
			quotaStub(2, null),
			[
				{ id: "h", at: NOW, done: 0, total: 1, label: "z.ai" },
				{ id: "l", at: NOW, done: 0, total: 1, label: "review plan" },
			],
			NOW,
		);
		expect(plan.verdict).toBe("blackout");
		expect(plan.resetAt).toBe(null);
		expect(plan.queuedBehindReset[0].retryAfterMinutes).toBe(null);
		expect(plan.keepOnLocal[0].route).toContain("8903");
	});
	test("safe: nothing degraded", () => {
		const plan = buildDegradationPlan(
			quotaStub(0, 120),
			[{ id: "h", at: NOW, done: 0, total: 1, label: "z.ai" }],
			NOW,
		);
		expect(plan.verdict).toBe("safe");
		expect(plan.degraded).toBe(false);
		expect(plan.keepOnLocal).toEqual([]);
		expect(plan.queuedBehindReset).toEqual([]);
	});
	test("suggestLocalRoute keyword mapping (llm-routing.md)", () => {
		expect(suggestLocalRoute("danish translation").endpoint).toContain("4000");
		expect(suggestLocalRoute("design review").endpoint).toContain("8903");
		expect(suggestLocalRoute("code impl").endpoint).toContain("8901");
		expect(suggestLocalRoute("").endpoint).toContain("8902");
	});
});

describe("file seam (temp dir under cwd)", () => {
	test("readProgressEntries parses valid, skips garbage, missing dir → []", () => {
		const dir = `${tmpDir()}/progress`;
		mkdirSync(dir);
		writeFileSync(
			`${dir}/a.json`,
			JSON.stringify({ at: NOW, done: 1, total: 3, label: "z.ai-heavy lane" }),
		);
		writeFileSync(
			`${dir}/b.json`,
			JSON.stringify({
				at: NOW - PROGRESS_TTL_MS - 1000,
				done: 1,
				total: 3,
				label: "z.ai",
			}),
		);
		writeFileSync(`${dir}/c.json`, "not json{");
		const parsed = readProgressEntries(dir);
		expect(parsed).toHaveLength(2);
		expect(countActiveZaiHeavy(parsed, NOW)).toBe(1); // b.json is TTL-expired
		expect(readProgressEntries(`${tmpDir()}/does-not-exist`)).toEqual([]);
	});
});

describe("cooldown fact DB roundtrip (temp sqlite under cwd)", () => {
	test("set → get → extend-only merge → clear", () => {
		const dbPath = `${tmpDir()}/gov.db`;
		new Database(dbPath).exec(
			"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
		);
		expect(getCooldownFact(dbPath)).toBe(null);
		setCooldownFact(dbPath, NOW + 60_000, "test");
		expect(getCooldownFact(dbPath)).toBe(String(NOW + 60_000));
		setCooldownFact(dbPath, NOW + 30_000, "test");
		expect(getCooldownFact(dbPath)).toBe(String(NOW + 30_000)); // raw upsert; extend-only decided by mergeCooldown in CLI
		setCooldownFact(dbPath, NOW + 120_000, "test");
		expect(getCooldownFact(dbPath)).toBe(String(NOW + 120_000));
		clearCooldownFact(dbPath);
		expect(getCooldownFact(dbPath)).toBe(null);
	});
	test("getCooldownFact throws on db without facts table (CLI maps to unknown)", () => {
		const dbPath = `${tmpDir()}/empty.db`;
		new Database(dbPath).exec("CREATE TABLE other (x INTEGER)");
		expect(() => getCooldownFact(dbPath)).toThrow();
	});
});
