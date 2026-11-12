// w2940-post-qlty-attestation.e2e.ts — W2940/W2947: a PASS review receipt
// bound to the branch head must never authorize publishing bytes the
// merge-time qlty autofix changed. The published candidate is the reviewed
// bytes exactly when its TREE equals the merge-tree preview of integration
// HEAD × the branch. Covers the helper predicates, the guardedMerge
// plumbing (candidate sha + TREE ride the final review), and the fail-closed
// refusal: a drifted candidate fails publication with HEAD unmoved, keyed
// to the deterministic branch-side repair (apply the fix on the branch,
// re-complete — one fresh review of the normalized bytes, never a
// duplicate review of unchanged bytes).
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchWorld, type ScratchWorld } from "@klh/test-kit";
import {
	QLTY_ATTESTATION_MARK,
	postQltyAttestation,
} from "../hooks/lib/fleet-loop/merge-attestation.ts";
import { guardedMerge } from "../hooks/lib/fleet-loop/merge-guard.ts";
import {
	checkReviewReceipt,
	publishReviewReceipt,
	type ReviewReceipt,
	reviewContext,
} from "../hooks/lib/gates/review-receipt.ts";
import { openMemoryStore } from "../hooks/lib/govdb/govdb-store.ts";

// Real git fixture: main + suspenders/W1 with a one-file candidate; a memory
// store carrying the completion author + a bound PASS receipt.
const fixture = () => {
	const w: ScratchWorld = scratchWorld({ prefix: "w2940-" });
	// realpath: guardedMerge requires the caller repo to resolve INSIDE the
	// integration repo; macOS tmpdir is a /var → /private/var symlink.
	const repo = realpathSync(w.repo);
	const git = (...args: string[]): string => {
		const p = Bun.spawnSync(
			[
				"git",
				"-C",
				repo,
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				...args,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		return p.stdout.toString().trim();
	};
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("checkout", "-b", "suspenders/W1");
	mkdirSync(join(repo, "packages/app"), { recursive: true });
	writeFileSync(join(repo, "packages/app/value.ts"), "export const v = 1;\n");
	git("add", ".");
	git("commit", "-m", "implementation");
	git("checkout", "main");
	const db = openMemoryStore();
	db.run("CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT)");
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE work_completion_records (project TEXT, item TEXT, commit_sha TEXT, completed_by TEXT)",
	);
	for (const sid of ["author", "reviewer"])
		db.query("INSERT INTO sessions VALUES (?, 'project')").run(sid);
	const context = reviewContext(repo, "suspenders/W1");
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
		evidence: "Read full diff; value check passed.",
	};
	publishReviewReceipt(db, "project", "W1", receipt);
	// The production verifyReview mirror: exact bytes + exact receipt.
	const verifyReview = (
		candidate?: string,
		candidateTree?: string,
	): { ok: boolean; why: string } => {
		if (candidate) {
			const attest = postQltyAttestation({
				repo,
				branch: "suspenders/W1",
				candidateTree,
			});
			if (!attest.ok) return attest;
		}
		return checkReviewReceipt(db, "project", "W1", context);
	};
	const previewTree = (): string =>
		git("merge-tree", "--write-tree", "HEAD", "suspenders/W1")
			.split("\n")[0]
			.trim();
	return { w, repo, git, db, context, verifyReview, previewTree };
};

// APPEND-TESTS

// a ladder that merges AND edits reviewed bytes in an extra commit — the
// exact shape of the W869 merge-time autofix (the W2940 class: reviewed
// branch, changed published bytes)
const AUTOFIX_LADDER =
	"git merge --no-ff {branch} -m M && printf 'export const fixed = 1;\\n' >> packages/app/value.ts && git add -A && git -c user.name=F -c user.email=f@i commit -m 'merge-time qlty autofix (W869)'";

test.describe("@unit", () => {
	const worlds: ScratchWorld[] = [];
	test.afterEach(() => {
		for (const w of worlds.splice(0)) w.clean();
	});

	test("postQltyAttestation: equal tree attests; drifted tree refuses; missing tree fails closed", () => {
		const f = fixture();
		worlds.push(f.w);
		expect(
			postQltyAttestation({
				repo: f.repo,
				branch: "suspenders/W1",
				candidateTree: f.previewTree(),
			}),
		).toEqual({ ok: true, why: "" });
		const refuse = postQltyAttestation({
			repo: f.repo,
			branch: "suspenders/W1",
			candidateTree: "4444444444444444444444444444444444444444",
		});
		expect(refuse.ok).toBe(false);
		expect(refuse.why).toContain(QLTY_ATTESTATION_MARK);
	});

	test("guardedMerge publishes the reviewed candidate; HEAD attested exact", () => {
		const f = fixture();
		worlds.push(f.w);
		const before = f.git("rev-parse", "HEAD");
		const result = guardedMerge({
			repo: f.repo,
			callerRepo: f.repo,
			branch: "suspenders/W1",
			timeoutMs: 10_000,
			verifyReview: f.verifyReview,
		});
		expect(result.code).toBe(0);
		expect(f.git("rev-parse", "HEAD")).not.toBe(before);
	});

	// The W2940 witness, reproduced: a PASS receipt bound to the branch head
	// plus a ladder that edits reviewed bytes after the merge (the qlty
	// autofix shape) — publication MUST refuse and HEAD MUST stay unmoved.
	test("guardedMerge refuses drifted post-autofix bytes (the W2940 class)", () => {
		const f = fixture();
		worlds.push(f.w);
		const before = f.git("rev-parse", "HEAD");
		const result = guardedMerge({
			repo: f.repo,
			callerRepo: f.repo,
			branch: "suspenders/W1",
			ladder: AUTOFIX_LADDER,
			timeoutMs: 10_000,
			verifyReview: f.verifyReview,
		});
		expect(result.code).toBe(1);
		expect(result.tail).toContain(QLTY_ATTESTATION_MARK);
		expect(f.git("rev-parse", "HEAD")).toBe(before);
	});
});
