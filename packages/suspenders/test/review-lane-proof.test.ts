// review-lane-proof.test.ts — W634 coverage-proof e2e (Sinai rule): a PASS
// only stands when the branch's new tests FAIL without the change. Each case
// builds a real git fixture repo + a branch with scripted prod/test files, a
// stub executor that always PASSes, and asserts the mechanical outcome.
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedMerge } from "../hooks/lib/fleet-loop/merge-guard.ts";
import {
	checkReviewReceipt,
	reviewContext,
	recordLanding,
	type ReviewContext,
} from "../hooks/lib/gates/review-receipt.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb-store.ts";
import {
	scheduleReview,
	reviewRequestKey,
} from "../hooks/lib/gates/review-scheduler.ts";

function seedCompletion(
	db: Database,
	item: string,
	context: ReviewContext,
): void {
	db.exec(
		"CREATE TABLE IF NOT EXISTS work_completion_records(project TEXT,item TEXT,summary TEXT,summary_hash TEXT,commit_sha TEXT,baseline_sha TEXT,completed_by TEXT,completed_at INTEGER,capsule_json TEXT,evidence_json TEXT)",
	);
	db.query(
		"INSERT INTO work_completion_records(project,item,summary,summary_hash,commit_sha,baseline_sha,completed_by,completed_at,capsule_json,evidence_json) VALUES (?,?,'fixture',?,?,?,'fixture-author',?,'{}','{}')",
	).run(
		MY_PROJ,
		item,
		"0".repeat(64),
		context.commit,
		context.base,
		Date.now(),
	);
	db.query(
		"UPDATE work_items SET state='DONE',result_sha=? WHERE project=? AND id=?",
	).run(context.commit, MY_PROJ, item);
	db.query(
		"INSERT OR REPLACE INTO facts(key,value,source,version,ts) VALUES ('lane.fixture-author.model','fixture-model','fixture',1,?)",
	).run(Date.now());
}

setDefaultTimeout(120_000);

const HOME = mkdtempSync(join(tmpdir(), "w634-home-"));
const REPO = mkdtempSync(join(tmpdir(), "w634-repo-"));
const BIN = join(import.meta.dir, "..", "hooks", "bin");
const DB_PATH = `${HOME}/.cache/claude-governor/governor.db`;

const env: Record<string, string | undefined> = {
	...process.env,
	HOME,
	SUSPENDERS_MDNS: "0",
	SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
	SUSPENDERS_BELT_ENV: join(HOME, "absent-belt.env"),
};
delete env.SUSPENDERS_SID; // the declared-lane gate refuses the test's own sid
delete env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;

const git = (args: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: p.exitCode ?? 1, out: p.stdout.toString() };
};

function addWork(title: string): string {
	const p = Bun.spawnSync(["bun", join(BIN, "work.ts"), "add", title], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`work add failed: ${p.stderr.toString()}`);
	const db = new Database(DB_PATH, { readonly: true });
	const row = db
		.query("SELECT id FROM work_items WHERE title = ?")
		.get(title) as {
		id: string;
	};
	db.close();
	return row.id;
}

// project identity of the fixture repo (the common git dir, per govdb law)
let MY_PROJ = "";
function learnProject(): void {
	const db = new Database(DB_PATH, { readonly: true });
	MY_PROJ = String(
		(
			db.query("SELECT DISTINCT project FROM work_items").get() as {
				project: string;
			}
		).project,
	);
	db.close();
}

interface Case {
	name: string;
	// branch-tip file contents, relative to the fixture repo root
	files: Record<string, string>;
	// the fact payload expectation after the stub executor PASSes
	want: "proved" | "no-coverage" | "skipped";
}

async function runCase(
	c: Case,
	stubFetch?: (req: Request) => Response | Promise<Response>,
	wantExit = 0,
): Promise<{ id: string; fact: Record<string, unknown> }> {
	const id = addWork(`w634 proof ${c.name}`);
	const branch = `suspenders/${id}`;
	expect(git(["checkout", "-b", branch]).code).toBe(0);
	for (const [path, content] of Object.entries(c.files))
		await Bun.write(join(REPO, path), content);
	expect(git(["add", "-A"]).code).toBe(0);
	expect(git(["commit", "-m", c.name]).code).toBe(0);
	git(["checkout", "main"]); // the proof reads refs/heads/<branch>, not the checkout

	const stub = Bun.serve({
		port: 0,
		fetch:
			stubFetch ??
			(async () =>
				Response.json({
					choices: [
						{
							message: {
								content: "looked at the diff: fine\nVERDICT: PASS - clean",
							},
						},
					],
				})),
	});
	const p = Bun.spawn(
		[
			"bun",
			join(BIN, "review-lane.ts"),
			"--item",
			id,
			"--project",
			MY_PROJ,
			"--executor",
			"glm-w634",
			"--llm-url",
			`http://127.0.0.1:${stub.port}/v1/chat/completions`,
			"--llm-model",
			"glm-w634-model",
		],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	const errText = await new Response(p.stderr).text();
	await p.exited;
	stub.stop(true);
	if (p.exitCode !== 0)
		console.error("review-lane stderr:", errText.slice(0, 800));
	expect(p.exitCode).toBe(wantExit);

	const db = new Database(DB_PATH, { readonly: true });
	const fact = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`review.${id}.glm-w634`) as { value: string } | null;
	db.close();
	if (!fact)
		throw new Error(`no review fact for ${id}: ${errText.slice(0, 400)}`);
	return { id, fact: JSON.parse(fact.value) as Record<string, unknown> };
}

beforeAll(async () => {
	// one git repo for every case: main + per-case branches suspenders/<id>
	git(["init", "-b", "main"]);
	git(["config", "user.email", "w634@test"]);
	git(["config", "user.name", "w634"]);
	await Bun.write(join(REPO, "src.ts"), "export const base = 1;\n");
	expect(git(["add", "-A"]).code).toBe(0);
	expect(git(["commit", "-m", "base"]).code).toBe(0);
	addWork("w634 proof bootstrap"); // creates the store + reveals the project key
	learnProject();
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const cases: Case[] = [
	{
		// the change is irrelevant to the test: without it the test still passes
		// → no coverage → the mechanical PASS downgrade
		name: "no-coverage",
		files: {
			"src.ts": "export const base = 1;\nexport const marker = 'w634';\n",
			"src.test.ts": `import { test, expect } from "bun:test";
test("trivial", () => {
	expect(1 + 1).toBe(2);
});
`,
		},
		want: "no-coverage",
	},
	{
		// the test needs the change: reverted src.ts has no double → link error
		// counted as a fail → coverage proved → the PASS stands
		name: "proved",
		files: {
			"src.ts":
				"export const base = 1;\nexport const double = (x: number): number => x * 2;\n",
			"src.test.ts": `import { test, expect } from "bun:test";
import { double } from "./src";
test("needs the change", () => {
	expect(double(2)).toBe(4);
});
`,
		},
		want: "proved",
	},
	{
		// nothing testable in the diff → the proof skips and says so
		name: "skipped",
		files: {
			"docs.md": "words\n",
		},
		want: "skipped",
	},
];

describe("W634 review-lane coverage proof (Sinai rule)", () => {
	const results: Record<string, Record<string, unknown>> = {};
	const ids: Record<string, string> = {};

	test("fixture repo + store bootstrap", () => {
		expect(MY_PROJ).toContain("/.git");
		expect(git(["rev-parse", "--verify", "main"]).code).toBe(0);
	});

	for (const c of cases) {
		test(`case ${c.name}: stub PASS + proof → ${c.want}`, async () => {
			const { id, fact } = await runCase(c);
			results[c.name] = fact;
			ids[c.name] = id;
			expect(fact.verdict).toBe(c.want === "no-coverage" ? "FAIL" : "PASS");
			const coverage = fact.coverage as Record<string, unknown>;
			expect(coverage.status).toBe(c.want);
			expect(String(fact.headline)).toContain("coverage-proof");
			if (c.want === "proved")
				expect(Number(coverage.failed)).toBeGreaterThan(0);
		});
	}

	test("W1236: empty-content 200 is a diagnosed failure, not opaque leg-failed", async () => {
		// the exact glm thinking-budget failure: HTTP 200 with content:"" and
		// finish_reason=length — every merge-ladder receipt on 2026-10-23
		const id = addWork("w634 proof empty-content diagnostics");
		const branch = `suspenders/${id}`;
		expect(git(["checkout", "-b", branch]).code).toBe(0);
		await Bun.write(join(REPO, "docs.md"), "w1236 empty-content case\n");
		expect(git(["add", "-A"]).code).toBe(0);
		expect(git(["commit", "-m", "w1236 case"]).code).toBe(0);
		git(["checkout", "main"]);
		const stub = Bun.serve({
			port: 0,
			fetch: async () =>
				Response.json({
					choices: [
						{
							finish_reason: "length",
							message: { content: "" },
						},
					],
					usage: { completion_tokens: 1500 },
				}),
		});
		const p = Bun.spawn(
			[
				"bun",
				join(BIN, "review-lane.ts"),
				"--item",
				id,
				"--project",
				MY_PROJ,
				"--executor",
				"glm-w634",
				"--llm-url",
				`http://127.0.0.1:${stub.port}/v1/chat/completions`,
				"--llm-model",
				"glm-w634-model",
			],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		);
		await p.exited;
		stub.stop(true);
		expect(p.exitCode).toBe(2);
		const db = new Database(DB_PATH, { readonly: true });
		const fact = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`review.${id}.glm-w634`) as { value: string } | null;
		db.close();
		if (!fact) throw new Error(`no review fact for ${id}`);
		const parsed = JSON.parse(fact.value) as Record<string, unknown>;
		expect(parsed.verdict).toBe("ERROR");
		expect(String(parsed.headline)).toContain("empty content");
		expect(String(parsed.headline)).toContain("finish_reason=length");
	});

	test("W1263: reasoning-only 200 (content empty) is recovered, not an ERROR", async () => {
		const { id, fact } = await runCase(
			{
				name: "w1263-recovery",
				files: { "docs.md": "w1263 reasoning-only case\n" },
				want: "skipped",
			},
			async () =>
				Response.json({
					model: "stub-reasoner",
					choices: [
						{
							finish_reason: "stop",
							message: {
								content: "",
								reasoning_content:
									"N1-recovered: advisory.\nVERDICT: PASS - recovered from reasoning_content",
							},
						},
					],
					usage: { completion_tokens: 1263 },
				}),
		);
		expect(fact.verdict).toBe("PASS");
		expect(fact.wire_model).toBe("stub-reasoner");
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const ev = db
				.query(
					"SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.work') = ?",
				)
				.get(id) as { payload: string } | null;
			if (!ev) throw new Error(`no work.review event for ${id}`);
			const note = String(JSON.parse(ev.payload).note ?? "");
			expect(note).toContain("recovered from reasoning_content");
		} finally {
			db.close();
		}
	});

	test("W1263: both-empty 200 carries served-model payload diagnostics", async () => {
		const { fact } = await runCase(
			{
				name: "w1263-both-empty",
				files: { "docs.md": "w1263 both-empty case\n" },
				want: "skipped",
			},
			async () =>
				Response.json({
					model: "zai-glm-5.3-flash",
					choices: [
						{
							finish_reason: "stop",
							message: { content: "" },
						},
					],
					usage: { completion_tokens: 1427 },
				}),
			2,
		);
		expect(fact.verdict).toBe("ERROR");
		const h = String(fact.headline);
		expect(h).toContain("empty content");
		expect(h).toContain("model=zai-glm-5.3-flash");
		expect(h).toContain("finish_reason=stop");
		expect(h).toContain("completion_tokens=1427");
		expect(h).toContain("content_len=0");
		expect(h).toContain("reasoning_len=0");
	});

	test("W1236.1: a retry PASS cannot erase the first attempt's blocking findings", async () => {
		// FAIL60967: the first reply carries a blocker without a verdict line;
		// a retry PASS must not wash the blocker out of the receipt.
		const id = addWork("w634 proof retry erases findings");
		const branch = `suspenders/${id}`;
		expect(git(["checkout", "-b", branch]).code).toBe(0);
		await Bun.write(join(REPO, "docs.md"), "w1236.1 retry case\n");
		expect(git(["add", "-A"]).code).toBe(0);
		expect(git(["commit", "-m", "w1236.1 case"]).code).toBe(0);
		git(["checkout", "main"]);
		let calls = 0;
		const replies = [
			{
				choices: [
					{
						message: {
							content:
								"B1-erase-guard: the retry path drops a prior attempt's blocker.\n",
						},
					},
				],
			},
			{
				choices: [
					{ message: { content: "No blocking findings.\nVERDICT: PASS" } },
				],
			},
		];
		const stub = Bun.serve({
			port: 0,
			fetch: async () =>
				Response.json(replies[Math.min(calls++, replies.length - 1)]),
		});
		const p = Bun.spawn(
			[
				"bun",
				join(BIN, "review-lane.ts"),
				"--item",
				id,
				"--project",
				MY_PROJ,
				"--executor",
				"glm-w634",
				"--llm-url",
				`http://127.0.0.1:${stub.port}/v1/chat/completions`,
				"--llm-model",
				"glm-w634-model",
			],
			{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
		);
		await p.exited;
		stub.stop(true);
		expect(p.exitCode).toBe(0);
		const db = new Database(DB_PATH, { readonly: true });
		const event = db
			.query(
				"SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.work') = ? ORDER BY id DESC LIMIT 1",
			)
			.get(id) as { payload: string } | null;
		db.close();
		if (!event) throw new Error(`no work.review event for ${id}`);
		const receipt = JSON.parse(
			JSON.parse(event.payload).receipt as string,
		) as Record<string, unknown>;
		expect(receipt.verdict).toBe("PASS");
		expect(receipt.blocking).toEqual(["B1-erase-guard"]);
		expect(String(receipt.evidence)).toContain("B1-erase-guard");
	});

	test("W1243.1.1: proof-ordering contract reaches the reviewer before any verdict", async () => {
		// FAIL62885: the reviewer saw no proof output and refused PASS; the
		// prompt must carry the binding ordering contract and the harness
		// proof must still gate after the provisional PASS.
		let prompt: string | undefined;
		const { fact } = await runCase(
			{
				name: "ordering",
				want: "proved",
				files: {
					"src.ts":
						"export const base = 1;\nexport const double = (x: number): number => x * 2;\n",
					"src.test.ts":
						'import { test, expect } from "bun:test";\nimport { double } from "./src";\ntest("needs the change", () => expect(double(2)).toBe(4));\n',
				},
			},
			async (req) => {
				const body = (await req.json()) as {
					messages: { content: string }[];
				};
				prompt = body.messages[0].content;
				return Response.json({
					choices: [
						{ message: { content: "No blocking findings.\nVERDICT: PASS" } },
					],
				});
			},
		);
		// pre-verdict proof output is not required — the prompt says so
		expect(prompt).toContain("PROOF ORDERING (Sinai rule, binding)");
		expect(prompt).toContain("AFTER your verdict");
		expect(prompt).toContain("is NOT a finding");
		expect(prompt).toContain(
			"do not open a blocker for missing coverage proof",
		);
		// post-PASS harness proof is binding: PASS stands only on a proved run
		expect(fact.verdict).toBe("PASS");
		expect((fact.coverage as Record<string, unknown>).status).toBe("proved");
	});

	test("W1243.1.1.1: a genuine finding keeps a FAIL blocked", async () => {
		const provedCase = cases.find((c) => c.name === "proved");
		if (!provedCase) throw new Error("proved case missing");
		const { id, fact } = await runCase(
			{ ...provedCase, name: "fail-finding" },
			async () =>
				Response.json({
					choices: [
						{
							message: {
								content:
									"B2-erase-guard: the retry path drops a prior attempt's blocker.\nVERDICT: FAIL - retry drops prior attempt's blocker",
							},
						},
					],
				}),
		);
		expect(fact.verdict).toBe("FAIL");
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const ev = db
				.query(
					"SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.work') = ?",
				)
				.get(id) as { payload: string } | null;
			if (!ev) throw new Error("no work.review event for fail-finding");
			const receipt = JSON.parse(
				JSON.parse(ev.payload).receipt as string,
			) as Record<string, unknown>;
			expect(receipt.verdict).toBe("FAIL");
			expect(receipt.blocking).toEqual(["B2-erase-guard"]);
			expect(receipt.resolved).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("W1243.1.1.1: PASS prose naming a resolved blocker stays non-blocking", async () => {
		const provedCase = cases.find((c) => c.name === "proved");
		if (!provedCase) throw new Error("proved case missing");
		const { id, fact } = await runCase(
			{ ...provedCase, name: "resolved-mention" },
			async () =>
				Response.json({
					choices: [
						{
							message: {
								content:
									"The prior B1-no-coverage-proof is covered by the proved scratch run.\nRESOLVED: B1-no-coverage-proof scratch revert failed 9 new test(s).\nVERDICT: PASS - clean",
							},
						},
					],
				}),
		);
		expect(fact.verdict).toBe("PASS");
		const db = new Database(DB_PATH, { readonly: true });
		try {
			const ev = db
				.query(
					"SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.work') = ?",
				)
				.get(id) as { payload: string } | null;
			if (!ev) throw new Error("no work.review event for resolved-mention");
			const receipt = JSON.parse(
				JSON.parse(ev.payload).receipt as string,
			) as Record<string, unknown>;
			expect(receipt.blocking).toEqual([]);
			expect(receipt.resolved).toEqual(["B1-no-coverage-proof"]);
		} finally {
			db.close();
		}
	});

	test("downgrade reaches the work.review event (drawer timeline)", () => {
		expect(results["no-coverage"]).toBeTruthy();
		const db = new Database(DB_PATH, { readonly: true });
		const ev = db
			.query(
				"SELECT payload FROM events WHERE kind = 'work.review' AND json_extract(payload, '$.work') = ?",
			)
			.get(ids["no-coverage"]) as { payload: string } | null;
		db.close();
		if (!ev) throw new Error("no work.review event for the no-coverage item");
		const payload = JSON.parse(ev.payload) as Record<string, unknown>;
		expect(payload.verdict).toBe("FAIL");
		expect(String(payload.note)).toContain("coverage-proof (no-coverage)");
	});

	test("actual review-lane receipt authorizes exact merge and separate landing", () => {
		const item = ids.proved;
		const repo = realpathSync(REPO);
		const context = reviewContext(repo, `suspenders/${item}`);
		const db = new Database(DB_PATH);
		try {
			const event = db
				.query(
					"SELECT source,payload FROM events WHERE kind='work.review' AND json_extract(payload,'$.work')=? ORDER BY id DESC LIMIT 1",
				)
				.get(item) as { source: string; payload: string };
			const receipt = JSON.parse(JSON.parse(event.payload).receipt);
			expect(receipt).toMatchObject({
				commit: context.commit,
				base: context.base,
				reviewer: event.source,
				instructions: context.instructions,
				verdict: "PASS",
			});
			expect(
				db
					.query("SELECT sid FROM sessions WHERE sid=? AND project=?")
					.get(event.source, MY_PROJ),
			).toBeTruthy();
			seedCompletion(db, item, context);
			const store = db as unknown as GovernorStore;
			const result = guardedMerge({
				repo,
				callerRepo: repo,
				branch: `suspenders/${item}`,
				timeoutMs: 10_000,
				verifyReview: () => checkReviewReceipt(store, MY_PROJ, item, context),
			});
			expect(result).toEqual({ code: 0, tail: "" });
			const landed = recordLanding(
				store,
				repo,
				MY_PROJ,
				item,
				`suspenders/${item}`,
				context.commit,
			);
			expect(
				db.query("SELECT kind FROM events WHERE id=?").get(landed),
			).toEqual({ kind: "work.landed" });
		} finally {
			db.close();
		}
	});

	test("canonical missing review schedules existing runner through scoped Buckle then lands", async () => {
		const item = addWork("automatic review fixture");
		expect(git(["checkout", "-b", `suspenders/${item}`]).code).toBe(0);
		await Bun.write(join(REPO, "automatic.md"), "Documented fixture change.\n");
		git(["add", "automatic.md"]);
		git(["commit", "-m", "automatic fixture"]);
		git(["checkout", "main"]);
		const context = reviewContext(realpathSync(REPO), `suspenders/${item}`);
		const db = new Database(DB_PATH);
		seedCompletion(db, item, context);
		let minted = 0,
			inferred = 0,
			revoked = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const path = new URL(req.url).pathname;
				if (path === "/v1/admin/keys") {
					minted += 1;
					return Response.json({
						key: "bksk_fixture_review",
						key_id: "fixture-review-key",
					});
				}
				if (path.endsWith("/revoke")) {
					revoked += 1;
					return Response.json({ ok: true });
				}
				if (/^\/w\/review-[^/]+\/v1\/chat\/completions$/.test(path)) {
					inferred += 1;
					expect(req.headers.get("authorization")).toBe(
						"Bearer bksk_fixture_review",
					);
					const body = (await req.json()) as {
						model: string;
						messages: { content: string }[];
					};
					expect(body.model).toBe("fixture-model");
					expect(body.messages[0].content).toContain(context.commit);
					return Response.json({
						choices: [
							{ message: { content: "No blocking findings.\nVERDICT: PASS" } },
						],
					});
				}
				return new Response("unexpected endpoint", { status: 404 });
			},
		});
		const ship = async () => {
			const p = Bun.spawn(
				[
					"bun",
					join(BIN, "fleet-loop.ts"),
					"ship",
					"--repo",
					realpathSync(REPO),
					"--branch",
					`suspenders/${item}`,
				],
				{
					cwd: REPO,
					env: {
						...env,
						GOVERNOR_STORE_URL: "",
						FLEET_UNTRACKED_GRACE_MS: "0",
						SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${server.port}`,
						BUCKLE_ADMIN_KEY: "fixture-admin",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await new Response(p.stdout).text();
			await p.exited;
		};
		try {
			await Bun.write(join(REPO, ".fleet/lanes.json"), "[]");
			await ship();
			expect(git(["rev-parse", "HEAD"]).out.trim()).toBe(context.base);
			for (
				let i = 0;
				i < 100 &&
				!db
					.query(
						"SELECT id FROM events WHERE kind='work.review' AND json_extract(payload,'$.work')=?",
					)
					.get(item);
				i += 1
			)
				await Bun.sleep(50);
			expect(
				db
					.query(
						"SELECT id FROM events WHERE kind='work.review' AND json_extract(payload,'$.work')=?",
					)
					.get(item),
			).toBeTruthy();
			await ship();
			expect(
				git(["merge-base", "--is-ancestor", context.commit, "HEAD"]).code,
			).toBe(0);
			expect(
				db
					.query(
						"SELECT id FROM events WHERE kind='work.landed' AND json_extract(payload,'$.work')=?",
					)
					.get(item),
			).toBeTruthy();
			expect({ minted, inferred, revoked }).toEqual({
				minted: 1,
				inferred: 1,
				revoked: 1,
			});
		} finally {
			db.close();
			server.stop(true);
		}
	});

	test("base changed at spawn releases old review lease as ERROR before any mint", async () => {
		const item = addWork("stale scheduled review fixture");
		git(["checkout", "-b", `suspenders/${item}`]);
		await Bun.write(join(REPO, "stale.md"), "Candidate fixture.\n");
		git(["add", "stale.md"]);
		git(["commit", "-m", "stale fixture"]);
		git(["checkout", "main"]);
		const repo = realpathSync(REPO),
			context = reviewContext(repo, `suspenders/${item}`);
		const db = new Database(DB_PATH);
		seedCompletion(db, item, context);
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				calls += 1;
				return new Response("must not be called", { status: 500 });
			},
		});
		let child: ReturnType<typeof Bun.spawn> | undefined;
		try {
			scheduleReview({
				db: db as unknown as GovernorStore,
				project: MY_PROJ,
				item,
				repo,
				context,
				env: {
					...env,
					GOVERNOR_STORE_URL: "",
					SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${server.port}`,
					BUCKLE_ADMIN_KEY: "fixture-admin",
				},
				spawn: (args, childEnv) => {
					writeFileSync(
						join(REPO, "REVIEW.md"),
						"New instruction after reservation.\n",
					);
					git(["add", "REVIEW.md"]);
					git(["commit", "-m", "changed integration base"]);
					child = Bun.spawn(args, {
						cwd: repo,
						env: childEnv,
						stdout: "pipe",
						stderr: "pipe",
					});
				},
			});
			if (!child) throw new Error("review was not scheduled");
			await new Response(child.stderr).text();
			await child.exited;
			expect(child.exitCode).toBe(2);
			expect(calls).toBe(0);
			const row = db
				.query("SELECT value FROM facts WHERE key=?")
				.get(reviewRequestKey(MY_PROJ, item, context)) as { value: string };
			expect(JSON.parse(row.value)).toMatchObject({
				state: "ERROR",
				leaseUntil: 0,
				error: "review context changed before scheduled runner started",
			});
			expect(
				db
					.query(
						"SELECT id FROM events WHERE kind='work.review' AND json_extract(payload,'$.work')=?",
					)
					.get(item),
			).toBeNull();
		} finally {
			db.close();
			server.stop(true);
		}
	});
});
