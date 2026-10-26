import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { assertInstalled, buildAddArgs, REPO_ROOT } from "./skills-ci.ts";

const scratch = mkdtempSync(join(tmpdir(), "skills-ci-test-"));

test.describe("@unit", () => {
	test.describe("skills-ci argv contract", () => {
		test("discovery leg lists without installing", () => {
			const args = buildAddArgs("packages/suspenders/skills/fleet", "list");
			expect(args.slice(0, 4)).toEqual([
				"x",
				"skills",
				"add",
				join(REPO_ROOT, "packages/suspenders/skills/fleet"),
			]);
			expect(args.slice(4)).toEqual(["--list"]);
		});

		test("install leg is global, non-interactive, copy-mode, agent value last", () => {
			const args = buildAddArgs(".", "install");
			expect(args.slice(0, 4)).toEqual(["x", "skills", "add", REPO_ROOT]);
			// the CLI consumes every arg after -a as the agent list: value must
			// be the last element or it swallows the rest of the command
			expect(args.slice(4)).toEqual([
				"--copy",
				"-g",
				"-y",
				"-a",
				"claude-code",
			]);
		});
	});

	test.describe("skills-ci install contract", () => {
		test("global install lands the fleet SKILL.md in scratch config", () => {
			mkdirSync(join(scratch, "claude", "skills", "fleet"), {
				recursive: true,
			});
			writeFileSync(
				join(scratch, "claude", "skills", "fleet", "SKILL.md"),
				"x",
			);
			expect(() => assertInstalled(scratch)).not.toThrow();
		});

		test("missing SKILL.md means the install did not land — fails", () => {
			const empty = mkdtempSync(join(tmpdir(), "skills-ci-test-empty-"));
			expect(() => assertInstalled(empty)).toThrow(/did not land/);
		});
	});
});
