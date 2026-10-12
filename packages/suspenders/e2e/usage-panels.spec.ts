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
	const shot = join(
		dirname(fileURLToPath(import.meta.url)),
		"test-results",
		"usage-panels-usage.png",
	);
	await page.screenshot({ path: shot, fullPage: true });
	copyFileSync(shot, "/tmp/w65231-look-usage.png");
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
