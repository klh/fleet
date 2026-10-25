// e2e/buckle-admin.spec.ts — W1270: the buckle admin token lifecycle drives
// end-to-end in the browser: the /console/hub admin surface (klh-hub-admin)
// issues a scoped buckle:admin token whose raw material renders exactly once,
// the token lists active with its scope, and the actor revoke flips the row to
// revoked. Real fleet-board.ts + scratch identity.db (harness.ts); the
// browser's write rides the board's HttpOnly write cookie — no secrets in the
// spec.
import { expect, test, type Page } from "@playwright/test";
import { startBoard, type Board } from "./harness";

test.describe.configure({ mode: "serial" });

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("buckle-admin");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

function mustBoard(): Board {
	if (board === null) throw new Error("board not started");
	return board;
}

function watch(page: Page): { clean(): void } {
	const pageErrors: string[] = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	return {
		clean(): void {
			expect(pageErrors, "uncaught page exceptions").toEqual([]);
		},
	};
}

test("admin token lifecycle: mint, shown-once, list, revoke", {
	tag: ["@ui", "@api"],
}, async ({ page }) => {
	const b = mustBoard();
	const look = watch(page);
	// the revoke confirm dialog rides window.confirm
	page.on("dialog", (d) => {
		void d.accept();
	});
	await page.goto(`${b.BASE}/console/hub`);
	const admin = page.locator("klh-hub-admin");
	await expect(admin).toBeVisible();
	// fresh scratch identity store: no tokens yet
	await expect(admin.getByText("no tokens yet")).toBeVisible();

	// mint: actor + default buckle:admin scope through the issue form
	const issuer = admin.locator("details", { hasText: "Issue a token" });
	await issuer.locator("summary").click();
	await issuer.locator("#ha-actor").fill("e2e-admin");
	await issuer.locator("#ha-label").fill("w1270 lifecycle");
	await issuer.getByRole("button", { name: "Issue token" }).click();

	// the raw material renders exactly once
	const once = admin.locator(".once");
	await expect(once).toBeVisible();
	await expect(
		once.getByText("Token minted — shown once, copy now."),
	).toBeVisible();
	const access = once.locator("code").first();
	await expect(access).toContainText("ey");
	expect((await access.textContent())?.length ?? 0).toBeGreaterThan(100);

	// the row lists active with the scope and the masked id
	const row = admin.locator("tr", { hasText: "e2e-admin" }).first();
	await expect(row).toBeVisible();
	await expect(row).toContainText("buckle:admin");
	await expect(row.locator("klh-tag")).toHaveText("active");
	const keyId = await row.locator("td").first().textContent();
	expect(keyId?.trim().length).toBe(8);

	// revoke the actor — every row for it flips to revoked
	await row.getByRole("button", { name: "revoke actor" }).click();
	await expect(admin.getByText(/0 active · \d+ inactive/)).toBeVisible();

	// the active view empties; the all view shows the revoked row
	await expect(admin.getByText("no tokens match this view")).toBeVisible();
	await admin.locator("select[aria-label='token state']").selectOption("all");
	const revoked = admin.locator("tr", { hasText: "e2e-admin" }).first();
	await expect(revoked).toBeVisible();
	await expect(revoked.locator("klh-tag")).toHaveText("revoked");
	await expect(
		revoked.getByRole("button", { name: "revoke actor" }),
	).toHaveCount(0);
	look.clean();
});
