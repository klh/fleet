// scrub-gate.test.ts — W236: the scrub gate. Unit legs cover the scanner
// (builtin rules, denylist literal + regex lines, marker escape, redaction,
// the -U0 diff parser); the e2e legs spawn gate.ts pre-bash against a
// scratch repo the way a lane's git commit/push arrives (the harness of
// secrets-gate.test.ts). Skipped legs: none — no external tool needed.
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addedDiffLines,
	findingsText,
	scanLine,
	scrubAddedLines,
	scrubRules,
	scrubText,
} from "../hooks/lib/scrub.ts";

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
	});
});

describe("scrub lib: denylist + marker + redaction", () => {
	const line = (s: string) => scanLine(s, scrubRules());

	test("denylist literal + regex lines fire", () => {
		expect(line("git.nas-threads.dk").map((h) => h.rule)).toEqual([
			"denylist:2",
		]);
		expect(line("ip 10.0.1.23").map((h) => h.rule)).toEqual(["denylist:3"]);
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
});
