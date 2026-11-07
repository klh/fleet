// test/validation-cmd.test.ts — W645 stack-detect validation commands
// (oh-my-claude research L5): the brief injects the repo's OWN verify
// commands, read from qlty + package metadata. Unit leg pins the detection
// rules over fixture dirs; the composition leg pins the brief line.
import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validationCommand } from "../scripts/lib/validation-cmd.ts";
import { composeBrief } from "../scripts/lib/brief.ts";

const TMP = mkdtempSync(join(tmpdir(), "suspenders-validation-"));
test.afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const repo = (name: string, files: Record<string, string>): string => {
	const dir = join(TMP, name);
	for (const [f, content] of Object.entries(files)) {
		mkdirSync(join(dir, f, ".."), { recursive: true });
		writeFileSync(join(dir, f), content);
	}
	return dir;
};

test.describe("validation-cmd detection", () => {
	test("qlty config present → the fmt+check pair", () => {
		const r = repo("qlty", { ".qlty/qlty.toml": "" });
		expect(validationCommand(r)).toBe(
			"qlty fmt --no-upgrade-check <files> && qlty check --no-upgrade-check <files>",
		);
	});

	test("package scripts contribute in doctrine order, only when present", () => {
		const r = repo("pkg", {
			"package.json": JSON.stringify({
				scripts: { test: "bun test test/", lint: "bun run lint" },
			}),
		});
		expect(validationCommand(r)).toBe("bun run lint && bun run test");
	});

	test("qlty + scripts compose with &&", () => {
		const r = repo("both", {
			".qlty/qlty.toml": "",
			"package.json": JSON.stringify({ scripts: { test: "bun test test/" } }),
		});
		expect(validationCommand(r)).toBe(
			"qlty fmt --no-upgrade-check <files> && qlty check --no-upgrade-check <files> && bun run test",
		);
	});

	test("no metadata sources → null (no invented commands)", () => {
		const r = repo("bare", { "README.md": "x" });
		expect(validationCommand(r)).toBe(null);
	});

	test("corrupt package.json is skipped, qlty still contributes", () => {
		const r = repo("corrupt", {
			".qlty/qlty.toml": "",
			"package.json": "{not json",
		});
		expect(validationCommand(r)).toBe(
			"qlty fmt --no-upgrade-check <files> && qlty check --no-upgrade-check <files>",
		);
	});
});

test.describe("brief VALIDATION line", () => {
	const base = {
		item: "W645",
		showOut: "◐ W645 CLAIMED  sample item",
		sid: "autow645",
		branch: "suspenders/W645",
		worktree: "/tmp/nowhere/.worktrees/W645",
		capsule: null,
	};

	test("detected command rides the brief", () => {
		const r = repo("briefrepo", {
			".qlty/qlty.toml": "",
			"package.json": JSON.stringify({ scripts: { test: "bun test test/" } }),
		});
		const brief = composeBrief({ ...base, repo: r });
		expect(brief).toContain(
			`VALIDATION (<files> = the paths you changed): qlty fmt --no-upgrade-check <files> && qlty check --no-upgrade-check <files> && bun run test`,
		);
	});

	test("no metadata → no VALIDATION line", () => {
		const r = repo("briefbare", { "README.md": "x" });
		expect(composeBrief({ ...base, repo: r })).not.toContain("VALIDATION (");
	});

	test("explicit override wins; null drops the line", () => {
		const overridden = composeBrief({ ...base, validation: "make check" });
		expect(overridden).toContain(
			"VALIDATION (<files> = the paths you changed): make check",
		);
		expect(composeBrief({ ...base, validation: null })).not.toContain(
			"VALIDATION (",
		);
	});
});

test.describe("verdict contract line (W645 L6a)", () => {
	test("every brief carries the mandatory-final-line + fail-fast contract", () => {
		const brief = composeBrief({
			item: "W650",
			showOut: "◐ W650 CLAIMED  review the thing",
			sid: "autow650",
			branch: "suspenders/W650",
			worktree: "/tmp/nowhere/.worktrees/W650",
			capsule: null,
			validation: null,
		});
		expect(brief).toContain("VERDICT CONTRACT:");
		expect(brief).toContain("fails fast");
		expect(brief).toContain("the parent regexes it");
	});
});
