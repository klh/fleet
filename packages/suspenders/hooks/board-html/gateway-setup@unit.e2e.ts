import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { beltPage } from "../bin/console-html.ts";
import type { GatewaySetup } from "../board/console-setup.ts";

const shots = "/tmp/fleet-w3057-shots";
const cases: GatewaySetup[] = [
	{
		state: "unconfigured",
		gateway: "up",
		connections: 0,
		models: 0,
		defaultsOnly: false,
	},
	{
		state: "configured-unavailable",
		gateway: "up",
		connections: 2,
		models: 0,
		defaultsOnly: false,
	},
	{
		state: "ready",
		gateway: "up",
		connections: 2,
		models: 3,
		defaultsOnly: false,
	},
	{
		state: "configured-unavailable",
		gateway: "down",
		connections: 2,
		models: 3,
		defaultsOnly: false,
	},
	{
		state: "unknown",
		gateway: "up",
		connections: 2,
		models: null,
		defaultsOnly: false,
	},
];
for (const [index, fixture] of cases.entries()) {
	const setup = { ...fixture, checkedAt: "2026-11-12T12:34:00Z" };
	test(`gateway setup fixture ${index}`, async ({ page }) => {
		mkdirSync(shots, { recursive: true });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		let requests = 0;
		await page.route("http://setup.fixture/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/console/buckle")
				return route.fulfill({
					contentType: "text/html",
					body: beltPage({
						setup,
						policy: null,
						gateway: null,
						policyError: null,
						health: [],
						groups: [],
						network: null,
						beltAssetsUp: false,
					}),
				});
			if (path.startsWith("/vendor/"))
				return route.fulfill({
					contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
					body: await Bun.file(
						join(import.meta.dir, "vendor", path.slice(8)),
					).text(),
				});
			if (path === "/api/console/gateway-setup") {
				requests++;
				return route.fulfill({ status: 503, body: "unavailable" });
			}
			return route.fulfill({ json: { ok: false } });
		});
		await page.goto("http://setup.fixture/console/buckle");
		const card = page.locator("klh-gateway-setup-card");
		await expect(
			card.getByRole("heading", { name: "Gateway setup", exact: true }),
		).toBeVisible();
		await expect(
			card.getByText("Request test not run", { exact: false }),
		).toBeVisible();
		const details = card.locator("details");
		if (setup.state === "ready") {
			await expect(details).not.toHaveAttribute("open", "");
			expect((await card.boundingBox())?.height).toBeLessThanOrEqual(160);
			await card.screenshot({
				path: `${shots}/setup-${index}-collapsed-light.png`,
			});
			await page.evaluate(() =>
				document.documentElement.setAttribute("data-theme", "dark"),
			);
			await card.screenshot({
				path: `${shots}/setup-${index}-collapsed-dark.png`,
			});
			await page.setViewportSize({ width: 390, height: 844 });
			await card.screenshot({
				path: `${shots}/setup-${index}-collapsed-narrow.png`,
			});
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.evaluate(() =>
				document.documentElement.setAttribute("data-theme", "light"),
			);
			await details.locator("summary").focus();
			await page.keyboard.press("Enter");
		}
		await expect(card.getByRole("table")).toBeVisible();
		await expect(card.getByRole("heading", { level: 3 })).toHaveText(
			[
				"Setup needed",
				"Configuration needs attention",
				"Ready to test",
				"Configuration needs attention",
				"Setup check incomplete",
			][index] ?? "",
		);
		await expect(
			card.getByText("Not tested — try an authenticated client."),
		).toBeVisible();
		await expect(
			card.getByRole("link", { name: "Settings", exact: true }),
		).toHaveAttribute("href", "/console/settings");
		await card.screenshot({ path: `${shots}/setup-${index}-light.png` });
		await page.evaluate(() =>
			document.documentElement.setAttribute("data-theme", "dark"),
		);
		await card.screenshot({ path: `${shots}/setup-${index}-dark.png` });
		const settings = card.getByRole("link", { name: "Settings", exact: true });
		await settings.focus();
		await page.keyboard.press("Tab");
		await expect(
			card.getByRole("button", { name: "Check again" }),
		).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(
			card.getByText(
				"Check unavailable. Previous observations below are retained.",
			),
		).toBeVisible();
		expect(requests).toBe(1);
		if (setup.connections)
			await expect(
				card.getByText(`${setup.connections} connections`, {
					exact: true,
				}),
			).toBeVisible();
		await page.setViewportSize({ width: 390, height: 844 });
		await card.screenshot({ path: `${shots}/setup-${index}-narrow.png` });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		expect(errors).toEqual([]);
	});
}
