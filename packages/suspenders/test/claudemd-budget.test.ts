// test/claudemd-budget.test.ts — W514: the CLAUDE.md instruction-budget
// audit (oh-my-claude research L7). Pins the estimator heuristics and the
// repo walk on a fixture tree; the real fleet files are audited by running
// the script, not in this suite.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditRepo,
	auditText,
	countInstructions,
	countStalePaths,
} from "../scripts/claudemd-budget.ts";

const TMP = mkdtempSync(join(tmpdir(), "suspenders-claudemd-"));

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("claudemd instruction budget", () => {
	test("counts list items, table rows as instructions", () => {
		const text = [
			"# Title",
			"",
			"- bullet one",
			"- bullet two",
			"  - nested bullet",
			"1. numbered",
			"| a | b |",
			"| --- | --- |",
			"prose line",
		].join("\n");
		expect(countInstructions(text)).toBe(6); // 3 bullets + numbered + 2 table rows
	});

	test("hardcoded machine paths count; tilde paths exempt", () => {
		const text = [
			"config lives in ~/.config/klh/stack.yaml", // exempt
			"host dir is /Volumes/Sensitive/github/klh", // stale
			"home dir is /Users/kk/dev", // stale
		].join("\n");
		expect(countStalePaths(text)).toBe(2);
	});

	test("auditText: root budget 150, nested 80, verdicts escalate", () => {
		const ok = auditText("nested/CLAUDE.md", "prose\n", false);
		expect(ok.verdict).toBe("ok");
		const fat = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
		expect(auditText("nested/CLAUDE.md", fat, false).verdict).toBe("over-lines");
		expect(auditText("CLAUDE.md", fat, true).verdict).toBe("ok"); // root allows 150
		// instruction budget (120) binds below the line ceiling (150)
		const bullets = Array.from({ length: 130 }, () => "- x").join("\n");
		expect(auditText("CLAUDE.md", `${bullets}\n`, true).verdict).toBe(
			"over-instructions",
		);
		const stale = auditText("CLAUDE.md", "- see /Users/kk/x\n", true);
		expect(stale.verdict).toBe("stale-paths");
	});

	test("auditRepo walks nested law files, skips noise dirs", () => {
		mkdirSync(join(TMP, "pkg/sub"), { recursive: true });
		mkdirSync(join(TMP, "node_modules/x"), { recursive: true });
		writeFileSync(join(TMP, "CLAUDE.md"), "root law\n");
		writeFileSync(join(TMP, "pkg/sub/AGENTS.md"), "- nested law\n");
		writeFileSync(join(TMP, "node_modules/x/CLAUDE.md"), "ignored\n");
		const rows = auditRepo(TMP);
		expect(rows.map((r) => r.file)).toEqual([
			"CLAUDE.md",
			join("pkg", "sub", "AGENTS.md"),
		]);
		expect(rows[0].lines).toBeGreaterThan(0);
	});
});
