// test/review-model-select.e2e.ts — W2948: the review model choice.
// The 2026-11-10 specimen deferred dozens of DONE branches with "review
// unavailable: configure SUSPENDERS_REVIEW_MODEL or restore original lane
// model fact" — no env knob on the launchd loop, no conf primary, only a
// fallback ladder. These seams pin: conf primary, env precedence, safe
// ladder selection when the author's lane fact is gone, the protected-family
// full-class guard, and the operator-facing diagnosis when nothing is set.

import { expect, test } from "@playwright/test";
import { openMemoryStore } from "../hooks/lib/govdb/govdb-store.ts";
import { selectReviewModel } from "../hooks/lib/gates/review-model-select.ts";
import { scheduleReview } from "../hooks/lib/gates/review-scheduler.ts";

const LADDER = "glm-5.3-flash,glm-5.3,local-coder";

test("selector: env wins over lane fact, conf and ladder", () => {
	const c = selectReviewModel({
		env: { SUSPENDERS_REVIEW_MODEL: "env-model" },
		pin: "pin-model",
		confModel: "conf-model",
		fallbackModels: LADDER,
		protectedItem: false,
	});
	expect(c.model).toBe("env-model");
	expect(c.source).toBe("env");
});

test("selector: lane fact wins over the conf primary", () => {
	const c = selectReviewModel({
		env: {},
		pin: "pin-model",
		confModel: "conf-model",
		protectedItem: false,
	});
	expect(c.model).toBe("pin-model");
	expect(c.source).toBe("lane-fact");
});

test("selector: conf primary covers an absent lane fact", () => {
	const c = selectReviewModel({
		env: {},
		confModel: "conf-model",
		fallbackModels: LADDER,
		protectedItem: false,
	});
	expect(c.model).toBe("conf-model");
	expect(c.source).toBe("conf");
	expect(c.diagnosis).toContain("fleet_loop.review_model");
});

test("selector: no primary falls back to the first configured rung", () => {
	const c = selectReviewModel({
		env: {},
		fallbackModels: LADDER,
		protectedItem: false,
	});
	expect(c.model).toBe("glm-5.3-flash");
	expect(c.source).toBe("conf-fallback-list");
});

test("selector: a protected item skips non-full-class rungs", () => {
	const c = selectReviewModel({
		env: {},
		fallbackModels: LADDER,
		protectedItem: true,
	});
	expect(c.model).toBe("glm-5.3");
	expect(c.source).toBe("conf-fallback-list");
});

test("selector: protected with a flash-only ladder refuses, never demotes", () => {
	const c = selectReviewModel({
		env: {},
		fallbackModels: "glm-5.3-flash,local-coder",
		protectedItem: true,
	});
	expect(c.model).toBeUndefined();
	expect(c.diagnosis).toContain("protected-family review refused");
});

test("selector: nothing configured names every source it checked", () => {
	const c = selectReviewModel({ env: {}, protectedItem: false });
	expect(c.model).toBeUndefined();
	expect(c.diagnosis).toContain("SUSPENDERS_REVIEW_MODEL unset");
	expect(c.diagnosis).toContain("lane model fact absent");
	expect(c.diagnosis).toContain("fleet_loop.review_model unset");
});

function schedulerFixture() {
	const db = openMemoryStore();
	for (const ddl of [
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
		"CREATE TABLE work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)",
	])
		db.run(ddl);
	const context = {
		commit: "a".repeat(40),
		base: "b".repeat(40),
		instructions: {},
		text: "",
	};
	db.query(
		"INSERT INTO work_completion_records VALUES ('fixture','W1',?,'author')",
	).run(context.commit);
	const launches: string[][] = [];
	return {
		launches,
		options: {
			db,
			project: "fixture",
			item: "W1",
			repo: ".",
			context,
			env: { SUSPENDERS_MODEL_HEALTH: "0" },
			spawn: (args: string[]) => {
				launches.push(args);
			},
		},
	};
}

test("scheduleReview: a missing author model fact schedules on the conf primary", () => {
	const f = schedulerFixture();
	const out = scheduleReview({
		...f.options,
		settings: () => ({
			laneTarget: 6,
			dispatchTarget: 8,
			everyS: 120,
			pollS: 10,
			reviewModel: "conf-model",
			reviewFallbackModels: LADDER,
		}),
	});
	expect(out).toContain("requested through Buckle (conf-model) via conf");
	expect(f.launches[0]).toContain("buckle:conf-model");
});

test("scheduleReview: ladder selection covers an absent fact and primary", () => {
	const f = schedulerFixture();
	const out = scheduleReview({
		...f.options,
		settings: () => ({
			laneTarget: 6,
			dispatchTarget: 8,
			everyS: 120,
			pollS: 10,
			reviewFallbackModels: LADDER,
		}),
	});
	expect(out).toContain(
		"requested through Buckle (glm-5.3-flash) via conf-fallback-list",
	);
});

test("scheduleReview: nothing configured refuses with the diagnosis", () => {
	const f = schedulerFixture();
	const out = scheduleReview(f.options);
	expect(out).toContain("review unavailable: no review model configured");
	expect(f.launches).toHaveLength(0);
});
