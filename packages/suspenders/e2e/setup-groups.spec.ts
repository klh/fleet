// e2e/setup-groups.spec.ts — W858.7.21: the Setup tab groups its checks by
// what they verify — "Local wiring" (files, plists, settings) and "Remote
// reachability" (network probes) — without hiding any check, and a FAILED
// hub probe presents hub identity + the measured probe URL in the detail
// and a safe concrete status command in the fix. Live board, real browser.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;
let cfgDir = "";

test.beforeAll(async () => {
	// dead loopback candidate (port 9) as the only hub candidate — the
	// reachability check fails with a concrete recovery path
	cfgDir = mkdtempSync(join(tmpdir(), "sb-e2e-hubfix-cfg-"));
	const hubsPath = join(cfgDir, "hubs.json");
	writeFileSync(
		hubsPath,
		`${JSON.stringify({ nas: { candidates: ["http://127.0.0.1:9"] } }, null, "\t")}\n`,
	);
	board = await startBoard("setup-groups", {
		env: { SUSPENDERS_HUBS_FILE: hubsPath },
	});
});

test.afterAll(async () => {
	if (board) await board.stop();
	rmSync(cfgDir, { recursive: true, force: true });
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

test("setup groups local wiring vs remote reachability with a concrete hub fix", {
	tag: "@ui",
}, async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${mustBoard().BASE}/#setup`);
	// both group headings paint; the two counts sum to the full checklist
	await expect(page.locator("#setupBody h3.sgroup").first()).toHaveText(
		/Local wiring \(7\)/,
	);
	await expect(page.locator("#setupBody h3.sgroup").nth(1)).toHaveText(
		/Remote reachability \(2\)/,
	);
	// the failed hub card: identity + measured URL + safe status command
	const hubs = page.locator(".scard", { hasText: "Hub reachability" });
	await expect(hubs).toContainText("nas no answer at http://127.0.0.1:9");
	await expect(hubs.locator(".copyfix")).toHaveAttribute(
		"data-fix",
		"bun deploy/hubctl.ts status nas",
	);
	// no check hidden: 9 cards total under the two headings
	await expect(page.locator("#setupBody .scard")).toHaveCount(9);
	await expect.poll(() => errors.length, { intervals: [500, 1000] }).toBe(0);
});
