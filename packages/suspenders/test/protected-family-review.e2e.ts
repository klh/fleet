// test/protected-family-review.e2e.ts — W2571: the protected design family
// (the glm53-only tag, inherited down the parent chain) is pinned
// full-5.3-only in the review path: the scheduler skips the model-health
// repin, refuses a non-full-class pin loudly, and strips the fallback
// ladder + stepdown from the spawn; the strict wire assertion grades a
// served-vs-requested mismatch ERROR for every verdict. No global model
// change: untagged items keep the W2194 repin + W1313/W2344 ladders.
import { expect, test } from "@playwright/test";
import {
	PROTECTED_FAMILY_TAG,
	PROTECTED_REVIEW_CLASS,
	protectedFamily,
	protectedFamilyRefusal,
	protectedWireMismatch,
} from "../hooks/lib/gates/protected-family.ts";
import {
	reviewRequestKey,
	scheduleReview,
} from "../hooks/lib/gates/review-scheduler.ts";
import { openMemoryStore } from "../hooks/lib/govdb/govdb-store.ts";

// ── detection ───────────────────────────────────────────────────────────────
test("protectedFamily: item tag, ancestor tag, untagged, missing item", () => {
	const db = openMemoryStore();
	db.run(
		"CREATE TABLE work_items(project TEXT, id TEXT, tags TEXT, parent_id TEXT)",
	);
	const ins = db.query(
		"INSERT INTO work_items(project,id,tags,parent_id) VALUES (?,?,?,?)",
	);
	ins.run("fixture", "W1", "fleet,glm53-only", null);
	ins.run("fixture", "W1.1", "fleet", "W1");
	ins.run("fixture", "W2", "fleet", null);
	expect(protectedFamily(db, "fixture", "W1")).toBe(true);
	expect(protectedFamily(db, "fixture", "W1.1")).toBe(true);
	expect(protectedFamily(db, "fixture", "W2")).toBe(false);
	expect(protectedFamily(db, "fixture", "W404")).toBe(false);
	expect(PROTECTED_FAMILY_TAG).toBe("glm53-only");
});

// ── scheduler: pin-only spawn, loud refusal, repin skip ─────────────────────
test("scheduleReview: protected item strips fallback rows from the spawn env + args", () => {
	const f = familyFixture("W1", "fleet,glm53-only");
	expect(
		scheduleReview({
			...f.options,
			settings: () => ({
				reviewFallbackModels: "glm-5.3-flash,conf-b",
				reviewStepdownClasses: "sql",
			}),
		}),
	).toContain("requested through Buckle (glm-5.3)");
	expect(f.envs[0]?.SUSPENDERS_REVIEW_FALLBACK_MODELS).toBeUndefined();
	expect(f.envs[0]?.SUSPENDERS_REVIEW_STEPDOWN_CLASSES).toBeUndefined();
	expect(f.launches[0]?.join(" ")).not.toContain("--fallback-models");
});

test("scheduleReview: protected item skips the model-health repin (pin stands)", () => {
	const f = familyFixture("W1", "fleet,glm53-only");
	// the sweep has spoken: full-5.3 DOWN fresh, flash UP fresh — the W2194
	// repin would swap to flash here; the protected pin must stand.
	bankHealth(f.db, [
		["glm-5-3", "down"],
		["glm-5-3-flash", "up"],
	]);
	expect(
		scheduleReview({
			...f.options,
			env: { SUSPENDERS_REVIEW_MODEL: "glm-5.3" },
		}),
	).toContain("requested through Buckle (glm-5.3)");
	expect(f.launches[0]?.join(" ")).not.toContain("glm-5.3-flash");
});

test("scheduleReview: protected item with a flash pin refuses LOUDLY, no spawn", () => {
	const f = familyFixture("flash-pin", "fleet,glm53-only");
	const out = scheduleReview({
		...f.options,
		env: { SUSPENDERS_REVIEW_MODEL: "glm-5.3-flash" },
	});
	expect(out).toContain("protected-family review refused");
	expect(out).toContain("glm-5.3-flash");
	expect(f.launches).toHaveLength(0);
});

test("scheduleReview: untagged items keep the W2194 repin + fallback ladder", () => {
	const f = familyFixture("untagged", "fleet");
	bankHealth(f.db, [
		["glm-5-3", "down"],
		["glm-5-3-flash", "up"],
	]);
	expect(
		scheduleReview({
			...f.options,
			env: { SUSPENDERS_REVIEW_MODEL: "glm-5.3" },
		}),
	).toContain("re-pinned from glm-5.3");
});

test("protectedFamilyRefusal names the class and the escape", () => {
	expect(protectedFamilyRefusal("glm-5.3-flash")).toContain("glm-5.3-flash");
	expect(protectedFamilyRefusal("glm-5.3-flash")).toContain(
		PROTECTED_REVIEW_CLASS,
	);
});

// ── the strict wire assertion ───────────────────────────────────────────────
test("protectedWireMismatch: mismatch is fatal for every verdict on family items", () => {
	expect(
		protectedWireMismatch({
			match: "mismatch",
			verdict: "PASS",
			family: false,
		}),
	).toBe(true);
	expect(
		protectedWireMismatch({ match: "mismatch", verdict: "FAIL", family: true }),
	).toBe(true);
	expect(
		protectedWireMismatch({
			match: "mismatch",
			verdict: "FAIL",
			family: false,
		}),
	).toBe(false);
	expect(
		protectedWireMismatch({ match: "match", verdict: "PASS", family: true }),
	).toBe(false);
});

/** The fixture db: facts + completion records + one tagged work item. */
function familyDb(item: string, tags: string) {
	const db = openMemoryStore();
	for (const ddl of [
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
		"CREATE TABLE work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)",
		"CREATE TABLE work_items(project TEXT, id TEXT, tags TEXT, parent_id TEXT)",
	])
		db.run(ddl);
	db.query(
		"INSERT INTO work_items(project,id,tags,parent_id) VALUES (?,?,?,NULL)",
	).run("fixture", item, tags);
	db.query(
		"INSERT INTO work_completion_records VALUES ('fixture',?,?,'author')",
	).run(item, "a".repeat(40));
	const context = {
		commit: "a".repeat(40),
		base: "b".repeat(40),
		instructions: {},
		text: "",
	};
	return { db, context };
}

function familyFixture(item: string, tags: string) {
	const { db, context } = familyDb(item, tags);
	const launches: string[][] = [];
	const envs: NodeJS.ProcessEnv[] = [];
	const options = {
		db,
		project: "fixture",
		item,
		repo: ".",
		context,
		env: { SUSPENDERS_REVIEW_MODEL: "glm-5.3" },
		spawn: (args: string[], env: NodeJS.ProcessEnv) => {
			launches.push(args);
			envs.push(env);
		},
	};
	return {
		db,
		options,
		launches,
		envs,
		key: reviewRequestKey("fixture", item, context),
	};
}

/** Bank fresh model.health facts (core, status) into the fixture facts table. */
function bankHealth(
	db: ReturnType<typeof openMemoryStore>,
	rows: [core: string, status: "up" | "down"][],
) {
	const ins = db.query(
		"INSERT OR REPLACE INTO facts(key,value,source,version,ts) VALUES (?,?, 'model-health',1,?)",
	);
	for (const [core, status] of rows)
		ins.run(
			`model.health.${core}`,
			JSON.stringify({
				status,
				latencyMs: 12,
				servedModel: core.replaceAll("-", "."),
				ts: Date.now(),
				hub: "fixture",
				wireId: core.replaceAll("-", "."),
				reason: null,
			}),
			Date.now(),
		);
}
