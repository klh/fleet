import { expect, test } from "@playwright/test";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { openMemoryStore } from "../govdb/govdb-store.ts";
import { ReviewOutputError, terminalReviewVerdict } from "./review-output.ts";
import { requestReviewLeg } from "./review-prompt.ts";
import { checkReviewReceipt, reviewFindingIds } from "./review-receipt.ts";
import { failedReviewRounds } from "./review-round-cap.ts";
import { walkLegs } from "./review-quota.ts";
import {
	finishReviewRequest,
	providerPressureOf,
	providerPressureKeyOf,
	reviewRequestKey,
	scheduleReview,
} from "./review-scheduler.ts";

test("HTTP-success output errors are typed and reasoning recovery requires terminal output", async () => {
	for (const mode of [
		"valid",
		"partial",
		"empty",
		"malformed",
		"wrong-shape",
		"malformed-metadata",
		"length",
		"interrupted",
	]) {
		const text = ["valid", "length", "interrupted"].includes(mode)
			? "B1-real: unresolved\nVERDICT: FAIL - real"
			: "B1-real: unresolved; analysis mentions VERDICT: PASS";
		const stub = serveStub(() =>
			mode === "malformed"
				? new Response("not JSON")
				: mode === "wrong-shape"
					? Response.json(null)
					: Response.json({
							model: "fixture-model",
							...(mode === "malformed-metadata"
								? { usage: { completion_tokens: "invalid" } }
								: {}),
							choices: [
								{
									finish_reason:
										mode === "length"
											? "length"
											: mode === "interrupted"
												? null
												: "stop",
									message: {
										content: "",
										reasoning_content: mode === "empty" ? "" : text,
									},
								},
							],
						}),
		);
		try {
			const request = () =>
				requestReviewLeg({
					url: `${stub.url}/v1/chat/completions`,
					model: "fixture-model",
					prompt: "fixture",
					timeoutMs: 1000,
				});
			if (mode === "valid") expect((await request()).text).toBe(text);
			else {
				await expect(request()).rejects.toBeInstanceOf(ReviewOutputError);
				const walk = await walkLegs({
					legLabels: ["fixture-model"],
					request: async () => (await request()).text,
					satisfied: (value) => terminalReviewVerdict(value) !== undefined,
				});
				expect(walk.failureKind).toBe("review-output");
				if (mode === "partial" || mode === "malformed-metadata")
					expect(reviewFindingIds(walk.texts.join("\n")).blocking).toEqual([
						"B1-real",
					]);
			}
		} finally {
			stub.close();
		}
	}
});

test("a later valid PASS cannot erase blockers from a prior output ERROR; ERROR spends no FAIL round", () => {
	const db = openMemoryStore();
	try {
		db.run("CREATE TABLE sessions(sid TEXT PRIMARY KEY,project TEXT)");
		db.run(
			"CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,kind TEXT,payload TEXT)",
		);
		db.run(
			"CREATE TABLE work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)",
		);
		const context = {
			repo: ".",
			commit: "a".repeat(40),
			base: "b".repeat(40),
			instructions: {},
			text: "",
		};
		db.query("INSERT INTO sessions VALUES ('reviewer','fixture')").run();
		db.query(
			"INSERT INTO work_completion_records VALUES ('fixture','W1',?,'author')",
		).run(context.commit);
		const add = (verdict: string, blocking: string[]) =>
			db
				.query(
					"INSERT INTO events(source,kind,payload) VALUES ('reviewer','work.review',?)",
				)
				.run(
					JSON.stringify({
						project: "fixture",
						work: "W1",
						receipt: JSON.stringify({
							version: 1,
							...context,
							reviewer: "reviewer",
							verdict,
							blocking,
							resolved: [],
							evidence: "fixture actual blocker",
						}),
					}),
				);
		add("ERROR", ["B1-real"]);
		expect(failedReviewRounds(db, "fixture", ["W1"])).toBe(0);
		add("PASS", []);
		expect(checkReviewReceipt(db, "fixture", "W1", context)).toMatchObject({
			ok: false,
			why: "earlier blocking findings require explicit reviewer resolution",
		});
	} finally {
		db.close();
	}
});

test("only the complete final unfenced verdict is decisive", () => {
	for (const text of [
		"VERDICT: PASS | VERDICT: FAIL - reason",
		"> VERDICT: PASS",
		"`VERDICT: PASS`",
		"```\nVERDICT: PASS",
		"VERDICT: PASS\nnot complete",
		"VERDICT: FAIL",
		"analysis mentions VERDICT: PASS",
		"    VERDICT: PASS",
		"```ts\n```not-a-closing-fence\nVERDICT: PASS",
	])
		expect(terminalReviewVerdict(text)).toBeUndefined();
	expect(
		terminalReviewVerdict(
			"old VERDICT: FAIL - discarded headline\nB1-real: unresolved\nVERDICT: PASS\n",
		),
	).toBe("PASS");
	expect(
		reviewFindingIds("B1-real: unresolved\nVERDICT: PASS").blocking,
	).toEqual(["B1-real"]);
	expect(
		terminalReviewVerdict(
			"```\nquoted verdict\n```\nVERDICT: FAIL - real defect",
		),
	).toBe("FAIL - real defect");
});

test("real provider failure preceding malformed output is not cleared", async () => {
	for (const reason of [
		"Review LLM HTTP 429",
		"Review LLM HTTP 503",
		"request deadline timeout",
		"unknown runner failure",
	]) {
		let calls = 0;
		const walk = await walkLegs({
			legLabels: ["primary", "fallback"],
			attemptsPerLeg: 1,
			request: async () => {
				if (++calls === 1) throw Error(reason);
				return "no final verdict";
			},
			satisfied: (text) => terminalReviewVerdict(text) !== undefined,
			sleep: async () => {},
		});
		expect(calls).toBe(2);
		expect(walk.failureKind).toBe(
			reason.startsWith("unknown") ? "unknown" : "provider",
		);
	}
});

test("successful invalid output stops the three-call walk without a twenty-second same-prompt retry", async () => {
	const calls: number[] = [],
		sleeps: number[] = [];
	const walk = await walkLegs({
		legLabels: ["primary", "fallback"],
		request: async (leg) => {
			calls.push(leg);
			return leg === 0
				? "B1-real: prior substantive blocker without a final verdict"
				: "VERDICT: PASS";
		},
		satisfied: (text) => text.endsWith("VERDICT: PASS"),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	expect.soft(calls).toEqual([0]);
	expect.soft(sleeps).toEqual([]);
	expect(walk).toMatchObject({
		failureKind: "review-output",
		texts: ["B1-real: prior substantive blocker without a final verdict"],
	});
});

for (const historical of [0, 2])
	for (const kind of ["review-output", "provider", "unknown"] as const)
		test(`failure ${kind} with prior pressure ${historical} preserves refund and same-provider admission`, () => {
			const world = scratchWorld({ prefix: "review-output-" }),
				db = openMemoryStore();
			try {
				db.run(
					"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
				);
				db.run(
					"CREATE TABLE work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)",
				);
				if (historical)
					db.query(
						'INSERT INTO facts VALUES (?, ?, "review-scheduler", 1, ?)',
					).run(
						providerPressureKeyOf("fixture-model"),
						JSON.stringify({
							fails: historical,
							openUntil: Date.now() - 1,
							updated: Date.now(),
						}),
						Date.now(),
					);
				const context = {
					repo: world.repo,
					commit: "a".repeat(40),
					base: "b".repeat(40),
					instructions: {},
					text: "",
				};
				for (const item of ["W1", "W2"])
					db.query(
						"INSERT INTO work_completion_records VALUES ('fixture',?,?,'author')",
					).run(item, context.commit);
				const options = {
						db,
						project: "fixture",
						item: "W1",
						repo: world.repo,
						context,
						env: {
							SUSPENDERS_REVIEW_MODEL: "fixture-model",
							SUSPENDERS_REVIEW_TRANSPORT_PARK: "1",
						},
					},
					launches: string[][] = [];
				const spawn = (args: string[]) => {
					launches.push(args);
				};
				expect(scheduleReview({ ...options, spawn })).toContain(
					"requested through Buckle",
				);
				const key = reviewRequestKey("fixture", "W1", context);
				const request = () =>
					JSON.parse(
						(
							db.query("SELECT value FROM facts WHERE key=?").get(key) as {
								value: string;
							}
						).value,
					);
				finishReviewRequest(
					db,
					key,
					request().token,
					true,
					"fixture failure",
					kind,
				);
				expect
					.soft(providerPressureOf(db, "fixture-model").fails)
					.toBe(historical + (kind === "review-output" ? 0 : 1));
				expect
					.soft(request())
					.toMatchObject({ state: "ERROR", attempts: 0, deferred: 1 });
				expect(scheduleReview({ ...options, item: "W2", spawn })).toContain(
					kind === "review-output"
						? "requested through Buckle"
						: "provider pressure",
				);
				expect(launches).toHaveLength(kind === "review-output" ? 2 : 1);
				expect(request().nextAt).toBeGreaterThan(Date.now());
				if (kind === "review-output")
					expect(scheduleReview({ ...options, spawn })).toContain(
						"parked after 1",
					);
			} finally {
				db.close();
				world.clean();
			}
		});
