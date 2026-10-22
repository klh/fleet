import { afterEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore } from "../hooks/lib/govdb-store.ts";
import {
	checkReviewReceipt,
	publishReviewReceipt,
	reviewContext,
	recordLanding,
	type ReviewReceipt,
} from "../hooks/lib/review-receipt.ts";
import { guardedMerge } from "../hooks/lib/merge-guard.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
	const repo = realpathSync(
		mkdtempSync(join(tmpdir(), "fleet-review-receipt-")),
	);
	const db = openMemoryStore();
	cleanups.push(() => {
		db.close();
		rmSync(repo, { recursive: true, force: true });
	});
	const git = (...args: string[]) => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		return p.stdout.toString().trim();
	};
	git("init", "-b", "main");
	git("config", "user.name", "fixture");
	git("config", "user.email", "fixture@example.invalid");
	mkdirSync(join(repo, "packages/app"), { recursive: true });
	writeFileSync(join(repo, "AGENTS.md"), "Root law.\n");
	writeFileSync(join(repo, "REVIEW.md"), "Review law.\n");
	writeFileSync(join(repo, "packages/app/AGENTS.md"), "Package law.\n");
	writeFileSync(
		join(repo, "packages/app/value.ts"),
		"export const value = 1;\n",
	);
	git("add", ".");
	git("commit", "-m", "base");
	git("checkout", "-b", "suspenders/W1");
	writeFileSync(
		join(repo, "packages/app/value.ts"),
		"export const value = 2;\n",
	);
	git("add", ".");
	git("commit", "-m", "implementation");
	git("checkout", "main");
	db.run("CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT)");
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE work_completion_records (project TEXT, item TEXT, commit_sha TEXT, completed_by TEXT)",
	);
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,state TEXT,result_sha TEXT)",
	);
	for (const sid of ["author", "reviewer"])
		db.query("INSERT INTO sessions VALUES (?, 'project')").run(sid);
	const context = reviewContext(repo, "suspenders/W1");
	db.query("INSERT INTO work_items VALUES ('project','W1','DONE',?)").run(
		context.commit,
	);
	db.query(
		"INSERT INTO work_completion_records VALUES ('project', 'W1', ?, 'author')",
	).run(context.commit);
	const receipt: ReviewReceipt = {
		version: 1,
		commit: context.commit,
		base: context.base,
		instructions: context.instructions,
		reviewer: "reviewer",
		verdict: "PASS",
		blocking: [],
		evidence: "Read full diff; actual value test passed.",
	};
	const check = () =>
		checkReviewReceipt(
			db,
			"project",
			"W1",
			reviewContext(repo, "suspenders/W1"),
		);
	return { repo, db, git, context, receipt, check };
}

test("exact independent review gates real merge; landing is verified, separate and idempotent", () => {
	const f = fixture();
	expect(f.check().ok).toBe(false);
	expect(() =>
		recordLanding(
			f.db,
			f.repo,
			"project",
			"W1",
			"suspenders/W1",
			f.context.commit,
		),
	).toThrow();
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	expect(f.check().ok).toBe(true);
	expect(f.context.text).toContain("Package law.");
	expect(f.context.instructions["packages/app/REVIEW.md"]).toBe("absent");
	const merged = guardedMerge({
		repo: f.repo,
		callerRepo: f.repo,
		branch: "suspenders/W1",
		timeoutMs: 10_000,
		verifyReview: f.check,
	});
	expect(merged.code).toBe(0);
	const id = recordLanding(
		f.db,
		f.repo,
		"project",
		"W1",
		"suspenders/W1",
		f.context.commit,
	);
	expect(
		recordLanding(
			f.db,
			f.repo,
			"project",
			"W1",
			"suspenders/W1",
			f.context.commit,
		),
	).toBe(id);
	const event = f.db
		.query("SELECT payload FROM events WHERE id = ?")
		.get(id) as { payload: string };
	expect(JSON.parse(event.payload)).toMatchObject({
		project: "project",
		work: "W1",
		commit: f.context.commit,
		verification: "git-ancestor",
	});
});

test("self review and unregistered reviewers cannot approve", () => {
	const f = fixture();
	expect(() =>
		publishReviewReceipt(f.db, "project", "W1", {
			...f.receipt,
			reviewer: "unknown",
		}),
	).toThrow();
	publishReviewReceipt(f.db, "project", "W1", {
		...f.receipt,
		reviewer: "author",
	});
	expect(f.check()).toMatchObject({
		ok: false,
		why: "review is not independent of completion author",
	});
});

test("blocking findings survive a later empty PASS until explicitly resolved", () => {
	const f = fixture();
	publishReviewReceipt(f.db, "project", "W1", {
		...f.receipt,
		verdict: "FAIL",
		blocking: ["B1-bug"],
	});
	expect(f.check().ok).toBe(false);
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	expect(f.check().ok).toBe(false);
	publishReviewReceipt(f.db, "project", "W1", {
		...f.receipt,
		resolved: ["B1-bug"],
		evidence:
			"B1-bug reproduced on base only; exact candidate regression passes.",
	});
	expect(f.check().ok).toBe(true);
});

test("moving integration base or changing applicable instruction invalidates receipt", () => {
	const f = fixture();
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	writeFileSync(
		join(f.repo, "packages/app/REVIEW.md"),
		"Additional review requirement.\n",
	);
	f.git("add", ".");
	f.git("commit", "-m", "new package instructions");
	expect(f.check().ok).toBe(false);
	expect(f.check().why).toContain("stale");
});

test("new branch commit and cross-project receipt cannot inherit approval", () => {
	const f = fixture();
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	expect(checkReviewReceipt(f.db, "other-project", "W1", f.context).ok).toBe(
		false,
	);
	f.git("checkout", "suspenders/W1");
	writeFileSync(
		join(f.repo, "packages/app/value.ts"),
		"export const value = 3;\n",
	);
	f.git("add", ".");
	f.git("commit", "-m", "changed candidate");
	f.git("checkout", "main");
	expect(f.check().ok).toBe(false);
});

test("review revoked during isolated ladder prevents publication", () => {
	const f = fixture();
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	let checks = 0;
	const result = guardedMerge({
		repo: f.repo,
		callerRepo: f.repo,
		branch: "suspenders/W1",
		timeoutMs: 10_000,
		verifyReview: () => {
			checks += 1;
			return checks === 1
				? f.check()
				: { ok: false, why: "new blocking finding" };
		},
	});
	expect(result.code).toBe(1);
	expect(result.tail).toContain("new blocking finding");
	expect(f.git("rev-parse", "HEAD")).toBe(f.context.base);
});
