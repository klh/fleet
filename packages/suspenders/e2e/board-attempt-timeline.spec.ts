// e2e/board-attempt-timeline.spec.ts — W1188: the served board's
// /api/spend-series carries comparable current-attempt timelines (fixed
// 90m/3m-bin window) and the lanes kanban paints them behind the attempt
// view toggle. Mirrors board-spend-series.spec.ts's startBoard harness:
// scratch HOME + repo, OS-picked port, dead loopback upstreams; the ledger
// rides SUSPENDERS_BUCKLE_DB="" (spoke-home resolution) so the ambient env
// pin can never leak into the fixture (W670 doctrine).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { startBoard } from "./harness.ts";

test.describe.configure({ mode: "serial" });

let b: Awaited<ReturnType<typeof startBoard>>;
let wIdA = "";
let wIdB = "";
let ledgerTs = "";

test.beforeAll(async () => {
	b = await startBoard("w1188", { env: { SUSPENDERS_BUCKLE_DB: "" } });
	// Two taken items: A gets a buckle ledger request (tool + firstbyte
	// evidence), B gets none (queue + unknown only).
	wIdA = b.mintedId(b.workOk(["add", "attempt timeline A"], "add"));
	wIdB = b.mintedId(b.workOk(["add", "attempt timeline B"], "add"));
	b.workOk(["take", wIdA, "--as", "autow1188-a"], "take");
	b.workOk(["take", wIdB, "--as", "autow1188-b"], "take");
	const ledger = join(b.HOME, ".claude/local-llm/buckle.db");
	mkdirSync(dirname(ledger), { recursive: true });
	ledgerTs = new Date().toISOString();
	const d = new Database(ledger);
	d.run(
		"CREATE TABLE route_audit (ts TEXT, lane TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER)",
	);
	d.run(
		"INSERT INTO route_audit VALUES (?, 'autow1188-a', 500, 100, 50, 10)",
		ledgerTs,
	);
	d.close();
});

type AttemptWire = {
	windowStart: number;
	windowEnd: number;
	bins: number;
	binMs: number;
	attempt: { firstByteAt: number | null; segments: { kind: string }[] };
};

test.afterAll(async () => {
	await b.stop();
});

test("api: spend-series carries comparable fixed-window attempt timelines", {
	tag: "@ui",
}, async () => {
	const r = await fetch(`${b.BASE}/api/spend-series`).then((r) => r.json());
	expect(r.ok).toBe(true);
	expect(r.attempts).toBeTruthy();
	const pick = (wId: string): AttemptWire | undefined => {
		const hit = Object.entries(r.attempts as Record<string, AttemptWire>).find(
			([k]) => k.endsWith(`\u0000${wId}`),
		);
		return hit?.[1];
	};
	const a = pick(wIdA);
	expect(a, `no attempt entry for ${wIdA}`).toBeDefined();
	const c = pick(wIdB);
	expect(c, `no attempt entry for ${wIdB}`).toBeDefined();
	// Comparability: ONE fixed window shape shared by both items.
	expect(a?.bins).toBe(30);
	expect(a?.binMs).toBe(180_000);
	expect(c?.windowStart).toBe(a?.windowStart);
	expect(c?.windowEnd).toBe(a?.windowEnd);
	expect(c?.bins).toBe(a?.bins);
	expect(c?.binMs).toBe(a?.binMs);
	// A: the ledger row is its first byte and paints a tool minute.
	const kindsA = (a?.attempt.segments ?? []).map((s) => s.kind);
	expect(kindsA).toContain("firstbyte");
	expect(kindsA).toContain("tool");
	expect(a?.attempt.firstByteAt).toBe(Date.parse(ledgerTs));
	// B: no ledger rows — tool/firstbyte evidence is never invented.
	const kindsB = (c?.attempt.segments ?? []).map((s) => s.kind);
	expect(kindsB).not.toContain("tool");
	expect(kindsB).not.toContain("firstbyte");
});

test("gui: attempt view paints segments behind the toggle, spend chart intact", {
	tag: "@ui",
}, async ({ page }) => {
	await page.addInitScript(() => {
		try {
			localStorage.setItem("sb.attemptView", "1");
		} catch {}
	});
	await page.goto(`${b.BASE}/#lanes`);
	// the toggle reflects the restored state
	await expect(page.locator('#attemptView[aria-pressed="true"]')).toBeVisible({
		timeout: 20_000,
	});
	// label + painted segments
	await expect(page.locator(".kattemptlabel").first()).toContainText(
		"current attempt",
	);
	await expect(
		page.locator(".kattempt svg rect.at-firstbyte").first(),
	).toBeVisible();
	await expect(
		page.locator(".kattempt svg rect.at-tool").first(),
	).toBeVisible();
	await page.screenshot({
		path: "e2e/test-results/w1188-attempt-view.png",
		fullPage: false,
	});
	// toggling OFF removes the attempt blocks; the truthful spend chart stays
	await page.click("#attemptView");
	await expect(page.locator(".kattempt")).toHaveCount(0, { timeout: 20_000 });
	await expect(
		page.locator(".kspark svg rect.spark-fresh").first(),
	).toBeVisible();
});
