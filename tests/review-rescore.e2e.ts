// tests/review-rescore.e2e.ts — W1476 (b): reviewer prompt, model or tooling
// changes are rescored against the whole review-arena set (paas standard
// line 851). Proves the control-plane runner over the belt arena: the review
// model pin (env, else the newest receipts' majority), the review.rescore
// event + review.rescore.last fact bank, the hourly check (disabled, idle,
// held off AC or without a lane credential, launched detached), the run (a
// scoped lane key minted and always revoked, refusals and lost lock races
// surfaced), the real arena CLI under dead legs, the CLI face and the W779
// heartbeat registration. Doubles + spawns live in
// ./helpers/review-rescore.fixture.ts; spec-file shape law: imports + test
// registrations only, plain statements inside test bodies.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AC_FILE } from "../packages/belt/bench/arena/core.ts";
import {
	MAINTENANCE_TASKS,
	missingRunners,
} from "../packages/suspenders/hooks/lib/fleet-loop/maintenance.ts";
import {
	AC_GATE,
	ARENA_CLI,
	bankRescore,
	ensureAc,
	execChild,
	rescoreCheck,
	rescoreRun,
	reviewModelPin,
} from "../packages/suspenders/hooks/lib/fleet-loop/review-rescore.ts";
import { dropRepo, head, REPO_ROOT } from "./helpers/review-evals.fixture.ts";
import {
	INCIDENT_IDS,
	scratch,
	TASKS,
	writeSeal,
} from "./helpers/review-rescore-arena.fixture.ts";
import {
	ADMIN,
	arenaChild,
	arenaStatus,
	arenaSummary,
	arm,
	buckleFront,
	callLog,
	confirmAc,
	DEAD_LEG,
	deadLegEnv,
	FRONT,
	HEAD,
	LANE_KEY,
	launcher,
	memoryStore,
	NO_PIN,
	PROJECT,
	RUNNER_BIN,
	rescoreEvents,
	rescoreFact,
	row,
	rowStatuses,
	runnerBin,
	SEAL,
	seedReview,
} from "./helpers/review-rescore.fixture.ts";

test.describe("W1476 review rescore: runner", { tag: "@api" }, () => {
	test("reviewModelPin: env override, else the newest receipts' majority (tie → newest), else none", () => {
		const db = memoryStore();
		try {
			expect(reviewModelPin(db, PROJECT, {})).toEqual({
				model: null,
				source: "none",
			});
			seedReview(db, "m-foreign", { project: "/elsewhere/.git", n: 3 });
			seedReview(db, null, { raw: "not json" });
			seedReview(db, null);
			seedReview(db, "");
			expect(reviewModelPin(db, PROJECT, {})).toEqual({
				model: null,
				source: "none",
			});
			seedReview(db, "m-a");
			seedReview(db, "m-b");
			expect(reviewModelPin(db, PROJECT, {})).toEqual({
				model: "m-b",
				source: "receipts",
			});
			seedReview(db, "m-a");
			expect(reviewModelPin(db, PROJECT, {})).toEqual({
				model: "m-a",
				source: "receipts",
			});
			expect(
				reviewModelPin(db, PROJECT, { SUSPENDERS_REVIEW_MODEL: "m-env" }),
			).toEqual({ model: "m-env", source: "env" });
			seedReview(db, "m-old", { n: 30 });
			seedReview(db, "m-new", { n: 25 });
			expect(reviewModelPin(db, PROJECT, {})).toEqual({
				model: "m-new",
				source: "receipts",
			});
		} finally {
			db.close();
		}
	});

	test("bankRescore: one review.rescore event (fingerprints stripped) + the review.rescore.last fact, versioned", () => {
		const db = memoryStore();
		try {
			const sum = arenaSummary([row("a"), row("lane", "failed")]);
			const id = bankRescore(db, PROJECT, {
				sum,
				pin: { model: "m1", source: "env" },
				reason: "heartbeat",
			});
			expect(rescoreEvents(db).map((e) => [e.id, e.scope, e.source])).toEqual(
				[[id, "rescore-r1", "review-rescore"]],
			);
			expect(rescoreEvents(db)[0]?.payload).toEqual({
				project: PROJECT,
				note: "a: scored n=3 · lane: failed n=3",
				runId: "rescore-r1",
				head: HEAD,
				seal: SEAL,
				reason: "heartbeat",
				model: "m1",
				pinSource: "env",
				rows: JSON.stringify([
					{ arm: "a", status: "scored", n: 3 },
					{ arm: "lane", status: "failed", n: 3 },
				]),
			});
			expect(rescoreFact(db)).toEqual({
				value: {
					event: id,
					project: PROJECT,
					runId: "rescore-r1",
					head: HEAD,
					seal: SEAL,
					reason: "heartbeat",
					model: "m1",
					lines: sum.lines,
				},
				source: "review-rescore",
				version: 1,
			});
			const next = bankRescore(db, PROJECT, {
				sum: { ...sum, runId: "rescore-r2", head: null },
				pin: { model: null, source: "none" },
				reason: "manual",
			});
			expect(next).toBe(id + 1);
			expect(rescoreEvents(db)[1]?.payload).toMatchObject({
				head: "",
				model: "",
				pinSource: "none",
				reason: "manual",
			});
			expect(rescoreFact(db)).toMatchObject({
				version: 2,
				value: { event: next, head: null, model: null, runId: "rescore-r2" },
			});
		} finally {
			db.close();
		}
	});

	test("rescoreCheck: disabled, no arena, idle with the why, held off AC or without a lane credential", async () => {
		const db = memoryStore();
		const dir = scratch();
		try {
			const off = arenaChild(null);
			expect(
				await rescoreCheck({
					repo: REPO_ROOT,
					env: { SUSPENDERS_REVIEW_RESCORE: "0" },
					db,
					exec: off.exec,
				}),
			).toBe("review-rescore: disabled (SUSPENDERS_REVIEW_RESCORE=0)");
			expect(
				await rescoreCheck({ repo: dir, env: {}, db, exec: off.exec }),
			).toBe(`review-rescore: idle — no review arena under ${dir}`);
			expect(off.calls).toEqual([]);
			const spy = launcher();
			const idle = arenaChild(
				arenaStatus(
					[
						arm("a", false, "unchanged"),
						arm("b", false, "unchanged"),
						arm("lane", false, "unset REVIEW_LANE_MODEL"),
					],
					["w-x", "w-y"],
				),
			);
			expect(
				await rescoreCheck({
					repo: REPO_ROOT,
					env: {
						REVIEW_LANE_URL: "http://stale.fixture.invalid",
						REVIEW_LANE_KEY: "bksk_fixture_stale",
					},
					db,
					exec: idle.exec,
					launch: spy.launch,
				}),
			).toBe(
				`review-rescore: idle — a, b: unchanged; lane: unset REVIEW_LANE_MODEL · pin ${NO_PIN} · unsealed incident cases: w-x, w-y (re-design the seal)`,
			);
			expect(idle.calls).toEqual([
				{
					argv: [process.execPath, join(REPO_ROOT, ARENA_CLI), "--rescore-status"],
					cwd: REPO_ROOT,
					env: {},
				},
			]);
			seedReview(db, "m1");
			const due = arenaChild(
				arenaStatus([
					arm("a", true, "changed: path:a.ts"),
					arm("b", false, "unchanged"),
					arm("lane", true, "changed: env:REVIEW_LANE_MODEL"),
				]),
			);
			expect(
				await rescoreCheck({
					repo: REPO_ROOT,
					env: {},
					db,
					exec: due.exec,
					ac: () => false,
					launch: spy.launch,
				}),
			).toBe(
				"review-rescore: held — no AC power confirmed (pmset); due a: changed: path:a.ts; lane: changed: env:REVIEW_LANE_MODEL · pin m1 (receipts)",
			);
			expect(due.calls[0]?.env).toEqual({ REVIEW_LANE_MODEL: "m1" });
			const lane = arenaChild(
				arenaStatus([
					arm("a", false, "unchanged"),
					arm("b", false, "unchanged"),
					arm("lane", true, "baseline"),
				]),
			);
			expect(
				await rescoreCheck({
					repo: REPO_ROOT,
					env: {},
					db,
					exec: lane.exec,
					ac: () => true,
					admin: () => null,
					launch: spy.launch,
				}),
			).toBe(
				"review-rescore: held — lane due but no buckle admin credential (BUCKLE_ADMIN_KEY / belt.env) · pin m1 (receipts)",
			);
			expect(spy.calls).toEqual([]);
		} finally {
			db.close();
			dropRepo(dir);
		}
	});

	test("rescoreCheck: a due arm on AC launches `run` detached; arena refusals throw with the exit and stderr tail", async () => {
		const db = memoryStore();
		try {
			const spy = launcher();
			const env = { SUSPENDERS_REVIEW_MODEL: "m-env" };
			const due = arenaChild(
				arenaStatus([
					arm("a", true, "changed: path:a.ts"),
					arm("b", false, "unchanged"),
					arm("lane", true, "changed: env:REVIEW_LANE_MODEL"),
				]),
			);
			expect(
				await rescoreCheck({
					repo: REPO_ROOT,
					env,
					db,
					exec: due.exec,
					ac: () => true,
					admin: () => null,
					launch: spy.launch,
				}),
			).toBe(
				"review-rescore: launched pid 4242 — due a: changed: path:a.ts; lane: changed: env:REVIEW_LANE_MODEL · pin m-env (env)",
			);
			expect(spy.calls).toEqual([
				{
					argv: [
						process.execPath,
						RUNNER_BIN,
						"run",
						"--repo",
						REPO_ROOT,
						"--reason",
						"heartbeat",
					],
					env,
					cwd: REPO_ROOT,
				},
			]);
			expect(existsSync(RUNNER_BIN)).toBe(true);
			await expect(
				rescoreCheck({
					repo: REPO_ROOT,
					env: {},
					db,
					exec: arenaChild(null).exec,
				}),
			).rejects.toThrow(
				"arena --rescore-status exit 3: seal hash mismatch: /x/tasks.json",
			);
			await expect(
				rescoreCheck({
					repo: REPO_ROOT,
					env: {},
					db,
					exec: () =>
						Promise.resolve({ code: 0, out: "no tagged line\n", err: "" }),
				}),
			).rejects.toThrow("arena --rescore-status exit 0: (no stderr)");
			expect(spy.calls).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	test("rescoreRun: refuses off AC before any read; nothing due reads the status only", async () => {
		const db = memoryStore();
		try {
			const front = buckleFront();
			const quiet = arenaChild(
				arenaStatus([
					arm("a", false, "unchanged"),
					arm("b", false, "unchanged"),
					arm("lane", false, "unchanged"),
				]),
			);
			const o = {
				repo: REPO_ROOT,
				env: { SUSPENDERS_REVIEW_MODEL: "m1" },
				db,
				exec: quiet.exec,
				admin: () => ADMIN,
				fetchFn: front.fetchFn,
				front: FRONT,
			};
			await expect(rescoreRun({ ...o, ac: () => false })).rejects.toThrow(
				"no AC power confirmed (pmset) — the arena benches on AC only",
			);
			expect(quiet.calls).toEqual([]);
			expect(await rescoreRun({ ...o, ac: () => true })).toEqual({
				lines: [
					"review-rescore: nothing due — a, b, lane: unchanged · pin m1 (env)",
				],
				ok: true,
			});
			expect(quiet.calls.map((c) => c.argv.slice(2))).toEqual([
				["--rescore-status"],
			]);
			expect(front.calls).toEqual([]);
			expect(rescoreEvents(db)).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("rescoreRun: a due lane mints a scoped key, rides /w/<sid> and revokes it after; the deltas bank", async () => {
		const db = memoryStore();
		try {
			const log = callLog();
			const front = buckleFront({}, log);
			const child = arenaChild(
				arenaStatus([
					arm("a", true, "changed: path:a.ts"),
					arm("b", false, "unchanged"),
					arm("lane", true, "changed: env:REVIEW_LANE_MODEL"),
				]),
				arenaSummary([row("a"), row("lane")]),
				log,
			);
			const r = await rescoreRun({
				repo: REPO_ROOT,
				env: {
					SUSPENDERS_REVIEW_MODEL: "m1",
					REVIEW_LANE_KEY: "bksk_fixture_stale",
				},
				db,
				exec: child.exec,
				ac: () => true,
				admin: () => ADMIN,
				fetchFn: front.fetchFn,
				front: FRONT,
			});
			expect(r).toEqual({
				ok: true,
				lines: [
					"review-rescore: manual — due a: changed: path:a.ts; lane: changed: env:REVIEW_LANE_MODEL · pin m1 (env)",
					"a: scored n=3",
					"lane: scored n=3",
					"banked review.rescore #1 · fact review.rescore.last",
				],
			});
			expect(log).toEqual(["status", "mint", "rescore", "revoke"]);
			expect(child.calls.map((c) => c.argv.slice(2))).toEqual([
				["--rescore-status"],
				["--rescore", "--arm", "all", "--reason", "manual"],
			]);
			expect(child.calls[0]?.env).toEqual({
				SUSPENDERS_REVIEW_MODEL: "m1",
				REVIEW_LANE_MODEL: "m1",
			});
			const sid = String(front.calls[0]?.body?.name);
			expect(sid).toMatch(
				/^review-rescore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
			);
			expect(child.calls[1]?.env).toEqual({
				SUSPENDERS_REVIEW_MODEL: "m1",
				REVIEW_LANE_MODEL: "m1",
				REVIEW_LANE_URL: `${FRONT}/w/${sid}/v1/chat/completions`,
				REVIEW_LANE_KEY: LANE_KEY,
			});
			expect(front.calls).toEqual([
				{
					url: `${FRONT}/v1/admin/keys`,
					method: "POST",
					auth: `Bearer ${ADMIN}`,
					body: {
						name: sid,
						scopes: ["buckle:proxy:WRITE_"],
						expires_in_s: 86_400,
					},
				},
				{
					url: `${FRONT}/v1/admin/keys/k1/revoke`,
					method: "POST",
					auth: `Bearer ${ADMIN}`,
					body: null,
				},
			]);
			expect(
				rescoreEvents(db).map((e) => [
					e.payload.reason,
					e.payload.model,
					e.payload.pinSource,
				]),
			).toEqual([["manual", "m1", "env"]]);
			expect(rescoreFact(db)?.value.lines).toEqual([
				"a: scored n=3",
				"lane: scored n=3",
			]);
		} finally {
			db.close();
		}
	});

	test("rescoreRun: a refused mint or no admin runs the other due arms and fails the run; a lane-only run stops", async () => {
		const db = memoryStore();
		try {
			const env = { SUSPENDERS_REVIEW_MODEL: "m1" };
			const refused = buckleFront({ mint: 403 });
			const one = arenaChild(
				arenaStatus([
					arm("a", true, "changed: path:a.ts"),
					arm("b", false, "unchanged"),
					arm("lane", true, "baseline"),
				]),
				arenaSummary([row("a")]),
			);
			expect(
				await rescoreRun({
					repo: REPO_ROOT,
					env,
					db,
					exec: one.exec,
					ac: () => true,
					admin: () => ADMIN,
					fetchFn: refused.fetchFn,
					front: FRONT,
				}),
			).toEqual({
				ok: false,
				lines: [
					"review-rescore: manual — due a: changed: path:a.ts; lane: baseline · pin m1 (env)",
					"lane: not run — scoped key mint refused",
					"a: scored n=3",
					"banked review.rescore #1 · fact review.rescore.last",
				],
			});
			expect(refused.calls.map((c) => c.url)).toEqual([
				`${FRONT}/v1/admin/keys`,
			]);
			expect(one.calls[1]?.argv.slice(2)).toEqual([
				"--rescore",
				"--arm",
				"both",
				"--reason",
				"manual",
			]);
			expect(one.calls[1]?.env).toEqual({
				SUSPENDERS_REVIEW_MODEL: "m1",
				REVIEW_LANE_MODEL: "m1",
			});
			const forced = arenaChild(
				arenaStatus([
					arm("a", true, "forced"),
					arm("b", false, "unchanged"),
					arm("lane", true, "forced"),
				]),
				arenaSummary([row("a")]),
			);
			const unkeyed = await rescoreRun({
				repo: REPO_ROOT,
				env,
				db,
				exec: forced.exec,
				ac: () => true,
				admin: () => null,
				force: true,
				reason: "operator",
			});
			expect(unkeyed.ok).toBe(false);
			expect(unkeyed.lines.slice(0, 2)).toEqual([
				"review-rescore: operator — due a, lane: forced · pin m1 (env)",
				"lane: not run — no buckle admin credential (BUCKLE_ADMIN_KEY / belt.env)",
			]);
			expect(forced.calls.map((c) => c.argv.slice(2))).toEqual([
				["--rescore-status", "--force"],
				["--rescore", "--arm", "both", "--reason", "operator", "--force"],
			]);
			const idleFront = buckleFront();
			const laneOnly = arenaChild(
				arenaStatus([
					arm("a", false, "unchanged"),
					arm("b", false, "unchanged"),
					arm("lane", true, "baseline"),
				]),
				arenaSummary([row("lane")]),
			);
			expect(
				await rescoreRun({
					repo: REPO_ROOT,
					env,
					db,
					exec: laneOnly.exec,
					ac: () => true,
					admin: () => null,
					fetchFn: idleFront.fetchFn,
					front: FRONT,
				}),
			).toEqual({
				ok: false,
				lines: [
					"review-rescore: manual — due lane: baseline · pin m1 (env)",
					"lane: not run — no buckle admin credential (BUCKLE_ADMIN_KEY / belt.env)",
				],
			});
			expect(laneOnly.calls).toHaveLength(1);
			expect(idleFront.calls).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("rescoreRun: a failed revoke, an arena refusal or an unscored arm fails the run; a lost lock race banks nothing", async () => {
		const db = memoryStore();
		try {
			const base = {
				repo: REPO_ROOT,
				env: { SUSPENDERS_REVIEW_MODEL: "m1" },
				db,
				ac: () => true,
				admin: () => ADMIN,
				front: FRONT,
			};
			const sticky = buckleFront({ revoke: 500 });
			const lane = arenaChild(
				arenaStatus([
					arm("a", false, "unchanged"),
					arm("b", false, "unchanged"),
					arm("lane", true, "baseline"),
				]),
				arenaSummary([row("lane")]),
			);
			const unrevoked = await rescoreRun({
				...base,
				exec: lane.exec,
				fetchFn: sticky.fetchFn,
			});
			expect(unrevoked.ok).toBe(false);
			expect(unrevoked.lines.slice(-2)).toEqual([
				"banked review.rescore #1 · fact review.rescore.last",
				"lane: scoped key revocation failed — its 24h TTL bounds it",
			]);
			const front = buckleFront();
			const refused = arenaChild(
				arenaStatus([
					arm("a", true, "baseline"),
					arm("b", false, "unchanged"),
					arm("lane", true, "baseline"),
				]),
			);
			expect(
				await rescoreRun({ ...base, exec: refused.exec, fetchFn: front.fetchFn }),
			).toEqual({
				ok: false,
				lines: [
					"review-rescore: manual — due a, lane: baseline · pin m1 (env)",
					"arena --rescore exit 3: no sealed set at /x — run --design",
				],
			});
			const partial = arenaChild(
				arenaStatus([
					arm("a", true, "baseline"),
					arm("b", true, "baseline"),
					arm("lane", false, "unchanged"),
				]),
				arenaSummary([row("a"), row("b", "skipped")]),
			);
			const unscored = await rescoreRun({
				...base,
				exec: partial.exec,
				fetchFn: front.fetchFn,
			});
			expect(unscored.ok).toBe(false);
			expect(unscored.lines.at(-1)).toBe(
				"banked review.rescore #2 · fact review.rescore.last",
			);
			const raced = arenaChild(
				arenaStatus([
					arm("a", true, "baseline"),
					arm("b", false, "unchanged"),
					arm("lane", false, "unchanged"),
				]),
				arenaSummary([], ["a: not run — rescore running (pid 7)"]),
			);
			expect(
				await rescoreRun({ ...base, exec: raced.exec, fetchFn: front.fetchFn }),
			).toEqual({
				ok: true,
				lines: [
					"review-rescore: manual — due a: baseline · pin m1 (env)",
					"a: not run — rescore running (pid 7)",
				],
			});
			expect(front.calls.map((c) => c.url)).toEqual([
				`${FRONT}/v1/admin/keys`,
				`${FRONT}/v1/admin/keys/k1/revoke`,
			]);
			expect(rescoreEvents(db).map((e) => e.scope)).toEqual([
				"rescore-r1",
				"rescore-r1",
			]);
		} finally {
			db.close();
		}
	});

	test("ensureAc: pmset AC writes the arena gate once, battery never; execChild captures exit, stdout and stderr", async () => {
		const dir = scratch();
		try {
			const gate = join(dir, "bench-ac-ok");
			expect(ensureAc(() => "Now drawing from 'Battery Power'", gate)).toBe(
				false,
			);
			expect(existsSync(gate)).toBe(false);
			expect(ensureAc(() => "Now drawing from 'AC Power'", gate)).toBe(true);
			expect(readFileSync(gate, "utf8")).toBe("ac\n");
			writeFileSync(gate, "kept\n");
			expect(ensureAc(() => "Now drawing from 'AC Power'", gate)).toBe(true);
			expect(readFileSync(gate, "utf8")).toBe("kept\n");
			expect(AC_GATE).toBe(AC_FILE);
			expect(
				await execChild(
					[
						process.execPath,
						"-e",
						"process.stdout.write('o'); process.stderr.write('e'); process.exitCode = 3",
					],
					{ cwd: dir, env: process.env },
				),
			).toEqual({ code: 3, out: "o", err: "e" });
		} finally {
			dropRepo(dir);
		}
	});

	test("real arena CLI: the heartbeat reads the sealed set under dead legs; a tampered seal throws", async () => {
		test.setTimeout(120_000);
		const db = memoryStore();
		const sealDir = scratch();
		const resDir = scratch();
		try {
			writeSeal(sealDir);
			const spy = launcher();
			const line = await rescoreCheck({
				repo: REPO_ROOT,
				env: deadLegEnv(sealDir, resDir),
				db,
				ac: () => false,
				launch: spy.launch,
			});
			expect(line).toMatch(/^review-rescore: (idle|held) — /);
			expect(line).toContain(
				`pin ${NO_PIN} · unsealed incident cases: ${INCIDENT_IDS.join(", ")} (re-design the seal)`,
			);
			expect(spy.calls).toEqual([]);
			writeSeal(sealDir, TASKS, "0000000000000000");
			await expect(
				rescoreCheck({
					repo: REPO_ROOT,
					env: deadLegEnv(sealDir, resDir),
					db,
					ac: () => false,
					launch: spy.launch,
				}),
			).rejects.toThrow(/^arena --rescore-status exit 3: [\s\S]*seal hash mismatch/);
		} finally {
			db.close();
			dropRepo(sealDir);
			dropRepo(resDir);
		}
	});

	test("real arena CLI: a forced rescore on AC reruns arms a and b over the sealed set and banks the skips; off AC it refuses before banking", async () => {
		test.setTimeout(120_000);
		const ac = confirmAc();
		const db = memoryStore();
		const sealDir = scratch();
		const resDir = scratch();
		try {
			const seal = writeSeal(sealDir);
			const run = rescoreRun({
				repo: REPO_ROOT,
				env: deadLegEnv(sealDir, resDir),
				db,
				admin: () => null,
				force: true,
				reason: "e2e",
			});
			if (!ac.ok) {
				await expect(run).rejects.toThrow(
					"no AC power confirmed (pmset) — the arena benches on AC only",
				);
				expect(rescoreEvents(db)).toEqual([]);
				return;
			}
			expect(await run).toEqual({
				ok: false,
				lines: [
					`review-rescore: e2e — due a, b: forced · pin ${NO_PIN} · unsealed incident cases: ${INCIDENT_IDS.join(", ")} (re-design the seal)`,
					`a: skipped — ${DEAD_LEG}`,
					`b: skipped — ${DEAD_LEG}`,
					"banked review.rescore #1 · fact review.rescore.last",
				],
			});
			const events = rescoreEvents(db);
			expect(events.map((e) => e.scope)).toEqual([
				expect.stringMatching(/^rescore-/),
			]);
			expect(events[0]?.payload).toMatchObject({
				head: head(REPO_ROOT),
				seal,
				reason: "e2e",
				model: "",
				pinSource: "none",
			});
			expect(rowStatuses(events[0])).toEqual([
				["a", "skipped"],
				["b", "skipped"],
			]);
		} finally {
			ac.undo();
			db.close();
			dropRepo(sealDir);
			dropRepo(resDir);
		}
	});

	test("review-rescore CLI: verb-kit help, unknown verbs and check through the real bin", () => {
		const dir = scratch();
		try {
			const help = runnerBin(["--help"]);
			expect(help.code).toBe(0);
			expect(help.out).toContain("check | run");
			const runHelp = runnerBin(["run", "--help"]);
			expect(runHelp.code).toBe(0);
			expect(runHelp.out).toContain(
				"usage: review-rescore run [--repo <dir>] [--reason <text>] [--force]",
			);
			const unknown = runnerBin(["rescore"]);
			expect(unknown.code).toBe(2);
			expect(unknown.err).toContain(
				"review-rescore: unknown command — try check | run",
			);
			expect(
				runnerBin(["check", "--repo", dir], {
					SUSPENDERS_REVIEW_RESCORE: "0",
				}),
			).toMatchObject({
				code: 0,
				out: "review-rescore: disabled (SUSPENDERS_REVIEW_RESCORE=0)\n",
			});
			expect(runnerBin(["check", "--repo", dir])).toMatchObject({
				code: 0,
				out: `review-rescore: idle — no review arena under ${dir}\n`,
			});
		} finally {
			dropRepo(dir);
		}
	});

	test("W779 heartbeat: review-rescore is one registered hourly task whose runner exists", () => {
		const tasks = MAINTENANCE_TASKS.filter((t) => t.name === "review-rescore");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({
			everySeconds: 3600,
			nice: 10,
			timeoutMs: 60_000,
		});
		expect(tasks[0]?.argv("/root", "/repo")).toEqual([
			"/root/hooks/bin/review-rescore.ts",
			"check",
			"--repo",
			"/repo",
		]);
		expect(tasks[0]?.cwd?.("/repo")).toBe("/repo");
		expect(missingRunners(tasks)).toEqual([]);
	});
});
