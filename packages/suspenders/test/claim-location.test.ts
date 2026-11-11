// test/claim-location.test.ts — W870: work take provisions the item worktree
// (never treeless claims, path printed) and the location-vs-claim write gate
// refuses main-checkout edits while the session's claim holds a registered
// tree — in-tree, outside-repo, treeless and unbound sessions stay free.
// Isolated temp HOME + real git repo; the gate runs end-to-end via
// `gate.ts pre-files` (governor-leases idiom, payload via temp file).
import { afterAll, describe, expect, test } from "bun:test";
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

afterAll(() => {
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

describe("W870 take provisioning", () => {
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

	test("kept split child rides its SHATTERED parent's registered tree (W3008)", () => {
		// split --keep 1 transfers the claim to the kept child WITHOUT minting
		// a child tree: the child keeps editing the parent's registered tree.
		const idP = idOf(work("add", "claim-location fixture P"));
		expect(idP).toBeTruthy();
		expect(work("take", idP, "--as", "loc-a").code).toBe(0);
		const sp = work(
			"split",
			idP,
			"P kept child",
			"P other child",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		);
		expect(sp.code).toBe(0);
		// first minted child = the kept child (keep=1)
		const idKept = (sp.out.match(/W\d+\.\d+/) ?? [])[0] ?? "";
		expect(idKept).toBeTruthy();
		// no child tree is minted — the direct lookup misses
		expect(existsSync(join(REPO, ".worktrees", idKept))).toBe(false);
		// an edit inside the parent tree is the kept child's own bound tree
		expect(
			gate(writeHook("loc-a", TP, join(".worktrees", idP, "kept-edit.ts"))).out,
		).toBe("{}");
		// main-checkout edits deny naming the tree the claim actually rides
		const denied = gate(writeHook("loc-a", TP, "kept-main-edit.ts"));
		expect(denied.out).toContain("CLAIM-LOCATION");
		expect(denied.out).toContain(join(".worktrees", idP));
	});

	test("fallback is graph-verified: a non-SHATTERED parent binds nothing (W3008)", () => {
		// parent-linked child under a READY parent (never shattered): the
		// fallback must stay exact/conventional/SHATTERED-ancestor — never a
		// blind suffix walk that binds a foreign tree
		const idG = idOf(work("add", "claim-location fixture G"));
		expect(idG).toBeTruthy();
		const c = work("add", "guard child", "--parent", idG);
		expect(c.code).toBe(0);
		const idGC = (c.out.match(/W\d+\.\d+/) ?? [])[0] ?? "";
		expect(idGC).toBeTruthy();
		expect(work("take", idGC, "--as", "loc-b").code).toBe(0);
		rmSync(join(REPO, ".worktrees", idGC), { recursive: true, force: true });
		gitOK(["worktree", "prune"]);
		// READY parent → no fallback → the legacy treeless fail-open holds
		expect(gate(writeHook("loc-b", TP, "guard-main-edit.ts")).out).toBe("{}");
	});

	test("chained splits walk up the SHATTERED chain to the standing tree (W3008)", () => {
		const idQ = idOf(work("add", "claim-location fixture Q"));
		expect(idQ).toBeTruthy();
		expect(work("take", idQ, "--as", "loc-a").code).toBe(0);
		const s1 = work(
			"split",
			idQ,
			"Q kept child",
			"Q other child",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		);
		expect(s1.code).toBe(0);
		const idK1 = (s1.out.match(/W\d+\.\d+/) ?? [])[0] ?? "";
		expect(idK1).toBeTruthy();
		const s2 = work(
			"split",
			idK1,
			"Q kept grandchild",
			"Q other grandchild",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		);
		expect(s2.code).toBe(0);
		// the header names the dotted parent — the kept grandchild is the
		// first THREE-segment id in the output
		const idK2 = (s2.out.match(/W\d+\.\d+\.\d+/) ?? [])[0] ?? "";
		expect(idK2).toBeTruthy();
		// W<q>.1 has no tree; the kept grandchild rides .worktrees/<q>
		expect(
			gate(writeHook("loc-a", TP, join(".worktrees", idQ, "gk-edit.ts"))).out,
		).toBe("{}");
		const denied = gate(writeHook("loc-a", TP, "gk-main-edit.ts"));
		expect(denied.out).toContain("CLAIM-LOCATION");
		expect(denied.out).toContain(join(".worktrees", idQ));
	});

	test("fallback needs the kept-child owner binding: foreign SHATTERED ancestor binds nothing (W3009)", () => {
		// reviewer repro: a child claimed by a DIFFERENT lane under a SHATTERED
		// foreign-owned parent must not inherit that lane's tree
		expect(
			run("coord.ts", "bootstrap", "--as", "loc-c", "--role", "worker").code,
		).toBe(0);
		const idF = idOf(work("add", "claim-location fixture F"));
		expect(idF).toBeTruthy();
		expect(work("take", idF, "--as", "loc-a").code).toBe(0);
		const sf = work(
			"split",
			idF,
			"F kept child",
			"F loose child",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		);
		expect(sf.code).toBe(0);
		const idLoose = (sf.out.match(/W\d+\.\d+/g) ?? [])[1] ?? "";
		expect(idLoose).toBeTruthy();
		// the claim belongs to the CHILD session — the reviewer repro shape
		expect(
			run(
				"coord.ts",
				"bootstrap",
				"--as",
				"loc-c#s1",
				"--role",
				"worker",
				"--parent",
				"loc-c",
			).code,
		).toBe(0);
		expect(work("take", idLoose, "--as", "loc-c#s1").code).toBe(0);
		rmSync(join(REPO, ".worktrees", idLoose), { recursive: true, force: true });
		gitOK(["worktree", "prune"]);
		// native child: foreign SHATTERED ancestor + no own tree → the
		// no-provisioned-worktree BLOCK survives even inside the parent's tree
		const childTp = join(HOME, "p", "loc-c", "subagents", "s1.jsonl");
		expect(
			gate(
				writeHook(
					"loc-c",
					childTp,
					join(".worktrees", idF, "foreign-tree-edit.ts"),
				),
			).out,
		).toContain("no provisioned worktree");
		// parent-session contract unchanged: a non-kept child that lost its own
		// tree under the same foreign SHATTERED parent binds nothing → the
		// legacy treeless fail-open holds, no foreign-tree binding
		expect(
			run("coord.ts", "bootstrap", "--as", "loc-d", "--role", "worker").code,
		).toBe(0);
		const c2 = work("add", "loose grandchild", "--parent", idF);
		expect(c2.code).toBe(0);
		const idL2 = (c2.out.match(/W\d+\.\d+/g) ?? [])[0] ?? "";
		expect(idL2).toBeTruthy();
		expect(work("take", idL2, "--as", "loc-d").code).toBe(0);
		rmSync(join(REPO, ".worktrees", idL2), { recursive: true, force: true });
		gitOK(["worktree", "prune"]);
		expect(
			gate(writeHook("loc-d", TP, join(".worktrees", idF, "foreign-parent.ts")))
				.out,
		).toBe("{}");
	});

	test("exact kept binding: same-owner non-kept child never inherits the ancestor tree (W3009 round-2)", () => {
		// root B review repro: ONE same lane takes W1, split --keep 1, release
		// kept child, take NON-kept child, prune own tree — owner-equality on
		// the graph row is not kept-proof; the rebound lane-context names the
		// kept child, so the ancestor tree stays foreign to the sibling claim
		const idR = idOf(work("add", "claim-location fixture R"));
		expect(idR).toBeTruthy();
		expect(
			run("coord.ts", "bootstrap", "--as", "loc-e", "--role", "worker").code,
		).toBe(0);
		expect(
			run(
				"coord.ts",
				"bootstrap",
				"--as",
				"loc-e#s1",
				"--role",
				"worker",
				"--parent",
				"loc-e",
			).code,
		).toBe(0);
		expect(work("take", idR, "--as", "loc-e#s1").code).toBe(0);
		const sr = work(
			"split",
			idR,
			"R kept child",
			"R non-kept child",
			"--reason",
			"independent-scopes",
			"--keep",
			"1",
		);
		expect(sr.code).toBe(0);
		const rk = (sr.out.match(/W\d+\.\d+/g) ?? [])[0] ?? "";
		const rn = (sr.out.match(/W\d+\.\d+/g) ?? [])[1] ?? "";
		expect(rk && rn).toBeTruthy();
		// release the kept child; the rebound context still names it, so the
		// ancestor tree binds nothing for the sibling claim
		expect(work("release", rk, "--as", "loc-e#s1").code).toBe(0);
		expect(work("take", rn, "--as", "loc-e#s1").code).toBe(0);
		rmSync(join(REPO, ".worktrees", rn), { recursive: true, force: true });
		gitOK(["worktree", "prune"]);
		const tpE = join(HOME, "p", "loc-e", "subagents", "s1.jsonl");
		expect(
			gate(
				writeHook("loc-e", tpE, join(".worktrees", idR, "same-owner-edit.ts")),
			).out,
		).toContain("no provisioned worktree");
	});

	test("split from the carrier tree binds the kept child for the next edit (W3009 round-4)", () => {
		const idS = idOf(work("add", "claim-location fixture S"));
		expect(idS).toBeTruthy();
		expect(work("take", idS, "--as", "loc-a").code).toBe(0);
		const tree = join(REPO, ".worktrees", idS);
		// the split runs FROM the registered carrier tree (cwd == carrier)
		const sp = Bun.spawnSync(
			[
				"bun",
				join(BIN, "work.ts"),
				"split",
				idS,
				"S kept child",
				"S other child",
				"--reason",
				"independent-scopes",
				"--keep",
				"1",
			],
			{ cwd: tree, env, stdout: "pipe", stderr: "pipe" },
		);
		expect(sp.exitCode).toBe(0);
		// the minted binding names (loc-a, kept child) — a kept-child edit
		// inside the carrier tree now binds (pre-round-4 it stayed denied)
		expect(
			gate(writeHook("loc-a", TP, join(".worktrees", idS, "cs-edit.ts"))).out,
		).toBe("{}");
		// main-checkout edits still deny, naming the carrier tree
		const denied = gate(writeHook("loc-a", TP, "carrier-main-edit.ts"));
		expect(denied.out).toContain("CLAIM-LOCATION");
		expect(denied.out).toContain(join(".worktrees", idS));
		// the shared REPO outlives this test — no minted context leaks
		rmSync(join(tree, ".fleet"), { recursive: true, force: true });
	});
});
