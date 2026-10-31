// test/review-conf-seam.e2e.ts — W2351: the reviewer env rows are
// conf-sourced. The machine conf's fleet_loop block carries the reviewer
// ladder + stepdown classes durably; the env vars stay the override; the
// loop's config watcher hot-applies edits (no launchd reload). One spec,
// three seams: the resolver, the watcher, the scheduler spawn env.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopConfigWatch } from "../hooks/lib/fleet-loop/loop-config-watch.ts";
import {
	reviewRequestKey,
	reviewSpawnEnv,
	scheduleReview,
} from "../hooks/lib/gates/review-scheduler.ts";
import { openMemoryStore } from "../hooks/lib/govdb/govdb-store.ts";
import {
	FLEET_LOOP_DEFAULTS,
	fleetLoopSettings,
} from "../hooks/lib/stack-config.ts";

const tmpConf = (): string => mkdtempSync(join(tmpdir(), "w2351-stack-"));

// ── seam 1: the resolver ────────────────────────────────────────────────────
test("fleetLoopSettings: reviewer rows resolve from the block, absent = undefined", () => {
	expect(fleetLoopSettings(null)).toEqual(FLEET_LOOP_DEFAULTS);
	expect(fleetLoopSettings(null).reviewFallbackModels).toBeUndefined();
	expect(fleetLoopSettings(null).reviewStepdownClasses).toBeUndefined();
	const s = fleetLoopSettings({
		hubs: {},
		fleet_loop: {
			lane_target: 20,
			review_fallback_models: "glm-5.3-flash,glm-4.5-air,local-coder",
			review_stepdown_classes: "sql",
		},
	});
	expect(s.reviewFallbackModels).toBe("glm-5.3-flash,glm-4.5-air,local-coder");
	expect(s.reviewStepdownClasses).toBe("sql");
	// the four numbers ride unchanged beside the new rows
	expect(s.laneTarget).toBe(20);
});

// ── seam 2: the spawn-env layering ──────────────────────────────────────────
test("reviewSpawnEnv: env rows win, conf fills unset, empty env row is a kill switch", () => {
	const conf = {
		reviewFallbackModels: "conf-a,conf-b",
		reviewStepdownClasses: "sql",
	};
	// conf fills where the env is unset
	expect(reviewSpawnEnv({}, conf)).toEqual({
		SUSPENDERS_REVIEW_FALLBACK_MODELS: "conf-a,conf-b",
		SUSPENDERS_REVIEW_STEPDOWN_CLASSES: "sql",
	});
	// env rows stay the override — conf never touches a set key
	expect(
		reviewSpawnEnv(
			{
				SUSPENDERS_REVIEW_FALLBACK_MODELS: "env-a",
				SUSPENDERS_REVIEW_STEPDOWN_CLASSES: "",
			},
			conf,
		),
	).toEqual({
		SUSPENDERS_REVIEW_FALLBACK_MODELS: "env-a",
		// an explicitly EMPTY env row counts as set (the kill switch)
		SUSPENDERS_REVIEW_STEPDOWN_CLASSES: "",
	});
	// no conf = env-only, byte-identical to the pre-W2351 spawn
	expect(reviewSpawnEnv({ A: "1" }, undefined)).toEqual({ A: "1" });
	// the base env never mutates
	const base: NodeJS.ProcessEnv = {};
	reviewSpawnEnv(base, conf);
	expect(base).toEqual({});
});

// ── seam 3: the watcher hot-apply ───────────────────────────────────────────
test("config edit → watcher hot-applies the reviewer rows within the poll interval", async () => {
	const conf = join(tmpConf(), "stack.json");
	writeFileSync(conf, JSON.stringify({ fleet_loop: { lane_target: 6 } }));
	const lines: string[] = [];
	const w = createLoopConfigWatch({
		path: conf,
		intervalMs: 50,
		log: (l) => lines.push(l),
	});
	try {
		expect(w.settings().reviewFallbackModels).toBeUndefined();
		const ladder = "glm-5.3-flash,glm-4.5-air,local-coder";
		writeFileSync(
			conf,
			JSON.stringify({
				fleet_loop: { lane_target: 6, review_fallback_models: ladder },
			}),
		);
		await pollFor(() => w.settings().reviewFallbackModels !== undefined);
		expect(w.settings().reviewFallbackModels).toBe(ladder);
		// the hot-apply line names the row (unset renders `-`)
		expect(
			lines.some((l) => l.includes(`review_fallback_models=${ladder}`)),
		).toBe(true);
	} finally {
		w.stop();
	}
});

// ── seam 4: the scheduler spawn ─────────────────────────────────────────────
test("scheduleReview: conf reviewer rows ride the spawn env", () => {
	const f = reviewFixture();
	const conf = {
		reviewFallbackModels: "conf-a,conf-b",
		reviewStepdownClasses: "sql",
	};
	// conf rows land in the child env (and the --fallback-models arg)
	expect(scheduleReview({ ...f.options, settings: () => conf })).toContain(
		"requested through Buckle",
	);
	expect(f.envs[0]?.SUSPENDERS_REVIEW_FALLBACK_MODELS).toBe("conf-a,conf-b");
	expect(f.envs[0]?.SUSPENDERS_REVIEW_STEPDOWN_CLASSES).toBe("sql");
	expect(f.launches[0]).toContain("conf-a,conf-b");
});

test("scheduleReview: explicit env rows stay the override over conf", () => {
	const f = reviewFixture();
	expect(
		scheduleReview({
			...f.options,
			env: {
				...f.options.env,
				SUSPENDERS_REVIEW_FALLBACK_MODELS: "env-a,env-b",
			},
			settings: () => ({ reviewFallbackModels: "conf-a,conf-b" }),
		}),
	).toContain("requested through Buckle");
	expect(f.envs[0]?.SUSPENDERS_REVIEW_FALLBACK_MODELS).toBe("env-a,env-b");
	expect(f.envs[0]?.SUSPENDERS_REVIEW_STEPDOWN_CLASSES).toBeUndefined();
});

test("scheduleReview: no settings = env-only spawn (pre-W2351 shape)", () => {
	const f = reviewFixture();
	expect(scheduleReview(f.options)).toContain("requested through Buckle");
	expect(f.envs[0]?.SUSPENDERS_REVIEW_FALLBACK_MODELS).toBeUndefined();
});

// ---- the scheduler fixture (facts + completion record + spawn capture) -----

function reviewDb() {
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
		"INSERT INTO work_completion_records VALUES ('fixture',?,?,'author')",
	).run("W1", context.commit);
	return { db, context };
}

function reviewFixture() {
	const { db, context } = reviewDb();
	const launches: string[][] = [];
	const envs: NodeJS.ProcessEnv[] = [];
	const options = {
		db,
		project: "fixture",
		item: "W1",
		repo: ".",
		context,
		env: {
			SUSPENDERS_REVIEW_MODEL: "fixture-model",
			SUSPENDERS_MODEL_HEALTH: "0",
		},
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
		key: reviewRequestKey("fixture", "W1", context),
	};
}

/** Bounded async poll (the W2242 watcher spec's deadline pattern). */
async function pollFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond() && Date.now() < deadline) await Bun.sleep(25);
	if (!cond()) throw new Error("pollFor: condition never met");
}
