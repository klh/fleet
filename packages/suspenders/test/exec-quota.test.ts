// test/exec-quota.test.ts — W374: the per-provider quota measure the
// executor pick reads (exec-quota.ts) and the DEFAULT-ladder reorder it
// drives (exec-chain.ts). Positive-evidence-only demotion: no evidence
// never demotes.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPick } from "../scripts/lib/exec-chain.ts";
import {
	providerOf,
	quotaProviderPenalty,
	zaiPrefixes,
} from "../hooks/lib/exec-quota.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const HOME = mkdtempSync(join(tmpdir(), "w374-quota-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w374-quota-repo-"));
mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

const settingsFile = join(HOME, ".claude", "local-llm", "suspenders-board.json");
const pick = (
	attempt: number,
	de: string[],
	quota?: Map<string, string>,
	cv?: Map<string, number>,
) => {
	writeFileSync(settingsFile, JSON.stringify({ default_executors: de }));
	return execPick(attempt, REPO, cv, quota);
};

afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const dbs: Database[] = [];
const store = (): GovernorStore => {
	const db = new Database(":memory:");
	dbs.push(db);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER DEFAULT 1, ts INTEGER)",
	);
	return db as unknown as GovernorStore;
};
const setFact = (db: GovernorStore, key: string, value: string): void => {
	db.run(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'test', 1, 0)",
		[key, value],
	);
};

describe("W374 class → provider mapping (providerOf)", () => {
	test("spawnable executors ride their adapter id (registry data)", () => {
		expect(providerOf("copilot")).toBe("copilot");
		expect(providerOf("codex")).toBe("codex");
	});

	test("glm/zai model pins ride zai; non-zai pins ride nothing", () => {
		expect(providerOf("glm-5.3-flash")).toBe("zai");
		expect(providerOf("GLM-Flash")).toBe("zai");
		expect(providerOf("zai-org/x")).toBe("zai");
		expect(providerOf("claude")).toBe("claude");
		expect(providerOf("kimi-k2")).toBe(null);
	});

	test("machine env extends the zai prefixes (config-over-code)", () => {
		process.env.SUSPENDERS_QUOTA_ZAI_CLASSES = "kimi";
		try {
			expect(zaiPrefixes()).toContain("kimi");
			expect(providerOf("kimi-k2")).toBe("zai");
		} finally {
			delete process.env.SUSPENDERS_QUOTA_ZAI_CLASSES;
		}
	});
});

describe("W374 quotaProviderPenalty — positive evidence only", () => {
	test("no facts + no window state = no demotion (unknown ≠ exhausted)", () => {
		expect(quotaProviderPenalty(store(), { now: 1_000_000 }).size).toBe(0);
	});

	test("future zai.cooldown.until demotes zai; past does not", () => {
		const db = store();
		setFact(db, "zai.cooldown.until", String(2_000_000));
		expect(
			quotaProviderPenalty(db, { now: 1_000_000 }).get("zai"),
		).toContain("cooldown until");
		const past = store();
		setFact(past, "zai.cooldown.until", String(500_000));
		expect(
			quotaProviderPenalty(past, { now: 1_000_000 }).has("zai"),
		).toBe(false);
	});

	test("near-cliff window state demotes zai; a far expiry does not", () => {
		const cache = join(HOME, ".cache", "claude-governor");
		mkdirSync(cache, { recursive: true });
		const writeState = (resets: number[]): void => {
			writeFileSync(
				join(cache, "quota-window.json"),
				JSON.stringify({ resets }),
			);
		};
		writeState([1_000_000 + 10 * 60_000]); // 10 min left < 45-min margin
		expect(
			quotaProviderPenalty(store(), { now: 1_000_000 }).get("zai"),
		).toContain("near cliff");
		writeState([1_000_000 + 3 * 3600_000]); // 3h left — healthy window
		expect(
			quotaProviderPenalty(store(), { now: 1_000_000 }).has("zai"),
		).toBe(false);
	});

	test("copilot headroom WARN demotes copilot only while fresh", () => {
		const db = store();
		const now = 10 * 24 * 3600_000;
		const warn = (at: number, arms: string[]): void => {
			setFact(
				db,
				"copilot.credits.headroom",
				JSON.stringify({ verdict: "WARN", arms, at }),
			);
		};
		warn(now - 3600_000, ["need"]);
		expect(quotaProviderPenalty(db, { now }).get("copilot")).toContain(
			"credit headroom WARN",
		);
		warn(now - 25 * 3600_000, ["need"]); // stale — history, not exhaustion
		expect(quotaProviderPenalty(db, { now }).has("copilot")).toBe(false);
		warn(now - 3600_000, []); // WARN with no arms = budget not threatened
		expect(quotaProviderPenalty(db, { now }).has("copilot")).toBe(false);
	});

	test("corrupt headroom fact = no evidence, never a crash", () => {
		const db = store();
		setFact(db, "copilot.credits.headroom", "{not json");
		expect(quotaProviderPenalty(db, { now: 1_000_000 }).size).toBe(0);
	});
});

describe("W374 execPick routes the DEFAULT ladder around exhaustion", () => {
	test("demoted head: claude picked over exhausted glm", () => {
		const p = pick(
			0,
			["glm-5.3-flash", "claude"],
			new Map([["zai", "cooldown"]]),
		);
		expect(p.name).toBe("claude");
		expect(p.chainIdx).toBe(0);
		expect(p.chainLen).toBe(2);
	});

	test("quota outranks the cv tally (health gates usability)", () => {
		const p = pick(
			0,
			["glm-5.3-flash", "claude"],
			new Map([["zai", "cooldown"]]),
			new Map([["glm-5.3-flash", 9]]),
		);
		expect(p.name).toBe("claude");
	});

	test("no quota map = order preserved (cv-only behavior unchanged)", () => {
		expect(pick(0, ["glm-5.3-flash", "claude"]).name).toBe("glm-5.3-flash");
	});

	test("attempt walk still reaches the demoted slot", () => {
		const p = pick(
			1,
			["glm-5.3-flash", "claude"],
			new Map([["zai", "cooldown"]]),
		);
		expect(p.name).toBe("glm-5.3-flash");
		expect(p.chainIdx).toBe(1);
	});

	test(".prefer MUST chain is never rerouted (W228) — surfaced, not moved", () => {
		writeFileSync(join(REPO, ".prefer"), "must=glm-5.3-flash\n");
		const p = execPick(0, REPO, undefined, new Map([["zai", "cooldown"]]));
		expect(p.name).toBe("glm-5.3-flash");
		rmSync(join(REPO, ".prefer"));
	});
});



