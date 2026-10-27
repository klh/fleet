// W1216.2.1 — structural relocation proof for the merge guard. Names and
// multisets are not body/assertion proof: every negative here is an actual
// isolated git fixture, every positive is proven against the real W1216
// content (30 tests / 146 expect() sites; the 378 runtime assertions ride the
// matchers, not the source count).
import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guardedMerge } from "../hooks/lib/fleet-loop/merge-guard.ts";
import {
	TEST_FILE,
	testEvidence,
	testRelocationDelta,
} from "../hooks/lib/fleet-loop/merge-guard-relocation.ts";

const repos: string[] = [];
const git = (repo: string, ...args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: p.exitCode,
		out: p.stdout.toString().trim(),
		err: p.stderr.toString(),
	};
};
const expectLine = (n: number): string =>
	`\texpect(a${String(n)}).toBe(${String(n)});\n`;
/** A test() call with `bodies` assertion lines. */
const testLine = (name: string, bodies = 1): string =>
	`test(${JSON.stringify(name)}, () => {\n${Array.from(
		{ length: bodies },
		(_, i) => expectLine(i),
	).join("")}});\n`;
const TESTDIR = "packages/suspenders/test";
const dirOf = (repo: string) => join(repo, TESTDIR);

/** Base repo at `beforeContent` with the given test files. */
function fixture(files: Record<string, string>): {
	repo: string;
	before: string;
} {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "fleet-reloc-")));
	repos.push(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.invalid");
	mkdirSync(dirOf(repo), { recursive: true });
	writeFileSync(join(repo, "base.ts"), "export const base = 1;\n");
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, name)), { recursive: true });
		writeFileSync(join(repo, name), content);
	}
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "base");
	return { repo, before: git(repo, "rev-parse", "HEAD").out };
}

/** Lane-side tree from a mutate callback over the worktree copy. */
function lane(repo: string, mutate: (repo: string) => void): string {
	git(repo, "checkout", "-b", "suspenders/GUARD");
	mutate(repo);
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "lane");
	return git(repo, "rev-parse", "HEAD").out;
}

afterEach(() => {
	for (const repo of repos.splice(0))
		rmSync(repo, { recursive: true, force: true });
});

test("TEST_FILE still matches the completion suites", () => {
	expect(TEST_FILE.test("work-completion-record.test.ts")).toBe(true);
	expect(TEST_FILE.test("src/lib.ts")).toBe(false);
});

test("verbatim move to a sibling with reindentation is proven", () => {
	const a = testLine("alpha", 3);
	const b = testLine("beta", 3);
	const { repo, before } = fixture({
		[`${TESTDIR}/split.test.ts`]: a + b,
	});
	const head = lane(repo, (r) => {
		// move beta out, deeper-indented (as a describe body would be)
		writeFileSync(
			join(r, TESTDIR, "split.test.ts"),
			a.replace("expect", "expect"),
		);
		writeFileSync(
			join(r, TESTDIR, "sibling.test.ts"),
			`describe("s", () => {\n\t${b.replaceAll("\n", "\n\t")}});\n`,
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(true);
});

test("B1 bypass rejected: same names with emptied callbacks after mass assertion erasure", () => {
	const names = ["erode-a", "erode-b", "erode-c", "erode-d", "erode-e"];
	const fat = names.map((n) => testLine(n, 50)).join(""); // 250 expects
	const { repo, before } = fixture({
		[`${TESTDIR}/erode.test.ts`]: fat,
	});
	const head = lane(repo, (r) => {
		writeFileSync(
			join(r, TESTDIR, "erode.test.ts"),
			names.map((n) => `test(${JSON.stringify(n)}, () => {});\n`).join(""),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("not relocated verbatim");
	expect(testEvidence(fat)).toEqual({ tests: 5, expects: 250 });
});

test("weakened callback rejected: assertions dropped from a kept name", () => {
	const { repo, before } = fixture({
		[`${TESTDIR}/w.test.ts`]: testLine("kept", 4),
	});
	const head = lane(repo, (r) => {
		writeFileSync(
			join(r, TESTDIR, "w.test.ts"),
			testLine("kept", 2), // same name, half the assertions
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("not relocated verbatim");
});

test("assertions hidden in a comment or dead code are not relocation", () => {
	const { repo, before } = fixture({
		[`${TESTDIR}/d.test.ts`]: testLine("dead", 3),
	});
	const head = lane(repo, (r) => {
		writeFileSync(
			join(r, TESTDIR, "d.test.ts"),
			[
				`test(${JSON.stringify("dead")}, () => {`,
				"\t// expect(a0).toBe(0);",
				"\tif (false) expect(a1).toBe(1);",
				"\texpect(a2).toBe(2);",
				"});",
				"",
			].join("\n"),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("not relocated verbatim");
});

test("renamed test fails closed: old name unrelocated, new name unrelated", () => {
	const { repo, before } = fixture({
		[`${TESTDIR}/n.test.ts`]: testLine("old-name", 2) + testLine("kept", 2),
	});
	const head = lane(repo, (r) => {
		writeFileSync(
			join(r, TESTDIR, "n.test.ts"),
			testLine("kept", 2) + testLine("new-name", 2),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("not relocated verbatim");
	expect(r.why).toContain("unrelated addition");
});

test("unrelated new test alongside a real move fails closed", () => {
	const a = testLine("a", 2);
	const b = testLine("b", 2);
	const { repo, before } = fixture({
		[`${TESTDIR}/m.test.ts`]: a + b,
	});
	const head = lane(repo, (r) => {
		writeFileSync(join(r, TESTDIR, "m.test.ts"), a);
		writeFileSync(
			join(r, TESTDIR, "sibling.test.ts"),
			b + testLine("extra", 2),
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("unrelated addition");
});

test("dynamic test name is unprovable and fails closed", () => {
	const { repo, before } = fixture({
		[`${TESTDIR}/dyn.test.ts`]: testLine("static", 2),
	});
	const head = lane(repo, (r) => {
		writeFileSync(
			join(r, TESTDIR, "dyn.test.ts"),
			"const n = runtimeName();\n" +
				"test(n, () => {\n\texpect(a0).toBe(0);\n});\n",
		);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("unprovable test structure");
});

test("helper evidence erosion: modifying a shared fixture helper fails closed", () => {
	const helper = `export const shared = { deep: { value: 1 } };\n`;
	const a = testLine("alpha", 30);
	const b = testLine("beta", 30);
	const { repo, before } = fixture({
		[`${TESTDIR}/h.test.ts`]: a + b,
		[`${TESTDIR}/helpers/fixtures.ts`]: helper,
	});
	const head = lane(repo, (r) => {
		// bodies relocate verbatim, but the shared helper is quietly weakened
		writeFileSync(
			join(r, TESTDIR, "helpers/fixtures.ts"),
			`export const shared = { deep: { value: 2 } };\n`,
		);
		writeFileSync(join(r, TESTDIR, "h.test.ts"), a);
		writeFileSync(join(r, TESTDIR, "sibling.test.ts"), b);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("helper evidence eroded");
});

test("helper evidence erosion: deleting a shared fixture helper fails closed", () => {
	const a = testLine("alpha", 30);
	const b = testLine("beta", 30);
	const helper = "export const shared = 1;\n";
	const { repo, before } = fixture({
		[`${TESTDIR}/h.test.ts`]: a + b,
		[`${TESTDIR}/helpers/fixtures.ts`]: helper,
	});
	const head = lane(repo, (r) => {
		rmSync(join(r, TESTDIR, "helpers/fixtures.ts"));
		writeFileSync(join(r, TESTDIR, "h.test.ts"), a);
		writeFileSync(join(r, TESTDIR, "sibling.test.ts"), b);
	});
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("helper evidence eroded");
});

test("helper pure rename (R100) is allowed; a weakened rename is not", () => {
	const a = testLine("alpha", 30);
	const b = testLine("beta", 30);
	const helper = "export const shared = 1;\nexport const other = 2;\n";
	const { repo, before } = fixture({
		[`${TESTDIR}/h.test.ts`]: a + b,
		[`${TESTDIR}/helpers/fixtures.ts`]: helper,
	});
	// pure rename: bodies move, helper renamed verbatim
	const moved = lane(repo, (r) => {
		writeFileSync(join(r, TESTDIR, "h.test.ts"), a);
		writeFileSync(
			join(r, TESTDIR, "sibling.test.ts"),
			`describe("s", () => {\n\t${b.replaceAll("\n", "\n\t")}});\n`,
		);
		git(
			r,
			"mv",
			join(TESTDIR, "helpers/fixtures.ts"),
			join(TESTDIR, "helpers/fixtures2.ts"),
		);
	});
	expect(testRelocationDelta(repo, before, moved).balanced).toBe(true);
	// weakened rename: same move, helper edited in the same candidate
	git(repo, "checkout", "-q", "main");
	const weakened = lane(repo, (r) => {
		writeFileSync(join(r, TESTDIR, "h.test.ts"), a);
		writeFileSync(
			join(r, TESTDIR, "sibling.test.ts"),
			`describe("s", () => {\n\t${b.replaceAll("\n", "\n\t")}});\n`,
		);
		rmSync(join(r, TESTDIR, "helpers/fixtures.ts"));
		writeFileSync(
			join(r, TESTDIR, "helpers/fixtures2.ts"),
			"export const shared = 999;\nexport const other = 2;\n",
		);
	});
	const r = testRelocationDelta(repo, before, weakened);
	expect(r.balanced).toBe(false);
	expect(r.why).toContain("helper evidence eroded");
});

test("POSITIVE against the actual W1216 split: 30 tests preserved verbatim", () => {
	// The real decomposition (282bfc7e): the 1340-line monolith moved
	// verbatim into 4 per-subject suites + a shared fixture helper. Prove the
	// actual blobs balance and keep their 30 tests / 146 expect() sites.
	// (The W1216 runtime claim of 378 assertions rides matchers executed in
	// loops — the structural proof preserves the source evidence.)
	const base = "282bfc7e";
	const monolith = git(
		".",
		"show",
		`${base}^:${TESTDIR}/work-completion-record.test.ts`,
	);
	if (monolith.code !== 0) return; // blobs unavailable outside a fleet clone
	const suiteFiles = [
		"work-completion-record.test.ts",
		"work-completion-cross-repo.test.ts",
		"work-completion-split-context.test.ts",
		"work-completion-claim-context.test.ts",
	];
	const helperPath = `${TESTDIR}/helpers/work-completion-fixtures.ts`;
	const { repo, before } = fixture({
		[`${TESTDIR}/work-completion-record.test.ts`]: monolith.out,
	});
	const head = lane(repo, (r) => {
		for (const f of suiteFiles)
			writeFileSync(
				join(r, TESTDIR, f),
				git(".", "show", `${base}:${TESTDIR}/${f}`).out,
			);
		mkdirSync(join(r, TESTDIR, "helpers"), { recursive: true });
		writeFileSync(
			join(r, helperPath),
			git(".", "show", `${base}:${helperPath}`).out,
		);
	});
	const beforeEvidence = testEvidence(monolith.out);
	expect(beforeEvidence.tests).toBe(30);
	expect(beforeEvidence.expects).toBe(146);
	const afterEvidence = suiteFiles.reduce(
		(acc, f) => {
			const ev = testEvidence(git(".", "show", `${base}:${TESTDIR}/${f}`).out);
			return { tests: acc.tests + ev.tests, expects: acc.expects + ev.expects };
		},
		{ tests: 0, expects: 0 },
	);
	expect(afterEvidence).toEqual({ tests: 30, expects: 146 });
	const r = testRelocationDelta(repo, before, head);
	expect(r.balanced).toBe(true);
	expect(r.evidence).toContain("30 test bodies preserved verbatim");
});

test("guard integration: eroded relocation rejects the candidate merge", () => {
	const names = ["erode-a", "erode-b", "erode-c", "erode-d", "erode-e"];
	const fat = names.map((n) => testLine(n, 50)).join(""); // 250 lines
	const { repo, before } = fixture({
		[`${TESTDIR}/erode.test.ts`]: fat,
	});
	lane(repo, (r) => {
		writeFileSync(
			join(r, TESTDIR, "erode.test.ts"),
			names.map((n) => `test(${JSON.stringify(n)}, () => {});\n`).join(""),
		);
	});
	// the guard resolves `before` from HEAD — it must merge INTO main
	git(repo, "checkout", "-q", "main");
	const result = guardedMerge({
		repo,
		callerRepo: repo,
		branch: "suspenders/GUARD",
		timeoutMs: 20_000,
	});
	expect(result.code).toBe(1);
	expect(result.tail).toContain("test relocation unproven");
	expect(result.tail).toContain("not relocated verbatim");
	expect(git(repo, "rev-parse", "HEAD").out).toBe(before);
});

test("guard integration: proven relocation publishes the candidate merge", () => {
	const names = ["erode-a", "erode-b", "erode-c", "erode-d", "erode-e"];
	const fat = names.map((n) => testLine(n, 50)).join("");
	const { repo, before } = fixture({
		[`${TESTDIR}/erode.test.ts`]: fat,
	});
	lane(repo, (r) => {
		// 4 of 5 tests move verbatim to a sibling; the source file shrinks
		// past the erosion ratio with only the header + 1 test left.
		const kept = names.at(0) ?? "erode-a";
		writeFileSync(join(r, TESTDIR, "erode.test.ts"), testLine(kept, 50));
		writeFileSync(
			join(r, TESTDIR, "sibling.test.ts"),
			names
				.slice(1)
				.map((n) => testLine(n, 50))
				.join(""),
		);
	});
	// the guard resolves `before` from HEAD — it must merge INTO main
	git(repo, "checkout", "-q", "main");
	const result = guardedMerge({
		repo,
		callerRepo: repo,
		branch: "suspenders/GUARD",
		timeoutMs: 20_000,
	});
	expect(result.code).toBe(0);
	expect(git(repo, "rev-parse", "HEAD").out).not.toBe(before);
	expect(git(repo, "branch", "--list", "suspenders/GUARD").out).not.toBe("");
});
