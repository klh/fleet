import { expect, test } from "@playwright/test";
import { startBoard, type Board } from "./harness";

let board: Board | null = null;

test.beforeAll(async () => {
	board = await startBoard("console-history");
});

test.afterAll(async () => {
	if (board) await board.stop();
});

test("hub tokens start with active rows and expose full history on demand", async ({
	page,
}) => {
	if (!board) throw new Error("board not started");
	await page.goto(`${board.BASE}/console/hub`);
	const admin = page.locator("klh-hub-admin");
	await expect(admin).toBeVisible();
	await page.evaluate(() => {
		const el = document.querySelector("klh-hub-admin") as HTMLElement & {
			tokens: unknown[];
		};
		const row = (id: string, state: string) => ({
			key_id: id,
			actor: id,
			team: "fleet",
			token_type: "access",
			class: "app-role",
			label: null,
			scopes: ["read_coord"],
			expires_at: null,
			rotated_at: null,
			revoked_at: null,
			created_at: Date.now(),
			state,
		});
		el.tokens = [
			row("current-actor", "active"),
			...Array.from({ length: 14 }, (_, i) => row(`actor-${i}`, "active")),
			row("old-actor", "revoked"),
		];
	});
	await expect(
		admin.getByText("15 active · 1 inactive · 1–12 of 15"),
	).toBeVisible();
	await expect(admin.locator("table").first().getByRole("row")).toHaveCount(13);
	await admin.getByRole("button", { name: "Next" }).click();
	await expect(admin.getByRole("row", { name: /actor-13/ })).toBeVisible();
	await expect(admin.getByText("13–15 of 15")).toBeVisible();
	await admin.getByRole("button", { name: "Previous" }).click();
	await expect(admin.getByRole("row", { name: /current-actor/ })).toBeVisible();
	await expect(admin.getByRole("row", { name: /old-actor/ })).toHaveCount(0);
	await admin
		.getByRole("combobox", { name: "token state" })
		.selectOption("all");
	await admin.getByRole("searchbox", { name: "find token" }).fill("old");
	await expect(admin.getByRole("row", { name: /old-actor/ })).toBeVisible();
	await admin.getByRole("searchbox", { name: "find token" }).fill("current");
	await expect(admin.getByRole("row", { name: /old-actor/ })).toHaveCount(0);
});

test("settings audit hides older entries and details until requested", async ({
	page,
}) => {
	if (!board) throw new Error("board not started");
	await page.goto(`${board.BASE}/console/settings`);
	const audit = page.locator("klh-audit-list");
	await expect(audit).toBeVisible();
	await page.evaluate(() => {
		const el = document.querySelector("klh-audit-list") as HTMLElement & {
			data: unknown;
		};
		el.data = {
			rows: Array.from({ length: 7 }, (_, i) => ({
				action: "policy.apply",
				actor: "operator",
				when: `2026-10-20 00:0${i}`,
				target: `policy-${i}`,
				detail: `detail-${i}`,
			})),
		};
	});
	await expect(audit.getByText("admin audit · 7 recent actions")).toBeVisible();
	await expect(audit.getByText("Earlier actions (2)")).toBeVisible();
	await expect(audit.getByText("detail-0")).toBeHidden();
	await audit.getByText("policy.apply").first().click();
	await expect(audit.getByText("detail-0")).toBeVisible();
});
