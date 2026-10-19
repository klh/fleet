// e2e/usage-panels.spec.ts — W652.3.1: the usage/federation panels render as
// upgraded Lit components on the LIVE surface. The bun child process
// (usage-panels-server.ts) seeds a scratch db and serves the REAL page
// builders' output plus the real /vendor bundles; chromium drives both
// dashboards: hosts must upgrade, shadow content must paint, uPlot must
// mount, and full-page screenshots land as evidence.
import { expect, test } from "@playwright/test";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let scratch = "";
let proc: ReturnType<typeof spawn> | null = null;
let BASE = "";

test.beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "sb-e2e-usage-panels-spec-"));
	const portFile = join(scratch, "port");
	proc = spawn(
		"bun",
		[
			join(dirname(fileURLToPath(import.meta.url)), "usage-panels-server.ts"),
			portFile,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	let port = "";
	for (let i = 0; i < 100 && !port; i++) {
		await new Promise((r) => setTimeout(r, 100));
		try {
			port = readFileSync(portFile, "utf8").trim();
		} catch {}
	}
	expect(port, "server did not write a port").not.toBe("");
	BASE = `http://127.0.0.1:${port}`;
});

test.afterAll(() => {
	proc?.kill();
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("usage page: hosts upgrade, panels paint, uPlot mounts", async ({
	page,
}) => {
	await page.goto(`${BASE}/usage`);
	await page.waitForFunction(
		() =>
			document.querySelector("klh-usage-tiles")?.shadowRoot !== null &&
			document.querySelector("klh-usage-actors")?.shadowRoot !== null,
	);
	await expect(page.locator("klh-usage-tiles")).toContainText("ACTIVE ACTORS");
	await expect(page.locator("klh-usage-tiles")).toContainText("TOTAL TOKENS");
	await expect(page.locator("klh-usage-actors")).toContainText("alice");
	await expect(page.locator("klh-usage-actors")).toContainText("platform");
	await expect(page.locator("klh-usage-actors")).toContainText("bob");
	// W658.4: the chart panels upgrade as <klh-usage-charts> (light DOM) and
	// mount uPlot into their own render root — one canvas per panel
	await expect(page.locator("klh-usage-charts")).toContainText(
		"STACKED BY MODEL GROUP",
	);
	await expect(page.locator("#u-timeline canvas")).toHaveCount(1);
	await expect(page.locator("#u-hours canvas")).toHaveCount(1);
	const drill = page.locator("klh-usage-drilldown");
	const day = drill.getByRole("combobox", { name: "day" });
	const hour = drill.getByRole("combobox", { name: "hour" });
	await expect(day).toBeVisible();
	await expect(hour).toBeVisible();
	expect(await hour.locator("option").count()).toBeLessThanOrEqual(24);
	const earliestDay = await day.locator("option").last().inputValue();
	await day.selectOption(earliestDay);
	await expect(page).toHaveURL(/hour=\d+/);
	const crossHub = page.locator("klh-usage-crosshub");
	await expect(crossHub).toContainText("No response before the hub timeout");
	await expect(crossHub).toContainText("0 reporting · 1 down/unresolved");
	await crossHub.getByText("Diagnostic").click();
	await expect(crossHub).toContainText(
		"TimeoutError: The operation timed out.",
	);
	const shot = join(
		dirname(fileURLToPath(import.meta.url)),
		"test-results",
		"usage-panels-usage.png",
	);
	await page.screenshot({ path: shot, fullPage: true });
	copyFileSync(shot, "/tmp/w65231-look-usage.png");
	expect(statSync(shot).size).toBeGreaterThan(50_000);
});

test("cache drilldown: host upgrades, lanes paint, lane drilldown works", async ({
	page,
}) => {
	await page.goto(`${BASE}/usage`);
	await page.waitForFunction(
		() => document.querySelector("klh-usage-cache-drill")?.shadowRoot !== null,
	);
	const drill = page.locator("klh-usage-cache-drill");
	await expect(drill).toContainText("CACHE EFFICIENCY");
	await expect(drill).toContainText("autow700");
	// miss-reason clusters paint from the canned misses — not just counts,
	// REASONS
	await expect(drill).toContainText("MISS REASONS");
	// usage → lane drilldown: click the lane row, the request table paints
	await drill
		.locator("tr.ulane")
		.filter({ hasText: "autow700" })
		.locator("button.ulaneButton")
		.click();
	await expect(drill).toContainText("REQUESTS");
	await expect(drill).toContainText("glm-5.3-flash");
	await drill.getByRole("button", { name: "← all lanes" }).click();
	const bare = drill
		.locator("tr.ulane")
		.filter({ hasText: "(bare ingress)" })
		.locator("button.ulaneButton");
	await bare.focus();
	await bare.press("Enter");
	await expect(drill).toContainText("UNATTRIBUTED REQUESTS");
	await expect(drill).toContainText("zai-glm-5.3-flash");
	await expect(drill.locator("time").last()).toHaveText(/\d{2}:\d{2}:\d{2}/);
	await expect(drill.locator("time").last()).toHaveAttribute("title", /Z$/);
	const shot = join(
		dirname(fileURLToPath(import.meta.url)),
		"test-results",
		"usage-cache-drill.png",
	);
	await page.screenshot({ path: shot, fullPage: true });
	copyFileSync(shot, "/tmp/w825-look-cache-drill.png");
	expect(statSync(shot).size).toBeGreaterThan(50_000);
});

test("federation page: spokes + aid rows paint from rollups", async ({
	page,
}) => {
	await page.goto(`${BASE}/federation-usage`);
	await page.waitForFunction(
		() =>
			document.querySelector("klh-usage-spokes")?.shadowRoot !== null &&
			document.querySelector("klh-usage-aids")?.shadowRoot !== null,
	);
	await expect(page.locator("klh-usage-tiles")).toContainText(
		"REPORTING SPOKES",
	);
	// W695.3.5: the head rides <klh-usage-head> (title, back link, chips)
	const head = page.locator("klh-usage-head");
	await expect(head).toContainText("FEDERATED USAGE");
	await expect(head.locator('a[href="/"]')).toHaveCount(1);
	await expect(head.locator("a.ufilter")).toHaveCount(3);
	await expect(head.locator("a.ufilter.on")).toHaveCount(1);
	await expect(page.locator("klh-usage-spokes")).toContainText("nas");
	await expect(page.locator("klh-usage-spokes")).toContainText("desktop");
	await expect(page.locator("klh-usage-aids")).toContainText("fleet-lessons");
	await expect(page.locator("klh-usage-aids")).toContainText("4.8K");
	// W658.4: fed timeline title rides the component attribute
	await expect(page.locator("klh-usage-charts")).toContainText(
		"GLOBAL TOKENS · STACKED BY MODEL CLASS",
	);
	await expect(page.locator("#u-timeline canvas")).toHaveCount(1);
	// W171 regression pin: the global timeline aggregation must actually
	// accumulate per-bucket cells (the byBucket map was never initialized —
	// every window hit the undefined-continue and the chart rendered all-zero)
	const tl = (await page
		.locator('script[type="application/json"]#usage-data')
		.textContent()) as string;
	const fedPayload = JSON.parse(tl) as { timeline: number[][] };
	expect(Math.max(...fedPayload.timeline[1])).toBeGreaterThan(0);
	const shot = join(
		dirname(fileURLToPath(import.meta.url)),
		"test-results",
		"usage-panels-fed.png",
	);
	await page.screenshot({ path: shot, fullPage: true });
	copyFileSync(shot, "/tmp/w65231-look-fed.png");
	expect(statSync(shot).size).toBeGreaterThan(50_000);
});
