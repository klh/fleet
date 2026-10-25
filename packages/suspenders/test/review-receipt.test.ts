import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedMerge } from "../hooks/lib/fleet-loop/merge-guard.ts";
import {
	checkReviewReceipt,
	priorBlockingReviewLines,
	publishReviewReceipt,
	type ReviewReceipt,
	recordLanding,
	reviewContext,
	reviewFindingIds,
} from "../hooks/lib/gates/review-receipt.ts";
import { openMemoryStore } from "../hooks/lib/govdb/govdb-store.ts";

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

test("review prompt exposes exact-commit blockers even when the event note truncates them", () => {
	const f = fixture();
	publishReviewReceipt(f.db, "project", "W1", {
		...f.receipt,
		verdict: "ERROR",
		blocking: ["B1-round1-scrubtext-import"],
		evidence: `${"partial analysis ".repeat(40)}scrubText import needs verification`,
	});
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	publishReviewReceipt(f.db, "project", "W1", {
		...f.receipt,
		commit: "f".repeat(40),
		verdict: "ERROR",
		blocking: ["B9-other-commit"],
	});
	const lines = priorBlockingReviewLines(
		f.db,
		"project",
		"W1",
		f.context.commit,
	);
	expect(lines.join("\n")).toContain("B1-round1-scrubtext-import");
	expect(lines.join("\n")).toContain("scrubText import needs verification");
	expect(lines.join("\n")).not.toContain("B9-other-commit");
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

test("review remains valid when main advances only in a disjoint path", () => {
	const f = fixture();
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	mkdirSync(join(f.repo, "docs"));
	writeFileSync(join(f.repo, "docs/notes.md"), "Independent notes.\n");
	f.git("add", ".");
	f.git("commit", "-m", "unrelated documentation");
	expect(f.check()).toMatchObject({ ok: true });
});

for (const testSource of [
	"packages/app/review-scheduler-w1280.test.ts",
	"packages/app/feature.spec.ts",
]) {
	test(`disjoint ordinary test source ${testSource} preserves a PASS`, () => {
		const f = fixture();
		publishReviewReceipt(f.db, "project", "W1", f.receipt);
		writeFileSync(join(f.repo, testSource), "Test source only.\n");
		f.git("add", ".");
		f.git("commit", "-m", "independent test source");
		expect(f.check()).toMatchObject({ ok: true });
	});
}

for (const sharedInput of [
	"tsconfig.json",
	"packages/app/tsconfig.build.json",
	"package.json",
	"packages/app/package.json",
	"bun.lock",
	"packages/app/bun.lock",
	"packages/app/build.config.ts",
	".github/workflows/ci.yml",
	".npmrc",
	".pnp.cjs",
	"packages/app/test.setup.ts",
	"packages/app/test.config.ts",
	"packages/app/build.ts",
]) {
	test(`disjoint shared input ${sharedInput} invalidates an old PASS`, () => {
		const f = fixture();
		publishReviewReceipt(f.db, "project", "W1", f.receipt);
		mkdirSync(join(f.repo, sharedInput, ".."), { recursive: true });
		writeFileSync(join(f.repo, sharedInput), "Changed shared input.\n");
		f.git("add", ".");
		f.git("commit", "-m", "change shared input");
		expect(f.check()).toMatchObject({ ok: false });
	});
}

test("review remains valid when main advances to an ancestor of the exact candidate", () => {
	const f = fixture();
	f.git("checkout", "suspenders/W1");
	writeFileSync(
		join(f.repo, "packages/app/extra.ts"),
		"export const extra = 1;\n",
	);
	f.git("add", ".");
	f.git("commit", "-m", "second candidate commit");
	f.git("checkout", "main");
	const context = reviewContext(f.repo, "suspenders/W1");
	f.db
		.query("UPDATE work_items SET result_sha = ? WHERE id = 'W1'")
		.run(context.commit);
	f.db.query("DELETE FROM work_completion_records WHERE item = 'W1'").run();
	f.db
		.query(
			"INSERT INTO work_completion_records VALUES ('project', 'W1', ?, 'author')",
		)
		.run(context.commit);
	publishReviewReceipt(f.db, "project", "W1", {
		...f.receipt,
		commit: context.commit,
		base: context.base,
		instructions: context.instructions,
	});
	f.git("merge", "--ff-only", f.context.commit);
	expect(f.check()).toMatchObject({ ok: true });
});

test("equivalent merge commit of a candidate ancestor preserves the reviewed tree", () => {
	const f = fixture();
	f.git("checkout", "suspenders/W1");
	writeFileSync(
		join(f.repo, "packages/app/extra.ts"),
		"export const extra = 1;\n",
	);
	f.git("add", ".");
	f.git("commit", "-m", "second candidate commit");
	f.git("checkout", "main");
	const context = reviewContext(f.repo, "suspenders/W1");
	f.db
		.query("UPDATE work_items SET result_sha = ? WHERE id = 'W1'")
		.run(context.commit);
	f.db.query("DELETE FROM work_completion_records WHERE item = 'W1'").run();
	f.db
		.query(
			"INSERT INTO work_completion_records VALUES ('project', 'W1', ?, 'author')",
		)
		.run(context.commit);
	publishReviewReceipt(f.db, "project", "W1", {
		...f.receipt,
		commit: context.commit,
		base: context.base,
		instructions: context.instructions,
	});
	f.git("merge", "--no-ff", "-m", "integrate ancestor", f.context.commit);
	expect(f.check()).toMatchObject({ ok: true });
});

test("overlapping main changes cannot inherit a prior review", () => {
	const f = fixture();
	publishReviewReceipt(f.db, "project", "W1", f.receipt);
	writeFileSync(
		join(f.repo, "packages/app/value.ts"),
		"export const value = 2;\n",
	);
	f.git("add", ".");
	f.git("commit", "-m", "overlapping edit");
	expect(f.check()).toMatchObject({ ok: false });
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

test("instruction reads reject oversized files and symlinks before loading content", () => {
	const f = fixture();
	writeFileSync(join(f.repo, "AGENTS.md"), "x".repeat(131_073));
	f.git("add", ".");
	f.git("commit", "-m", "oversized instructions");
	expect(() => reviewContext(f.repo, "suspenders/W1")).toThrow(
		"bounded context budget",
	);
	rmSync(join(f.repo, "AGENTS.md"));
	symlinkSync("how-to-review.md", join(f.repo, "AGENTS.md"));
	f.git("add", ".");
	f.git("commit", "-m", "instruction symlink");
	expect(() => reviewContext(f.repo, "suspenders/W1")).toThrow("regular file");
});

test("W1243.1.1.1: prose mention of a RESOLVED ID is not blocking", () => {
	// #63141/#63152/#63155/#63159: independent PASS receipts carried the
	// prior blocker ID in narrative prose next to a standalone RESOLVED line,
	// and the parser recorded the mention as a live blocker.
	const { blocking, resolved } = reviewFindingIds(
		[
			"The prior B1-no-coverage-proof is covered by the proved scratch run.",
			"RESOLVED: B1-no-coverage-proof scratch revert failed 9 new test(s).",
			"VERDICT: PASS - clean",
		].join("\n"),
	);
	expect(blocking).toEqual([]);
	expect(resolved).toEqual(["B1-no-coverage-proof"]);
});

test("bullet-form RESOLVED line closes its prior B-ID", () => {
	const result = reviewFindingIds(
		"- RESOLVED: B1-round1-scrubtext-import no residual reference remains.\nVERDICT: PASS",
	);
	expect(result.resolved).toEqual(["B1-round1-scrubtext-import"]);
	expect(result.blocking).toEqual([]);
});

test("W1243.1.1.1: unresolved mention and genuine finding stay fail-closed", () => {
	// a narrative reference without the explicit RESOLVED line still blocks
	const unresolved = reviewFindingIds(
		"The prior B1-no-coverage-proof is covered by the proved scratch run.\n",
	);
	expect(unresolved.blocking).toEqual(["B1-no-coverage-proof"]);
	expect(unresolved.resolved).toEqual([]);
	// a declared finding with no resolution blocks too
	const declared = reviewFindingIds(
		"B2-erase-guard: the retry path drops a prior attempt's blocker.\n",
	);
	expect(declared.blocking).toEqual(["B2-erase-guard"]);
	expect(declared.resolved).toEqual([]);
	// mid-line RESOLVED is not the explicit declaration — stays blocking
	const midline = reviewFindingIds(
		"This is now RESOLVED: B1-no-coverage-proof — proof ran clean.\n",
	);
	expect(midline.blocking).toEqual(["B1-no-coverage-proof"]);
	expect(midline.resolved).toEqual([]);
});
