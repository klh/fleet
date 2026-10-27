// tests/review-rescore-arena.e2e.ts — W1476 (b): reviewer prompt, model or
// tool changes are rescored against the whole set (paas standard line 851).
// The belt half: review-surface.json names what each arena arm measures (its
// paths at HEAD, env pins, the shared scoring files, the sealed set); a change
// to any of them makes exactly the arms it feeds DUE, the rescore reruns a due
// arm over the whole sealed set and ledgers the score delta against its
// previous scored run, and the lane arm drives the review lane's own prompt
// builder + OpenAI-wire leg. The real arena CLI reports status and refuses
// partial rescores. Rigs, stubs and the CLI child live in
// ./helpers/review-rescore-arena.fixture.ts; spec-file shape law: imports +
// test registrations only, plain statements inside test bodies.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { armLegs } from "../packages/belt/bench/arena/review-arms.ts";
import { MAX_ROUNDS } from "../packages/belt/bench/arena/review-core.ts";
import {
	armLane,
	loadLanePlugin,
} from "../packages/belt/bench/arena/review-lane-arm.ts";
import {
	loadSurface,
	readSeal,
	surfacePaths,
} from "../packages/belt/bench/arena/review-rescore.ts";
import { dropRepo, REPO_ROOT } from "./helpers/review-evals.fixture.ts";
import {
	arenaCli,
	CLEAN,
	commitSurface,
	DESIGN_WHY,
	deadPid,
	downLeg,
	hasLock,
	holdLock,
	INCIDENT,
	INCIDENT_IDS,
	LANE_KEY,
	LANE_REPLY,
	laneReplyFor,
	ledgerOf,
	legA,
	markScored,
	openAiStub,
	rescoreRig,
	rig,
	SEEDED,
	SURFACE_FILE,
	scratch,
	sealOf,
	sealRig,
	statusOf,
	stubPlugin,
	surfaceBody,
	surfaceFile,
	TASKS,
	testSurface,
	touch,
	whys,
	writeSeal,
} from "./helpers/review-rescore-arena.fixture.ts";

test.describe("W1476 review rescore: arena", { tag: "@api" }, () => {
	test("review-surface.json: three arms, the lane model pin required, every fingerprinted path exists", () => {
		const s = loadSurface(SURFACE_FILE);
		expect(Object.keys(s.arms).sort()).toEqual(["a", "b", "lane"]);
		expect(s.arms.lane.required).toEqual(["REVIEW_LANE_MODEL"]);
		expect(s.arms.lane.paths).toContain(s.lanePlugin);
		expect(s.minIntervalSeconds).toBeGreaterThan(0);
		for (const p of [...surfacePaths(s), s.lanePlugin])
			expect(existsSync(join(REPO_ROOT, p)), p).toBe(true);
	});

	test("loadSurface: malformed config throws — no silent defaults", () => {
		const dir = scratch();
		try {
			const arm = { paths: ["a.ts"] };
			expect(() => loadSurface(surfaceFile(dir, {}))).toThrow(
				/lanePlugin must name a module path/,
			);
			expect(() =>
				loadSurface(
					surfaceFile(dir, {
						lanePlugin: "p.ts",
						minIntervalSeconds: 0,
						arms: { a: arm, b: arm },
					}),
				),
			).toThrow(/arms\.lane missing/);
			expect(() =>
				loadSurface(
					surfaceFile(dir, {
						lanePlugin: "p.ts",
						minIntervalSeconds: 0,
						arms: { a: { paths: "x" }, b: arm, lane: arm },
					}),
				),
			).toThrow(/arms\.a\.paths must be a string array/);
			expect(() =>
				loadSurface(
					surfaceFile(dir, {
						lanePlugin: "p.ts",
						minIntervalSeconds: -1,
						arms: { a: arm, b: arm, lane: arm },
					}),
				),
			).toThrow(/minIntervalSeconds must be a number >= 0/);
			expect(() =>
				loadSurface(
					surfaceFile(dir, {
						lanePlugin: "p.ts",
						arms: { a: arm, b: arm, lane: arm },
					}),
				),
			).toThrow(/minIntervalSeconds must be a number >= 0/);
			expect(
				loadSurface(
					surfaceFile(dir, {
						lanePlugin: "p.ts",
						minIntervalSeconds: 0,
						arms: { a: arm, b: arm, lane: arm },
					}),
				),
			).toEqual({
				lanePlugin: "p.ts",
				minIntervalSeconds: 0,
				maxFailureRate: 0,
				shared: [],
				arms: {
					a: { paths: ["a.ts"], env: [], required: [] },
					b: { paths: ["a.ts"], env: [], required: [] },
					lane: { paths: ["a.ts"], env: [], required: [] },
				},
			});
		} finally {
			dropRepo(dir);
		}
	});

	test("readSeal: MANIFEST-verified round trip; a tampered seal throws; no seal is null", () => {
		const dir = scratch();
		try {
			const hash = writeSeal(join(dir, "ok"));
			const seal = sealOf(join(dir, "ok"));
			expect(seal.info).toEqual({ hash, ids: [SEEDED.id, CLEAN.id] });
			expect(seal.tasks).toEqual(TASKS);
			writeSeal(join(dir, "bad"), TASKS, "0000000000000000");
			expect(() => readSeal(join(dir, "bad"))).toThrow(/seal hash mismatch/);
			expect(readSeal(join(dir, "none"))).toBeNull();
		} finally {
			dropRepo(dir);
		}
	});

	test("rescoreStatus: no seal, baseline, the required pin, a dirty surface, force, live and dead locks", async () => {
		const r = rig();
		try {
			expect(whys(await statusOf(r, { seal: null }))).toEqual({
				a: `idle ${DESIGN_WHY}`,
				b: `idle ${DESIGN_WHY}`,
				lane: `idle ${DESIGN_WHY}`,
			});
			const seal = sealRig(r).info;
			const st = await statusOf(r, { seal });
			expect(st.seal).toBe(seal.hash);
			expect(st.sealed).toBe(2);
			expect(st.head).toMatch(/^[0-9a-f]{40}$/);
			expect(whys(st)).toEqual({
				a: "DUE baseline",
				b: "DUE baseline",
				lane: "idle unset REVIEW_LANE_MODEL",
			});
			touch(r, "a.ts", "export const a = 2;\n");
			expect(whys(await statusOf(r, { seal }))).toEqual({
				a: "idle dirty surface: a.ts",
				b: "DUE baseline",
				lane: "idle unset REVIEW_LANE_MODEL",
			});
			expect(whys(await statusOf(r, { seal, force: true }))).toEqual({
				a: "DUE forced",
				b: "DUE forced",
				lane: "idle unset REVIEW_LANE_MODEL",
			});
			touch(r, "a.ts", surfaceBody("a.ts"));
			holdLock(r, process.ppid);
			const why = `idle rescore running (pid ${process.ppid})`;
			const locked = await statusOf(r, { seal });
			expect(locked.locked?.pid).toBe(process.ppid);
			expect(whys(locked)).toEqual({ a: why, b: why, lane: why });
			holdLock(r, await deadPid());
			const stale = await statusOf(r, { seal });
			expect(stale.locked).toBeNull();
			expect(whys(stale).a).toBe("DUE baseline");
		} finally {
			dropRepo(r.repo);
		}
	});

	test("rescoreStatus: a path, env pin, shared file or seal change makes exactly the arms it feeds DUE", async () => {
		const r = rig();
		try {
			const seal = sealRig(r).info;
			const env = { REVIEW_LANE_MODEL: "m1" };
			await markScored(r, "a", { seal, env });
			await markScored(r, "b", { seal, env });
			await markScored(r, "lane", { seal, env });
			expect(whys(await statusOf(r, { seal, env }))).toEqual({
				a: "idle unchanged",
				b: "idle unchanged",
				lane: "idle unchanged",
			});
			commitSurface(r, "a.ts", "export const a = 2;\n");
			expect(whys(await statusOf(r, { seal, env }))).toEqual({
				a: "DUE changed: path:a.ts",
				b: "idle unchanged",
				lane: "idle unchanged",
			});
			expect(
				whys(await statusOf(r, { seal, env: { REVIEW_LANE_MODEL: "m2" } }))
					.lane,
			).toBe("DUE changed: env:REVIEW_LANE_MODEL");
			commitSurface(r, "s.ts", "export const s = 2;\n");
			expect(whys(await statusOf(r, { seal, env }))).toEqual({
				a: "DUE changed: path:a.ts, path:s.ts",
				b: "DUE changed: path:s.ts",
				lane: "DUE changed: path:s.ts",
			});
			const resealed = sealRig(r, [SEEDED, CLEAN, INCIDENT]).info;
			const st = await statusOf(r, {
				seal: resealed,
				env,
				incidentIds: [INCIDENT.id, "w1476-unsealed"],
			});
			expect(whys(st).b).toBe("DUE changed: path:s.ts, seal");
			expect(st.sealed).toBe(3);
			expect(st.unsealed).toEqual(["w1476-unsealed"]);
			expect(
				(await statusOf(r, { seal: null, incidentIds: [INCIDENT.id] }))
					.unsealed,
			).toEqual([]);
		} finally {
			dropRepo(r.repo);
		}
	});

	test("rescoreStatus: minIntervalSeconds debounces a changed arm from its last row", async () => {
		const r = rig();
		try {
			const seal = sealRig(r).info;
			const slow = testSurface(3600);
			const ts = await markScored(r, "a", {
				seal,
				env: { REVIEW_ARM_A_PORT: "1" },
				surface: slow,
			});
			const st = whys(
				await statusOf(r, {
					seal,
					env: { REVIEW_ARM_A_PORT: "2" },
					surface: slow,
				}),
			);
			expect(st.a).toBe(
				`idle debounced until ${new Date(Date.parse(ts) + 3_600_000).toISOString()}`,
			);
			expect(st.b).toBe("DUE baseline");
			expect(
				whys(await statusOf(r, { seal, env: { REVIEW_ARM_A_PORT: "2" } })).a,
			).toBe("DUE changed: env:REVIEW_ARM_A_PORT");
		} finally {
			dropRepo(r.repo);
		}
	});

	test("rescore: due arms rerun the whole sealed set and ledger the score delta; failures and locks never score", async () => {
		const r = rig();
		try {
			const s1 = sealRig(r);
			const r1 = await rescoreRig(r, {
				runId: "r1",
				seal: s1,
				legs: { a: legA("finds"), b: downLeg("leg port 1 not answering") },
			});
			expect(r1.lines).toEqual([
				"a: scored n=2 recall 100.0% fp/task 0.00 verdict 100.0% | baseline",
				"b: skipped — leg port 1 not answering",
				"lane: not run — unset REVIEW_LANE_MODEL",
			]);
			expect(r1.seal).toBe(s1.info.hash);
			expect(
				(await ledgerOf(r)).map((row) => `${row.arm}:${row.status}`),
			).toEqual(["a:scored", "b:skipped"]);
			expect(hasLock(r)).toBe(false);
			const s2 = sealRig(r, [SEEDED, CLEAN, INCIDENT]);
			expect(whys(await statusOf(r, { seal: s2.info })).a).toBe(
				"DUE changed: seal",
			);
			const r2 = await rescoreRig(r, {
				runId: "r2",
				seal: s2,
				legs: { a: legA("finds") },
				arms: ["a"],
			});
			expect(r2.lines).toEqual([
				"a: scored n=3 recall 100.0% fp/task 0.00 verdict 100.0% | Δ common n=2 +1 new: recall +0.0pp fp/task +0.00 verdict +0.0pp",
			]);
			const r3 = await rescoreRig(r, {
				runId: "r3",
				seal: s2,
				legs: { a: legA("blind") },
				arms: ["a"],
				force: true,
			});
			expect(r3.lines).toEqual([
				"a: scored n=3 recall 0.0% fp/task 0.00 verdict 33.3% | Δ common n=3: recall -100.0pp fp/task +0.00 verdict -66.7pp",
			]);
			expect(r3.rows[0]?.prevRunId).toBe("r2");
			const r4 = await rescoreRig(r, {
				runId: "r4",
				seal: s2,
				legs: { a: legA("throws") },
				arms: ["a"],
				force: true,
			});
			expect(r4.rows[0]?.status).toBe("failed");
			expect(r4.lines).toEqual([
				"a: failed n=1 recall 0.0% fp/task 0.00 verdict 100.0% — 2/3 tasks failed: leg reset",
			]);
			expect(whys(await statusOf(r, { seal: s2.info })).a).toBe(
				"idle unchanged",
			);
			holdLock(r, process.ppid);
			const why = `rescore running (pid ${process.ppid})`;
			const r5 = await rescoreRig(r, {
				runId: "r5",
				seal: s2,
				legs: { a: legA("finds") },
				force: true,
			});
			expect(r5.rows).toEqual([]);
			expect(r5.head).toBeNull();
			expect(r5.skipped).toEqual({ a: why, b: why, lane: why });
			expect(hasLock(r)).toBe(true);
		} finally {
			dropRepo(r.repo);
		}
	});

	test("armLane: one lane call over the plugin prompt; findings, verdict and trace parse from the reply", async () => {
		const leg = {
			url: "http://127.0.0.1:4555/v1/chat/completions",
			model: "m1",
			key: LANE_KEY,
		};
		const hit = stubPlugin({ text: LANE_REPLY, inTok: 11, outTok: 7 });
		const run = await armLane(SEEDED, hit.plugin, leg);
		expect(run.findings).toEqual([
			{
				id: "B1-null-deref",
				severity: "high",
				file: "x.ts",
				line: 10,
				issue: "dereferences a possibly-null config",
			},
		]);
		expect(run.verdict).toBe("FAIL");
		expect(run.roundsToPass).toBe(MAX_ROUNDS + 1);
		expect(run.ok).toBe(true);
		expect(run.tokIn).toBe(11);
		expect(run.tokOut).toBe(7);
		expect(run.trace[0]).toMatchObject({
			leg: "lane-review",
			port: 4555,
			ok: true,
		});
		expect(hit.calls).toEqual([
			{
				url: leg.url,
				model: "m1",
				key: LANE_KEY,
				prompt: `review ${SEEDED.id}`,
				timeoutMs: 900_000,
			},
		]);
		const down = await armLane(SEEDED, stubPlugin(null).plugin, leg);
		expect(down.ok).toBe(false);
		expect(down.err).toBe("Review LLM HTTP 502");
		expect(down.verdict).toBe("FAIL");
		expect(down.findings).toEqual([]);
		const pass = await armLane(
			CLEAN,
			stubPlugin({ text: "VERDICT: PASS\n", inTok: 1, outTok: 1 }).plugin,
			leg,
		);
		expect(pass.verdict).toBe("PASS");
		expect(pass.roundsToPass).toBe(1);
	});

	test("armLegs lane: the real review-lane prompt builder and OpenAI-wire leg, keyed and pinned", async () => {
		const stub = openAiStub(laneReplyFor);
		const r = rig();
		try {
			const surface = loadSurface(SURFACE_FILE);
			const env = {
				REVIEW_LANE_URL: stub.url,
				REVIEW_LANE_MODEL: "m1",
				REVIEW_LANE_KEY: LANE_KEY,
			};
			const leg = await armLegs({
				root: REPO_ROOT,
				lanePlugin: surface.lanePlugin,
				env,
			}).lane();
			if (typeof leg === "string") throw new Error(leg);
			expect(leg.plugin).toMatch(/^review-prompt\.ts@[0-9a-f]{8}$/);
			expect(leg.model).toBe("m1");
			const run = await leg.exec(SEEDED);
			expect(stub.calls).toHaveLength(1);
			expect(stub.calls[0]).toMatchObject({
				model: "m1",
				auth: `Bearer ${LANE_KEY}`,
				maxTokens: 16000,
				temperature: 0.2,
			});
			expect(stub.calls[0]?.prompt).toContain(SEEDED.diff);
			expect(stub.calls[0]?.prompt).toContain(SEEDED.mission);
			expect(run.tokIn).toBe(321);
			expect(run.tokOut).toBe(54);
			expect(run.findings.map((f) => f.id)).toEqual(["B1-null-deref"]);
			const none = await armLegs({
				root: REPO_ROOT,
				lanePlugin: surface.lanePlugin,
				env: {},
			}).lane();
			expect(String(none)).toMatch(
				/^no lane leg — set REVIEW_LANE_URL \+ REVIEW_LANE_MODEL/,
			);
			await expect(
				loadLanePlugin(REPO_ROOT, "packages/belt/bench/arena/review-score.ts"),
			).rejects.toThrow(/needs arenaReviewPrompter \+ requestReviewLeg exports/);
			const sum = await rescoreRig(r, {
				runId: "l1",
				seal: sealRig(r),
				legs: armLegs({ root: REPO_ROOT, lanePlugin: surface.lanePlugin, env }),
				arms: ["lane"],
				env: { REVIEW_LANE_MODEL: "m1" },
			});
			expect(sum.lines).toEqual([
				"lane (m1): scored n=2 recall 100.0% fp/task 0.00 verdict 100.0% | baseline",
			]);
			expect(sum.rows[0]?.plugin).toBe(leg.plugin);
			expect(stub.calls).toHaveLength(3);
		} finally {
			await stub.stop();
			dropRepo(r.repo);
		}
	});

	test("review-run.ts --rescore-status: the real CLI reads the seal and ledger dirs; refusals carry exit codes", () => {
		const dir = scratch();
		try {
			const dirs = {
				sealDir: join(dir, "seal"),
				resDir: join(dir, "results"),
			};
			const none = arenaCli(["--rescore-status"], dirs);
			expect(none.code).toBe(0);
			expect(none.status?.seal).toBeNull();
			expect(none.status?.arms.map((a) => a.why)).toEqual([
				DESIGN_WHY,
				DESIGN_WHY,
				DESIGN_WHY,
			]);
			const hash = writeSeal(dirs.sealDir);
			const sealed = arenaCli(["--rescore-status"], dirs);
			expect(sealed.code).toBe(0);
			expect(sealed.status?.seal).toBe(hash);
			expect(sealed.status?.sealed).toBe(2);
			expect(INCIDENT_IDS.length).toBeGreaterThan(0);
			expect(sealed.status?.unsealed).toEqual(INCIDENT_IDS);
			expect(
				sealed.status?.arms.find((a) => a.arm === "lane")?.why,
			).toBe("unset REVIEW_LANE_MODEL");
			expect(sealed.out).toContain("lane: idle — unset REVIEW_LANE_MODEL");
			expect(sealed.out).toContain("unsealed incident cases:");
			writeSeal(join(dir, "bad"), TASKS, "0000000000000000");
			const bad = arenaCli(["--rescore-status"], {
				sealDir: join(dir, "bad"),
				resDir: dirs.resDir,
			});
			expect(bad.code).toBe(3);
			expect(bad.err).toContain("seal hash mismatch");
			const arm = arenaCli(["--rescore-status", "--arm", "bogus"], dirs);
			expect(arm.code).toBe(1);
			expect(arm.err).toContain("--arm takes a | b | lane | both | all");
			const partial = arenaCli(["--rescore", "--limit", "1"], dirs);
			expect(partial.code).toBe(1);
			expect(partial.err).toContain("drop --limit / --src");
		} finally {
			dropRepo(dir);
		}
	});
});
