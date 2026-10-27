// test/install-launchd-stable-repo.test.ts — W631: registerLaunchd renders
// units only from a stable tree. A snapshot harness copy (no .git — the
// suspenders.generation-<hash> dirs under ~/.claude/hooks) must normalize to
// the pinned checkout named by the harness receipt's `source`, or registration
// refuses. Outage context: install.ts --step registerLaunchd run from
// $PREFIX/scripts resolved __REPO__/../buckle into the generation snapshot
// (no packages/buckle) and the buckle-spoke crash-looped, fail-closing
// governance:strict dispatch on 2026-10-11.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStableRepo } from "../scripts/install-launchd.ts";

test.describe("resolveStableRepo", () => {
	test("passes a pinned checkout through (no normalization)", () => {
		const checkout = mkdtempSync(join(tmpdir(), "w631-checkout-"));
		mkdirSync(join(checkout, ".git"));
		const suspenders = join(checkout, "packages/suspenders");
		mkdirSync(suspenders, { recursive: true });
		const r = resolveStableRepo(suspenders, join(checkout, "prefix"));
		expect(r).toEqual({ ok: true, repo: suspenders, normalized: false });
	});

	test("refuses a linked worktree (.git is a file) — never normalizes a reapable tree", () => {
		const checkout = mkdtempSync(join(tmpdir(), "w631-worktree-"));
		writeFileSync(join(checkout, ".git"), "gitdir: /somewhere/else\n");
		const suspenders = join(checkout, "packages/suspenders");
		mkdirSync(suspenders, { recursive: true });
		const r = resolveStableRepo(suspenders, join(checkout, "prefix"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.refusal).toContain("linked git worktree");
	});

	test("never classifies via ancestor walk — a .git DIR above a snapshot must not pass it through", () => {
		// live finding 2026-10-11: ~/.claude is itself a git checkout on the
		// owner's Mac, so a walk-to-nearest-.git blesses any generation
		// snapshot under ~/.claude/hooks as a pinned checkout and renders
		// units from a reapable snapshot. Identification is positive: the
		// stack shape <root>/packages/suspenders with a .git DIR at <root>,
		// or repo being a git toplevel itself — never an ancestor scan.
		const fakeHome = mkdtempSync(join(tmpdir(), "w631-home-"));
		mkdirSync(join(fakeHome, ".claude/.git"), { recursive: true });
		const snap = join(
			fakeHome,
			".claude/hooks/suspenders.generation-x/.harness/packages/suspenders",
		);
		mkdirSync(snap, { recursive: true });
		const prefix = mkdtempSync(join(tmpdir(), "w631-prefix-"));
		const r = resolveStableRepo(snap, prefix);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.refusal).toContain("snapshot harness copy");
	});

	test("normalizes a snapshot harness via the receipt source", () => {
		const checkout = mkdtempSync(join(tmpdir(), "w631-src-"));
		mkdirSync(join(checkout, ".git"));
		mkdirSync(join(checkout, "packages/suspenders"), { recursive: true });
		const prefix = mkdtempSync(join(tmpdir(), "w631-prefix-"));
		writeFileSync(
			join(prefix, "harness-receipt.json"),
			JSON.stringify({ schema: "fleet.harness.v1", source: checkout }),
		);
		const r = resolveStableRepo(join(prefix, "scripts"), prefix);
		expect(r).toEqual({
			ok: true,
			repo: join(checkout, "packages/suspenders"),
			normalized: true,
		});
	});

	test("refuses a snapshot when the receipt is missing", () => {
		const snapshot = mkdtempSync(join(tmpdir(), "w631-snap-"));
		const prefix = mkdtempSync(join(tmpdir(), "w631-noprefix-"));
		const r = resolveStableRepo(snapshot, prefix);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.refusal).toContain("snapshot harness copy");
	});

	test("refuses when the receipt source is itself a snapshot (no .git dir)", () => {
		const snapshot = mkdtempSync(join(tmpdir(), "w631-snap-"));
		const drift = mkdtempSync(join(tmpdir(), "w631-drift-"));
		mkdirSync(join(drift, "packages/suspenders"), { recursive: true });
		const prefix = mkdtempSync(join(tmpdir(), "w631-prefix-"));
		writeFileSync(
			join(prefix, "harness-receipt.json"),
			JSON.stringify({ source: drift }),
		);
		const r = resolveStableRepo(snapshot, prefix);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.refusal).toContain("not a pinned stack checkout");
	});

	test("refuses when the receipt source lacks packages/suspenders", () => {
		const checkout = mkdtempSync(join(tmpdir(), "w631-src-"));
		mkdirSync(join(checkout, ".git"));
		const prefix = mkdtempSync(join(tmpdir(), "w631-prefix-"));
		writeFileSync(
			join(prefix, "harness-receipt.json"),
			JSON.stringify({ source: checkout }),
		);
		const r = resolveStableRepo(join(prefix, "scripts"), prefix);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.refusal).toContain("not a pinned stack checkout");
	});
});
