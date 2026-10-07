// test/install-launchd-pinned.test.ts — W427: registerLaunchd must refuse to
// render launchd units from a linked git worktree (a reapable tree — the
// spoke served from a codex demo worktree until its plist was re-rendered
// from the pinned checkout). .git as a FILE marks a linked worktree; a main
// checkout has the .git DIR; the installed harness copy has no .git at all.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedCheckoutRefusal } from "../scripts/install-launchd.ts";

describe("pinnedCheckoutRefusal", () => {
	test("refuses a linked worktree (.git is a file)", () => {
		const repo = mkdtempSync(join(tmpdir(), "w427-worktree-"));
		writeFileSync(join(repo, ".git"), "gitdir: /somewhere/else\n");
		const refusal = pinnedCheckoutRefusal(repo);
		expect(refusal).toContain("linked git worktree");
		expect(refusal).toContain("pinned stack checkout");
	});
	test("allows a main checkout (.git is a directory)", () => {
		const repo = mkdtempSync(join(tmpdir(), "w427-checkout-"));
		mkdirSync(join(repo, ".git"));
		expect(pinnedCheckoutRefusal(repo)).toBeNull();
	});
	test("allows the harness copy (no .git)", () => {
		const repo = mkdtempSync(join(tmpdir(), "w427-harness-"));
		expect(pinnedCheckoutRefusal(repo)).toBeNull();
	});
});
