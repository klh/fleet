// test/claim-location.test.ts — W870: work take provisions the item worktree
// (never treeless claims, path printed) and the location-vs-claim write gate
// refuses main-checkout edits while the session's claim holds a registered
// tree — in-tree, outside-repo, treeless and unbound sessions stay free.
// Isolated temp HOME + real git repo; the gate runs end-to-end via
// `gate.ts pre-files` (governor-leases idiom, payload via temp file).
import { expect, test } from "./pw";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-claimloc-home-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-claimloc-repo-"));
mkdirSync(join(REPO, "sub"), { recursive: true });
const env = { ...process.env, HOME, KLH_SESSION_ROLE: "lane" };
const HOOKS = join(import.meta.dir, "..", "hooks");
const BIN = join(HOOKS, "bin");

test.afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

const run = (
	bin: string,
	...args: string[]
): { out: string; err: string; code: number } => {
	const p = Bun.spawnSync(["bun", join(BIN, bin), ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		out: p.stdout.toString(),
		err: p.stderr.toString(),
		code: p.exitCode,
	};
};
const work = (...args: string[]) => run("work.ts", ...args);

const gitC = (args: string[]): { out: string; code: number } => {
	const p = Bun.spawnSync(["git", "-C", REPO, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString().trim(), code: p.exitCode };
};
const gitOK = (args: string[]): string => {
	const r = gitC(args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return r.out;
};

// seed: the fixture repo needs to BE a repo, with a commit for worktree add
Bun.spawnSync(["git", "init", "-q", REPO], {
	stdout: "ignore",
	stderr: "ignore",
});
writeFileSync(join(REPO, "README.md"), "x");
gitOK(["add", "-A"]);
gitOK(["commit", "-q", "-m", "init", "--allow-empty"]);

let payloadN = 0;
function gate(
	hook: Record<string, unknown>,
	envOverride: Record<string, string> = {},
): { out: string } {
	// Bun 1.4 spawnSync drops the input option — payloads go via a temp file
	const payload = join(HOME, `hook-payload-${payloadN++}.json`);
	writeFileSync(payload, JSON.stringify(hook));
	const p = Bun.spawnSync(["bun", join(HOOKS, "gate.ts"), "pre-files"], {
		cwd: REPO,
		env: { ...env, ...envOverride },
		stdin: Bun.file(payload),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: p.stdout.toString() };
}
const writeHook = (
	session: string,
	tp: string,
	file: string,
): Record<string, unknown> => ({
	tool_name: "Write",
	tool_input: { file_path: join(REPO, file) },
	cwd: REPO,
	session_id: session,
	transcript_path: tp,
});
const TP = join(HOME, "transcripts");

const idOf = (r: { out: string }): string =>
	(r.out.match(/W\d+/) ?? [])[0] ?? "";

expect(
	run("coord.ts", "bootstrap", "--as", "loc-a", "--role", "worker").code,
).toBe(0);
expect(
	run("coord.ts", "bootstrap", "--as", "loc-b", "--role", "worker").code,
).toBe(0);

const addedA = work("add", "claim-location fixture A");
const idA = idOf(addedA);
expect(idA).toBeTruthy();

test.describe("W870 take provisioning", () => {
	test("take mints the item tree and prints its path", () => {
		const t = work("take", idA, "--as", "loc-a");
		expect(t.code).toBe(0);
		// the printed path is the registry's canonical form (/private/var ...)
		expect(t.out).toContain(
			`worktree: ${realpathSync(REPO)}/.worktrees/${idA}`,
		);
		expect(existsSync(join(REPO, ".worktrees", idA))).toBe(true);
		expect(
			gitC(["-C", join(REPO, ".worktrees", idA), "branch", "--show-current"])
				.out,
		).toBe(`suspenders/${idA}`);
	});

	test("location-vs-claim: main-edit denies; in-tree, outside-repo and unbound pass", () => {
		// main-checkout edit from the claim holder → denied with the tree named
		const denied = gate(writeHook("loc-a", TP, "main-edit.ts"));
		expect(denied.out).toContain("CLAIM-LOCATION");
		expect(denied.out).toContain(".worktrees");
		// the same session inside its own tree → allowed
		expect(
			gate(writeHook("loc-a", TP, join(".worktrees", idA, "tree-edit.ts"))).out,
		).toBe("{}");
		// outside the repo entirely → not this gate's business
		expect(
			gate({
				tool_name: "Write",
				tool_input: { file_path: join(HOME, "elsewhere.ts") },
				cwd: REPO,
				session_id: "loc-a",
				transcript_path: TP,
			}).out,
		).toBe("{}");
		// a session without a claim → unbound, main-checkout writes pass
		expect(gate(writeHook("loc-b", TP, "other-main-edit.ts")).out).toBe("{}");
	});

	test("native child cannot write through its parent's claim", () => {
		const childTp = join(HOME, "p", "loc-a", "subagents", "s1.jsonl");
		const childWrite = (file: string) =>
			gate(writeHook("loc-a", childTp, file));
		// Claude gives the child the parent's session_id. Its transcript supplies
		// the separate child identity used by SessionStart and the work graph.
		expect(
			childWrite(join(".worktrees", idA, "parent-tree-edit.ts")).out,
		).toContain("CLAIM-LOCATION");
		expect(childWrite("child-main-edit.ts").out).toContain("CLAIM-LOCATION");
		expect(
			gate(writeHook("loc-a#s1", TP, "child-explicit-sid-edit.ts")).out,
		).toContain("CLAIM-LOCATION");
		// The parent's claim remains valid; the child denial must not revoke it.
		expect(
			gate(writeHook("loc-a", TP, join(".worktrees", idA, "parent-edit.ts")))
				.out,
		).toBe("{}");

		expect(
			run(
				"coord.ts",
				"bootstrap",
				"--as",
				"loc-a#s1",
				"--role",
				"worker",
				"--parent",
				"loc-a",
			).code,
		).toBe(0);
		const idC = idOf(work("add", "claim-location fixture child"));
		expect(idC).toBeTruthy();
		expect(work("take", idC, "--as", "loc-a#s1").code).toBe(0);
		expect(childWrite(join(".worktrees", idC, "own-tree-edit.ts")).out).toBe(
			"{}",
		);
		expect(
			childWrite(join(".worktrees", idA, "parent-tree-again.ts")).out,
		).toContain("CLAIM-LOCATION");
		rmSync(join(REPO, ".worktrees", idC), { recursive: true, force: true });
		gitOK(["worktree", "prune"]);
		expect(childWrite("child-treeless-edit.ts").out).toContain(
			"no provisioned worktree",
		);
	});

	test("fail-open: a treeless claim binds nothing", () => {
		const idB = idOf(work("add", "claim-location fixture B"));
		expect(idB).toBeTruthy();
		expect(work("take", idB, "--as", "loc-b").code).toBe(0);
		// strip the tree: rm + registry prune → resolveItemWorktree null
		rmSync(join(REPO, ".worktrees", idB), { recursive: true, force: true });
		gitOK(["worktree", "prune"]);
		expect(gate(writeHook("loc-b", TP, "treeless-edit.ts")).out).toBe("{}");
	});

	test("registry outage denies native child writes but leaves parent fail-open", () => {
		const brokenHome = mkdtempSync(
			join(tmpdir(), "suspenders-broken-registry-"),
		);
		try {
			const reg = join(brokenHome, ".cache", "claude-governor");
			mkdirSync(join(reg, "governor.db"), { recursive: true });
			const override = { HOME: brokenHome };
			const childTp = join(HOME, "p", "loc-a", "subagents", "s1.jsonl");
			expect(
				gate(writeHook("loc-a", childTp, "registry-outage-child.ts"), override)
					.out,
			).toContain("CLAIM-LOCATION");
			expect(
				gate(writeHook("loc-a", TP, "registry-outage-parent.ts"), override).out,
			).toBe("{}");
			// Scratch outside a Git project is not a Work Graph edit.
			expect(
				gate(
					{
						tool_name: "Write",
						tool_input: { file_path: join(HOME, "child-scratch.txt") },
						cwd: REPO,
						session_id: "loc-a",
						transcript_path: childTp,
					},
					override,
				).out,
			).toBe("{}");
		} finally {
			rmSync(brokenHome, { recursive: true, force: true });
		}
	});

	test("re-take after release attaches the standing tree", () => {
		expect(work("release", idA, "--as", "loc-a").code).toBe(0);
		const t2 = work("take", idA, "--as", "loc-a");
		expect(t2.code).toBe(0);
		expect(t2.out).toContain("(attached)");
		expect(existsSync(join(REPO, ".worktrees", idA))).toBe(true);
	});
});
