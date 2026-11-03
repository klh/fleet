// test/review-conf-seam.e2e.ts — W2351: the reviewer env rows are
// conf-sourced. The machine conf's fleet_loop block carries the reviewer
// ladder + stepdown classes durably; the env vars stay the override; the
// loop's config watcher hot-applies edits (no launchd reload). W2405 adds
// the leg cap rows (review_leg_timeout_ms / review_leg_max_tokens) through
// every seam down to the request body itself. Seams: the resolver, the
// watcher, the scheduler spawn env, the request body, the uncapped fetch.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createLoopConfigWatch } from "../hooks/lib/fleet-loop/loop-config-watch.ts";
import { requestReviewLeg } from "../hooks/lib/gates/review-prompt.ts";
import { reviewRoundCap } from "../hooks/lib/gates/review-round-cap.ts";
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
	// W2470: the round-cap row resolves beside the reviewer rows
	expect(
		fleetLoopSettings({
			hubs: {},
			fleet_loop: { review_round_cap: 5 },
		}).reviewRoundCap,
	).toBe(5);
	expect(fleetLoopSettings(null).reviewRoundCap).toBeUndefined();
	// the four numbers ride unchanged beside the new rows
	expect(s.laneTarget).toBe(20);
});

// ── seam 1c: the settings.json projection (W2642) ───────────────────────────
test("stackFromSettings: review_round_cap survives the StackConfig projection", () => {
	// the no-arg fleetLoopSettings() path reads the PROJECTED conf
	// (loadStack → stackFromSettings), not the raw settings doc — the
	// projection must carry the row or the scheduler's confCap stays
	// undefined on every settings.json install (the W2470 sibling rows
	// already ride this object; this pins the third).
	const dir = tmpConf();
	const file = join(dir, "settings.json");
	writeFileSync(
		file,
		JSON.stringify({ version: "w2642", fleet_loop: { review_round_cap: 5 } }),
	);
	process.env.KLH_SETTINGS = file;
	try {
		expect(fleetLoopSettings().reviewRoundCap).toBe(5);
	} finally {
		delete process.env.KLH_SETTINGS;
	}
});

// ── seam 1b: the round-cap precedence ───────────────────────────────────────
test("reviewRoundCap: conf row wins (0 disables), env stays the fallback, junk → 3", () => {
	// conf row wins over the env — including 0, the explicit disable
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "9" }, 5)).toBe(5);
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "9" }, 0)).toBe(0);
	// absent conf row = the env fallback (the pre-W2470 behavior)
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "7" })).toBe(7);
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "0" })).toBe(0);
	// neither = the default
	expect(reviewRoundCap({})).toBe(3);
	expect(reviewRoundCap({ SUSPENDERS_REVIEW_ROUND_CAP: "junk" })).toBe(3);
});

// W2405: the leg cap rows — absent = defaults (900s / 16000), 0 = uncapped,
// >0 = explicit. Both resolve beside the W2351 rows.
test("fleetLoopSettings: review_leg cap rows resolve (W2405)", () => {
	const d = fleetLoopSettings(null);
	expect(d.reviewLegTimeoutMs).toBeUndefined();
	expect(d.reviewLegMaxTokens).toBeUndefined();
	// 0 = uncapped semantics ride through as explicit zeros
	const z = fleetLoopSettings({
		hubs: {},
		fleet_loop: { review_leg_timeout_ms: 0, review_leg_max_tokens: 0 },
	});
	expect(z.reviewLegTimeoutMs).toBe(0);
	expect(z.reviewLegMaxTokens).toBe(0);
	// >0 = explicit value
	const e = fleetLoopSettings({
		hubs: {},
		fleet_loop: {
			review_leg_timeout_ms: 300_000,
			review_leg_max_tokens: 65_536,
		},
	});
	expect(e.reviewLegTimeoutMs).toBe(300_000);
	expect(e.reviewLegMaxTokens).toBe(65_536);
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

// W2405: the leg caps ride the same spawn-env layering — conf fills unset,
// env wins, 0 rides through as the string "0" (uncapped is a SET value).
test("reviewSpawnEnv: leg cap rows fill unset env (W2405)", () => {
	const conf = { reviewLegTimeoutMs: 0, reviewLegMaxTokens: 0 };
	expect(reviewSpawnEnv({}, conf)).toEqual({
		SUSPENDERS_REVIEW_LEG_TIMEOUT_MS: "0",
		SUSPENDERS_REVIEW_LEG_MAX_TOKENS: "0",
	});
	// env rows win; the other conf row still fills
	expect(
		reviewSpawnEnv(
			{ SUSPENDERS_REVIEW_LEG_MAX_TOKENS: "32000" },
			{ reviewLegTimeoutMs: 600_000, reviewLegMaxTokens: 0 },
		),
	).toEqual({
		SUSPENDERS_REVIEW_LEG_TIMEOUT_MS: "600000",
		SUSPENDERS_REVIEW_LEG_MAX_TOKENS: "32000",
	});
	// no conf rows = no keys (review-lane falls to its code defaults)
	expect(
		reviewSpawnEnv({}, { reviewFallbackModels: "a" })
			.SUSPENDERS_REVIEW_LEG_TIMEOUT_MS,
	).toBeUndefined();
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
		// W2470: the round-cap row hot-applies the same way
		writeFileSync(
			conf,
			JSON.stringify({ fleet_loop: { review_round_cap: 5 } }),
		);
		await pollFor(() => w.settings().reviewRoundCap === 5);
		// the hot-apply line names the row (unset renders `-`)
		expect(
			lines.some((l) => l.includes(`review_fallback_models=${ladder}`)),
		).toBe(true);
		// W2405: a cap edit hot-applies and the line names the applied values
		writeFileSync(
			conf,
			JSON.stringify({
				fleet_loop: {
					lane_target: 6,
					review_fallback_models: ladder,
					review_leg_timeout_ms: 0,
					review_leg_max_tokens: 0,
				},
			}),
		);
		await pollFor(() => w.settings().reviewLegTimeoutMs === 0);
		expect(w.settings().reviewLegMaxTokens).toBe(0);
		expect(
			lines.some(
				(l) =>
					l.includes("review_leg_timeout_ms=0") &&
					l.includes("review_leg_max_tokens=0"),
			),
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

// W2405: conf cap rows ride the scheduler spawn env (env wins, conf fills).
test("scheduleReview: conf leg caps ride the spawn env (W2405)", () => {
	const f = reviewFixture();
	expect(
		scheduleReview({
			...f.options,
			settings: () => ({ reviewLegTimeoutMs: 0, reviewLegMaxTokens: 0 }),
		}),
	).toContain("requested through Buckle");
	expect(f.envs[0]?.SUSPENDERS_REVIEW_LEG_TIMEOUT_MS).toBe("0");
	expect(f.envs[0]?.SUSPENDERS_REVIEW_LEG_MAX_TOKENS).toBe("0");
});

// ── seam 5 (W2405): the request body — 0 omits the cap key ──────────────────
// requestReviewLeg against a live stub pins the wire shape: absent maxTokens
// = the 16000 fallback; 0 = the max_tokens key is OMITTED (provider default).

const legStub = () =>
	serveStub(() =>
		Response.json({
			model: "stub-model",
			choices: [{ message: { content: "VERDICT: PASS" } }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		}),
	);

test("requestReviewLeg: max_tokens 0 omits the key, absent = 16000 (W2405)", async () => {
	const stub = legStub();
	try {
		const url = `${stub.url}/v1/chat/completions`;
		// absent = the shipped fallback cap
		await requestReviewLeg({ url, model: "m", prompt: "p", timeoutMs: 30_000 });
		expect(stub.requests[0]?.body?.max_tokens).toBe(16_000);
		// 0 = OMIT the key entirely (the provider default applies)
		await requestReviewLeg({
			url,
			model: "m",
			prompt: "p",
			timeoutMs: 30_000,
			maxTokens: 0,
		});
		expect(stub.requests[1]?.body).not.toHaveProperty("max_tokens");
	} finally {
		stub.close();
	}
});

// ── seam 6 (W2405): timeoutMs 0 = uncapped fetch ────────────────────────────

test("requestReviewLeg: timeoutMs 0 sends no AbortSignal, reply parses (W2405)", async () => {
	const stub = legStub();
	try {
		const r = await requestReviewLeg({
			url: `${stub.url}/v1/chat/completions`,
			model: "m",
			prompt: "p",
			timeoutMs: 0,
			maxTokens: 65_536,
		});
		expect(r.text).toBe("VERDICT: PASS");
		expect(r.model).toBe("stub-model");
		// >0 = explicit value on the wire (same call carried maxTokens)
		expect(stub.requests[0]?.body?.max_tokens).toBe(65_536);
	} finally {
		stub.close();
	}
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
