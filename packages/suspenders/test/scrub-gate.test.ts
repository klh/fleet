// scrub-gate.test.ts — W236: the scrub gate. Unit legs cover the scanner
// (builtin rules, denylist literal + regex lines, marker escape, redaction,
// the -U0 diff parser); the e2e legs spawn gate.ts pre-bash against a
// scratch repo the way a lane's git commit/push arrives (the harness of
// secrets-gate.test.ts). Skipped legs: none — no external tool needed.
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addedDiffLines,
	findingsText,
	scanLine,
	scrubAddedLines,
	scrubBuffer,
	scrubRules,
	scrubText,
} from "../hooks/lib/scrub.ts";
import { commitRangeFindings, EMPTY_TREE } from "../hooks/lib/scrub-git.ts";

setDefaultTimeout(30_000);

const HOME = mkdtempSync(join(tmpdir(), "scrub-home-"));
const DENYLIST = join(HOME, "scrub-denylist");

// fixture patterns hoisted to const lines so the `scrub:allow` marker rides a
// short line the formatter never wraps (per-line exemption, W236)
const HOME_LEAK = "/Users/kk"; // scrub:allow
const HOME_LEAK_DIR = "/Users/kk/dev"; // scrub:allow
const AWS_EXAMPLE_KEY = "AKIAIOSFODNN7EXAMPLE"; // scrub:allow
const RSA_KEY_HEADER = "-----BEGIN RSA PRIVATE KEY-----"; // scrub:allow
const SLACK_TEST_TOKEN = "xoxb-123456789012-abcdefgh"; // scrub:allow
const IKEA_DOC = "IKEA.Internal Wiki"; // scrub:allow
const REDACTED_HOME = "/Users/k"; // scrub:allow
const EXAMPLE_MAC = "aa:bb:cc:dd:ee:ff"; // scrub:allow
const EXAMPLE_RFC1918 = "10.1.2.3"; // scrub:allow

beforeAll(() => {
	// deterministic denylist: literal host, regex CIDR, literal MAC
	process.env.SUSPENDERS_SCRUB_DENYLIST = DENYLIST;
	writeFileSync(
		DENYLIST,
		[
			"# machine-local real values — never commit",
			"nas-threads.dk",
			"/10\\.0\\.1\\.\\d+/",
			"aabbccddeeff",
			"",
		].join("\n"),
	);
});

// scratch-repo git runner (W734): throws on plumbing failure, returns stdout
const gitIn = (repo: string) => (args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args[0]}: ${p.stderr.toString()}`);
	return p.stdout.toString();
};

describe("scrub lib: builtin rules", () => {
	const line = (s: string) => scanLine(s, scrubRules());
	test("flags each class", () => {
		expect(line(`cd ${HOME_LEAK_DIR}`).map((h) => h.rule)).toEqual([
			"home-path",
		]); // scrub:allow
		expect(line(AWS_EXAMPLE_KEY).map((h) => h.rule)).toEqual(["aws-key"]);
		expect(line(`k=sk-${"a".repeat(26)}`).map((h) => h.rule)).toEqual([
			"sk-key",
		]);
		expect(line(`ghp_${"a".repeat(24)}`).map((h) => h.rule)).toEqual([
			"github-token",
		]);
		expect(line(RSA_KEY_HEADER).map((h) => h.rule)).toEqual(["private-key"]);
		expect(line(SLACK_TEST_TOKEN).map((h) => h.rule)).toEqual(["slack-token"]);
		expect(line(IKEA_DOC).map((h) => h.rule)).toEqual(["ikea-internal"]); // scrub:allow
		expect(line(`MAC ${EXAMPLE_MAC}`).map((h) => h.rule)).toEqual([
			"mac-address",
		]);
		expect(line(`ip ${EXAMPLE_RFC1918}`).map((h) => h.rule)).toEqual([
			"rfc1918",
		]);
	});
});

describe("scrub lib: denylist + marker + redaction", () => {
	const line = (s: string) => scanLine(s, scrubRules());

	test("denylist literal + regex lines fire", () => {
		expect(line("git.nas-threads.dk").map((h) => h.rule)).toEqual([
			"denylist:2",
		]);
		// the rfc1918 builtin fires BESIDE the denylist regex (builtins scan first)
		const overlap = line("ip 10.0.1.23").map((h) => h.rule); // scrub:allow
		expect(overlap).toEqual(["rfc1918", "denylist:3"]);
		expect(line("mac aabbccddeeff").map((h) => h.rule)).toEqual(["denylist:4"]);
	});

	test("marker line is exempt", () => {
		expect(line("/Users/kk/x # scrub:allow")).toEqual([]);
	});

	test("redaction", () => {
		expect(line("AKIAIOSFODNN7EXAMPLE")[0]?.match).toBe("AKIAIOSF…"); // scrub:allow
		expect(line(HOME_LEAK)[0]?.match).toBe(HOME_LEAK);
	});
});

// ─── e2e: gate.ts pre-bash against a scratch repo ───
const REPO = mkdtempSync(join(tmpdir(), "scrub-repo-"));
const env = {
	...process.env,
	HOME,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
const HOOKS = join(import.meta.dir, "..", "hooks");

let n = 0;
function gate(
	command: string,
	extraEnv?: Record<string, string>,
): { out: string; code: number } {
	const payload = join(HOME, `hook-${n++}.json`);
	writeFileSync(
		payload,
		JSON.stringify({
			tool_name: "Bash",
			tool_input: { command },
			cwd: REPO,
			session_id: "s",
			transcript_path: join(HOME, "t.jsonl"),
		}),
	);
	const p = Bun.spawnSync(
		[process.execPath, join(HOOKS, "gate.ts"), "pre-bash"],
		{
			cwd: REPO,
			// spawn-time spread: beforeAll sets SUSPENDERS_SCRUB_DENYLIST on
			// process.env AFTER the module-level const was captured
			env: { ...process.env, HOME, ...extraEnv },
			stdin: Bun.file(payload),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { out: p.stdout.toString(), code: p.exitCode };
}

const sh = (args: string[]) => {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return p;
};

// scratch repo with a clean baseline commit
writeFileSync(join(REPO, "README.md"), "# scrub e2e\n");
sh(["init", "-b", "main"]);
sh(["add", "."]);
sh(["commit", "-m", "baseline"]);

describe("scrub gate e2e (gate.ts pre-bash)", () => {
	test("deny: staged home-path leak names file:line + rule", () => {
		writeFileSync(join(REPO, "leak.md"), `log dir ${HOME_LEAK_DIR}/x\n`);
		sh(["add", "leak.md"]);
		const r = gate("git commit -m x");
		expect(r.out).toContain('"permissionDecision":"deny"');
		expect(r.out).toContain("leak.md:1");
		expect(r.out).toContain("home-path");
	});

	test("allow: marker line escapes", () => {
		sh(["reset"]); // each leg scans ITS OWN staged set
		writeFileSync(join(REPO, "ok.md"), "dir /Users/kk/dev/x # scrub:allow\n");
		sh(["add", "ok.md"]);
		expect(gate("git commit -m ok").out).toBe("{}");
	});

	test("allow: clean staged content", () => {
		sh(["reset"]); // each leg scans ITS OWN staged set
		writeFileSync(join(REPO, "clean.md"), "nothing to scrub here\n");
		sh(["add", "clean.md"]);
		expect(gate("git commit -m c").out).toBe("{}");
	});

	test("push leg: unpushed violation denies", () => {
		sh(["reset"]); // each leg scans ITS OWN delta
		// the setup commit lands directly — setup bypasses the harness
		writeFileSync(join(REPO, "late.md"), "host nas-threads.dk\n");
		sh(["add", "late.md"]);
		sh(["commit", "-m", "late"]);
		sh(["branch", "anchor", "HEAD~1"]);
		sh(["branch", "-u", "anchor", "main"]);
		const r = gate("git push");
		expect(r.out).toContain("late.md:1");
		expect(r.out).toContain("denylist:2");
	});

	test("merge leg: leak the clean auto-commit would land is denied pre-run", () => {
		sh(["checkout", "-b", "mLane"]);
		writeFileSync(join(REPO, "mLeak.md"), `p ${HOME_LEAK_DIR}\n`);
		sh(["add", "mLeak.md"]);
		sh(["commit", "-m", "mLane"]);
		sh(["checkout", "main"]);
		const head = sh(["rev-parse", "HEAD"]).out;
		const r = gate("git merge mLane");
		expect(r.out).toContain('"permissionDecision":"deny"');
		expect(r.out).toContain("mLeak.md:1");
		expect(r.out).toContain("home-path");
		expect(sh(["rev-parse", "HEAD"]).out).toBe(head); // merge never ran
	});

	test("merge leg: ancestor ref and --abort scan clean", () => {
		expect(gate("git merge main").out).toBe("{}"); // ancestor → empty delta
		expect(gate("git merge --abort").out).toBe("{}"); // no merge happens
	});

	test("merge leg: -m message is not mistaken for a ref", () => {
		sh(["checkout", "-b", "mClean"]);
		writeFileSync(join(REPO, "mClean.md"), "harmless content\n");
		sh(["add", "mClean.md"]);
		sh(["commit", "-m", "mClean"]);
		sh(["checkout", "main"]);
		expect(gate('git merge -m "bring it" mClean').out).toBe("{}");
	});
});

describe("scrub gate e2e: W708 range/binary holes", () => {
	test("push leg: first push (no upstream) scans from the default-branch base", () => {
		sh(["reset"]);
		sh(["checkout", "-b", "fresh"]);
		writeFileSync(join(REPO, "fp.md"), `host ${HOME_LEAK_DIR}\n`);
		sh(["add", "fp.md"]);
		sh(["commit", "-m", "fresh"]);
		const r = gate("git push");
		expect(r.out).toContain("fp.md:1");
		expect(r.out).toContain("home-path");
		sh(["checkout", "main"]);
	});

	test("push leg: add-then-remove in the range is caught per-commit", () => {
		sh(["reset"]);
		sh(["checkout", "-b", "atr"]);
		writeFileSync(join(REPO, "atr.md"), `secret ${HOME_LEAK_DIR}\n`);
		sh(["add", "atr.md"]);
		sh(["commit", "-m", "add"]);
		writeFileSync(join(REPO, "atr.md"), "clean now\n");
		sh(["add", "atr.md"]);
		sh(["commit", "-m", "remove"]);
		const r = gate("git push");
		expect(r.out).toContain("atr.md:1");
		sh(["checkout", "main"]);
	});

	test("commit leg: staged binary blob is scanned (W708)", () => {
		sh(["reset"]);
		sh(["checkout", "-q", "main"]);
		writeFileSync(
			join(REPO, "blob.bin"),
			Buffer.from(`data\x00${HOME_LEAK_DIR}\x00end`, "latin1"),
		);
		sh(["add", "blob.bin"]);
		const r = gate("git commit -m bin");
		expect(r.out).toContain("blob.bin:1");
		sh(["reset"]);
	});
});

describe("scrub lib: bounded range walk (glm-5.3 review)", () => {
	test("newest-first cap: commits beyond the cap go unscanned", () => {
		sh(["reset"]);
		sh(["checkout", "-b", "bounded"]);
		for (let i = 0; i < 4; i++) {
			// leaks only in the two OLDEST commits — the cap must skip them
			writeFileSync(
				join(REPO, `b${i}.md`),
				i < 2 ? `dir ${HOME_LEAK_DIR}\n` : "clean\n",
			);
			sh(["add", `b${i}.md`]);
			sh(["commit", "-m", `c${i}`]);
		}
		const head = sh(["rev-parse", "HEAD"]).stdout.toString().trim();
		const found = commitRangeFindings(REPO, EMPTY_TREE, head, 2);
		expect(found).toHaveLength(0);
		// the unbounded (default-cap) walk still catches the skipped leaks
		const full = commitRangeFindings(REPO, EMPTY_TREE, head);
		expect(full.length).toBeGreaterThan(0);
		sh(["checkout", "main"]);
	});
});

describe("scrub lib: W796 tip-forgiveness drift guard", () => {
	test("content drift at tip is never forgiven", () => {
		sh(["reset"]);
		sh(["checkout", "-b", "w796c"]);
		writeFileSync(join(REPO, "drift.md"), `dir ${HOME_LEAK_DIR}\n`);
		sh(["add", "drift.md"]);
		sh(["commit", "-m", "born unmarked"]);
		const head = sh(["rev-parse", "HEAD"]).stdout.toString().trim();
		// tip carries the marker on DIFFERENT content; the born-unmarked
		// line must still flag
		writeFileSync(
			join(REPO, "drift.md"),
			`other ${HOME_LEAK_DIR} // scrub:allow\nand ${HOME_LEAK_DIR}\n`,
		);
		sh(["add", "drift.md"]);
		sh(["commit", "-m", "drift at tip"]);
		const tip = sh(["rev-parse", "HEAD"]).stdout.toString().trim();
		const found = commitRangeFindings(REPO, head, tip);
		expect(found.length).toBeGreaterThan(0);
		sh(["checkout", "main"]);
	});
});

describe("scrub gate e2e: W796 tip forgiveness", () => {
	const MARKED = (dir: string): string => `${dir} // scrub:allow\n`;

	test("push leg: marker added later in-range is forgiven at tip", () => {
		sh(["reset"]);
		sh(["checkout", "-b", "w796a"]);
		writeFileSync(join(REPO, "healed.md"), `dir ${HOME_LEAK_DIR}\n`);
		sh(["add", "healed.md"]);
		sh(["commit", "-m", "born unmarked"]);
		writeFileSync(join(REPO, "healed.md"), MARKED(`dir ${HOME_LEAK_DIR}`));
		sh(["add", "healed.md"]);
		sh(["commit", "-m", "marker added in-range"]);
		expect(gate("git push").out).toBe("{}");
		sh(["checkout", "main"]);
	});

	test("push leg: marker removed again at tip flags once more", () => {
		sh(["reset"]);
		sh(["checkout", "-b", "w796b"]);
		writeFileSync(join(REPO, "unhealed.md"), MARKED(`dir ${HOME_LEAK_DIR}`));
		sh(["add", "unhealed.md"]);
		sh(["commit", "-m", "marked"]);
		expect(gate("git push").out).toBe("{}");
		writeFileSync(join(REPO, "unhealed.md"), `dir ${HOME_LEAK_DIR}\n`);
		sh(["add", "unhealed.md"]);
		sh(["commit", "-m", "marker dropped at tip"]);
		const r = gate("git push");
		expect(r.out).toContain('"permissionDecision":"deny"');
		expect(r.out).toContain("unhealed.md:1");
		sh(["checkout", "main"]);
	});
});

describe("scrub-gate bin: hook push (W708)", () => {
	const hookPush = (refLine: string): { code: number; out: string } => {
		const refFile = join(HOME, `refs-${n++}.txt`);
		writeFileSync(refFile, refLine);
		const p = Bun.spawnSync(
			[process.execPath, join(HOOKS, "bin", "scrub-gate.ts"), "hook", "push"],
			{
				cwd: REPO,
				env: { ...process.env, HOME },
				stdin: Bun.file(refFile),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		return {
			code: p.exitCode ?? 1,
			out: `${p.stdout.toString()}${p.stderr.toString()}`,
		};
	};

	test("zeros remote sha → first-push base scan", () => {
		sh(["checkout", "-q", "fresh"]);
		const tip = sh(["rev-parse", "HEAD"]).stdout.toString().trim();
		const r = hookPush(
			`refs/heads/fresh ${tip} refs/heads/fresh ${"0".repeat(40)}\n`,
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("fp.md:1");
		sh(["checkout", "main"]);
	});

	test("nonzero remote sha → per-commit scan catches add-then-remove", () => {
		sh(["checkout", "-q", "atr"]);
		const tip = sh(["rev-parse", "HEAD"]).stdout.toString().trim();
		const fork = sh(["rev-parse", "main"]).stdout.toString().trim();
		const r = hookPush(`refs/heads/atr ${tip} refs/heads/atr ${fork}\n`);
		expect(r.code).toBe(1);
		expect(r.out).toContain("atr.md:1");
		sh(["checkout", "main"]);
	});

	test("default-branch first push (zeros sha) scans the whole tip", () => {
		sh(["checkout", "-q", "main"]);
		writeFileSync(join(REPO, "mainleak.md"), `dir ${HOME_LEAK_DIR}\n`);
		sh(["add", "mainleak.md"]);
		sh(["commit", "-m", "mainleak"]);
		const tip = sh(["rev-parse", "HEAD"]).stdout.toString().trim();
		const r = hookPush(
			`refs/heads/main ${tip} refs/heads/main ${"0".repeat(40)}\n`,
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("mainleak.md:1");
	});
});

describe("scrub gate: kill switch", () => {
	test("SUSPENDERS_SCRUB=0 disables the gate", () => {
		writeFileSync(join(REPO, "off.md"), `x ${HOME_LEAK}\n`);
		sh(["add", "off.md"]);
		const r = gate("git commit -m off", { SUSPENDERS_SCRUB: "0" });
		expect(r.out).toBe("{}");
	});
});

describe("scrub lib: files mode + findings text", () => {
	test("whole-file scan reports 1-based lines", () => {
		const f = join(REPO, "whole.md");
		writeFileSync(f, `a\n${HOME_LEAK} here\nb\n`);
		const found = scrubText(readFileSync(f, "utf8"), scrubRules(), f);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.rule).toBe("home-path");
	});

	test("findingsText caps at 20 + counts overflow", () => {
		const found = Array.from({ length: 25 }, (_, i) => ({
			file: `f${i}.md`,
			line: 1,
			rule: "home-path",
			match: REDACTED_HOME,
		}));
		const text = findingsText(found);
		expect(text.split("\n")).toHaveLength(21);
		expect(text).toContain("5 more");
	});
});

describe("scrub lib: diff parser", () => {
	test("added lines carry new-file line numbers; headers skip", () => {
		const lines = addedDiffLines(
			[
				"diff --git a/x.md b/x.md",
				"index 111..222 100644",
				"--- a/x.md",
				"+++ b/x.md",
				"@@ -0,0 +1,3 @@",
				`+leak ${HOME_LEAK}`,
				" context",
				"+second",
				"\\ No newline at end of file",
			].join("\n"),
		);
		expect(lines.map((l) => [l.file, l.line])).toEqual([
			["x.md", 1],
			["x.md", 3],
		]);
	});

	test("scrubAddedLines maps findings to file:line", () => {
		const lines = addedDiffLines(
			["diff --git a/y.md b/y.md", "@@ -0,0 +1,2 @@", `+k ${HOME_LEAK}`].join(
				"\n",
			),
		);
		const found = scrubAddedLines(lines, scrubRules());
		expect(found).toEqual([
			{ file: "y.md", line: 1, rule: "home-path", match: HOME_LEAK },
		]);
	});

	test("in-hunk +++ line is content, not a header (W708)", () => {
		const lines = addedDiffLines(
			[
				"diff --git a/z.md b/z.md",
				"index 111..222 100644",
				"--- a/z.md",
				"+++ b/z.md",
				"@@ -1 +1 @@",
				"-old",
				`+++ ${HOME_LEAK_DIR}/x`, // scrub:allow
				"\\ No newline at end of file",
			].join("\n"),
		);
		expect(lines).toEqual([
			{ file: "z.md", line: 1, text: `++ ${HOME_LEAK_DIR}/x` },
		]);
	});

	test("pre-hunk metadata still skips after a new file header", () => {
		const lines = addedDiffLines(
			[
				"diff --git a/a.md b/a.md",
				"--- a/a.md",
				"+++ b/a.md",
				"@@ -0,0 +1,1 @@",
				"+one",
				"diff --git a/b.md b/b.md",
				"index 333..444 100644",
				"old mode 100644",
				"new mode 100755",
				"similarity index 90%",
				"rename from a/old.md",
				"rename to b/new.md",
				"@@ -0,0 +1,1 @@",
				"+two",
			].join("\n"),
		);
		expect(lines.map((l) => [l.file, l.line])).toEqual([
			["a.md", 1],
			["b.md", 1],
		]);
	});

	test("header-lookalike content scans; added @@-lookalike is content (opus-review refutation)", () => {
		const lines = addedDiffLines(
			[
				"diff --git a/c.md b/c.md",
				"index 555..666 100644",
				"@@ -1,2 +1,4 @@",
				" ctx",
				"+diff --git a/fake b/fake", // header-lookalike CONTENT — must scan
				"+@@ not a hunk header", // @@-lookalike CONTENT — must scan
				"-removed",
				"+fourth",
			].join("\n"),
		);
		expect(lines.map((l) => l.text)).toEqual([
			"diff --git a/fake b/fake",
			"@@ not a hunk header",
			"fourth",
		]);
	});

	test("scrubBuffer scans NUL-laced content (W708)", () => {
		const leak = `token sk-${"a".repeat(26)}`;
		const buf = Buffer.from(`bin\x00data\x00${leak}\x00end`, "latin1");
		expect(scrubBuffer(buf, scrubRules(), "b.bin")).toEqual([
			{
				file: "b.bin",
				line: 1,
				rule: "sk-key",
				match: `sk-${"a".repeat(5)}…`,
			},
		]);
	});

	test("real git -U0 diffs scan fully: metadata, rename, no-eol (W739)", () => {
		const repo = mkdtempSync(join(tmpdir(), "scrub-realgit-"));
		const g = gitIn(repo);
		g(["init", "-b", "main"]);
		g(["config", "user.email", "t@t.invalid"]);
		g(["config", "user.name", "t"]);
		g(["config", "commit.gpgsign", "false"]);
		writeFileSync(join(repo, "base.txt"), "clean\nmore\n");
		g(["add", "."]);
		g(["commit", "-m", "base"]);
		writeFileSync(
			join(repo, "leaky.txt"),
			`dir /Users/kk/dev/x\n+++ /Users/kk/dev/y\n`, // scrub:allow
		);
		writeFileSync(join(repo, "nn.txt"), "tail /Users/kk/dev/q"); // scrub:allow
		g(["add", "."]);
		g(["commit", "-m", "c1"]);
		// the exact per-commit command scrub-git.ts feeds the parser
		const d1 = g(["diff", "HEAD^", "HEAD", "-U0", "--no-color"]);
		expect(
			scrubAddedLines(addedDiffLines(d1), scrubRules()).map(
				(f) => `${f.file}:${f.line}`,
			),
		).toEqual(["leaky.txt:1", "leaky.txt:2", "nn.txt:1"]);
		g(["mv", "base.txt", "moved.txt"]);
		writeFileSync(
			join(repo, "moved.txt"),
			"clean\nmore\nleak /Users/kk/dev/z\n", // scrub:allow
		);
		g(["add", "."]);
		g(["commit", "-m", "c2"]);
		const d2 = g(["diff", "HEAD^", "HEAD", "-U0", "--no-color"]);
		expect(
			scrubAddedLines(addedDiffLines(d2), scrubRules()).map(
				(f) => `${f.file}:${f.line}`,
			),
		).toEqual(["moved.txt:3"]);
	});

	test("mode-change + edit entry scans; binary rides the range face (W734)", () => {
		const repo = mkdtempSync(join(tmpdir(), "scrub-w734-"));
		const g = gitIn(repo);
		g(["init", "-q", "-b", "main"]);
		g(["config", "user.email", "t@t.invalid"]);
		g(["config", "user.name", "t"]);
		g(["config", "commit.gpgsign", "false"]);
		g(["config", "core.filemode", "true"]);
		writeFileSync(join(repo, "mode.sh"), "#!/bin/sh\n");
		g(["add", "."]);
		g(["commit", "-q", "-m", "base"]);
		chmodSync(join(repo, "mode.sh"), 0o755); // old/new mode pre-hunk metadata
		writeFileSync(
			join(repo, "mode.sh"),
			`#!/bin/sh\nleak ${HOME_LEAK_DIR}/w\n`,
		); // scrub:allow
		writeFileSync(
			join(repo, "bin.dat"),
			Buffer.from(`bin\x00sk-${"a".repeat(26)}\x00`),
		);
		g(["add", "-A"]);
		g(["commit", "-q", "-m", "c1"]);
		// mode entry hunks scan like any other; binary emits no hunks at all
		const d = g(["diff", "HEAD^", "HEAD", "-U0", "--no-color"]);
		expect(
			scrubAddedLines(addedDiffLines(d), scrubRules()).map(
				(f) => `${f.file}:${f.line}`,
			),
		).toEqual(["mode.sh:2"]);
		const range = commitRangeFindings(repo, "HEAD^", "HEAD");
		expect(range.map((f) => [f.file, f.rule])).toContainEqual([
			"bin.dat",
			"sk-key",
		]);
		expect(range.map((f) => `${f.file}:${f.line}`)).toContain("mode.sh:2");
	});
});
