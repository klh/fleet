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
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedMerge } from "../hooks/lib/merge-guard.ts";
import {
	checkReviewReceipt,
	reviewContext,
	recordLanding,
} from "../hooks/lib/review-receipt.ts";
import type { GovernorStore } from "../hooks/lib/govdb-store.ts";

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
		fetch: async () =>
			Response.json({
				choices: [
					{
						message: {
							content: "looked at the diff: fine\nVERDICT: PASS - clean",
						},
					},
				],
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
	const errText = await new Response(p.stderr).text();
	await p.exited;
	stub.stop(true);
	if (p.exitCode !== 0)
		console.error("review-lane stderr:", errText.slice(0, 800));
	expect(p.exitCode).toBe(0);

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
});
