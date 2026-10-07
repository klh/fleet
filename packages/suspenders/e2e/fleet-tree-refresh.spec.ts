// e2e/fleet-tree-refresh.spec.ts — W530.2: the fleet-tree page against a
// REAL browser (chromium) and REAL servers — three separate scenarios per
// mission: (A) startup renders the stub fleet (live hub, protected hub,
// dead hub, simulation root display-only), (B) lane stop/start transitions
// flip the leaf on the next sweep, (C) inaccessible registry → last-good
// snapshot served with the stale badge. Rides realDeps env knobs
// (SUSPENDERS_LLM_HOME, SUSPENDERS_LOCAL_REGISTRY) + the module singleton,
// so the spec exercises the exact wire surface a human sees.
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFleetTree } from "../hooks/board/routes-fleet-tree.ts";

let browser: Browser;
let page: Page;
let HOME: string;
const stops: { stop: () => void }[] = [];

// dead port: bind, read the OS-picked port, release
const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const DEAD = dead.port;
dead.stop(true);

// the stoppable lane leaf (scenario B)
let laneSrv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
const LANE = laneSrv.port;

// local registry stub: router + coder (the stoppable lane) + ghost (dead)
const registry = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (req) => {
		const u = new URL(req.url);
		if (u.pathname === "/registry.json")
			return Response.json({
				router: { port: registry.port },
				entries: [
					{ alias: "coder", label: "coder", port: LANE, tier: "coder" },
					{ alias: "ghost", label: "ghost", port: DEAD, tier: "menial" },
				],
			});
		return new Response("ok");
	},
});

// hub stubs: nas answers, desktop is dead, vault protects with 401
const nas = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (req) => {
		const u = new URL(req.url);
		if (u.pathname === "/registry.json")
			return Response.json({
				entries: [{ alias: "nas-coder", label: "nas coder", port: LANE, tier: "coder" }],
			});
		return new Response("ok");
	},
});
const vault = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response("denied", { status: 401 }),
});

test.beforeAll(async () => {
	HOME = mkdtempSync(join(tmpdir(), "w5302-e2e-home-"));
	const llmHome = join(HOME, ".claude/local-llm");
	mkdirSync(llmHome, { recursive: true });
	writeFileSync(
		join(llmHome, "hubs.json"),
		JSON.stringify({
			nas: { candidates: [`http://127.0.0.1:${nas.port}`] },
			desktop: { candidates: [`http://127.0.0.1:${DEAD}`] },
			vault: { candidates: [`http://127.0.0.1:${vault.port}`] },
		}),
	);
	writeFileSync(
		join(llmHome, "hubs-demo.json"),
		JSON.stringify({
			"shadow-prod": {
				note: "scenario-only capacity",
				models: ["sim-model-a"],
				simulation: {
					authorization: { principal: "k@x", scopes: ["read"], status: "granted" },
				},
			},
		}),
	);
	process.env.SUSPENDERS_LLM_HOME = llmHome;
	process.env.SUSPENDERS_LOCAL_REGISTRY = `http://127.0.0.1:${registry.port}`;

	const board = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req) =>
			(await handleFleetTree(req, new URL(req.url))) ??
			new Response("not found", { status: 404 }),
	});
	stops.push(board, registry, nas, vault);
	stops.push({
		stop: () => {
			vault.stop(true);
			registry.stop(true);
			nas.stop(true);
			board.stop(true);
			HOME && rmHome();
		},
	});

	browser = await chromium.launch();
	const ctx = await browser.newContext();
	page = await ctx.newPage();
	await page.goto(`http://127.0.0.1:${board.port}/fleet-tree`);
	await expect(page.locator("#tree")).toContainText("nas");
});

function rmHome() {
	// deferred on purpose: HOME teardown after browser close, best-effort
	try {
		require("node:fs").rmSync(HOME, { recursive: true, force: true });
	} catch {}
}

test.afterAll(async () => {
	await browser?.close();
	for (const s of stops.reverse()) s.stop();
});

const leafClass = (label: string) =>
	page.evaluate((label) => {
		const span = [...document.querySelectorAll(".leaf span")].find((n) =>
			(n.textContent ?? "").includes(label),
		);
		return span ? span.className : "absent";
	}, label);

const refresh = async () => {
	await Promise.all([
		page.waitForResponse((r) => r.url().includes("refresh=1")),
		page.getByRole("button", { name: "refresh" }).click(),
	]);
	await expect(page.locator("#refresh")).toBeEnabled();
};

test("startup renders live hub, protected hub, dead hub and simulation root", async () => {
	const t = await page.locator("#tree").innerText();
	expect(t).toContain("nas");
	expect(t).toContain("discovery: available");
	expect(t).toContain("authorization required · capacity unknown"); // vault 401
	expect(t).toContain("(down)"); // desktop unreachable
	expect(t).toContain("shadow-prod (simulation)");
	expect(t).toContain("display simulation only · no live routes or health");
	expect(t).toContain("simulated authorization: granted · k@x · read");
	await expect(page.locator("#stamp")).not.toBeEmpty();
	await page.screenshot({ path: "e2e/test-results/w5302-a-startup.png", fullPage: true });
});

test("lane stop/start transition flips the leaf on the next sweep", async () => {
	laneSrv.stop(true);
	await refresh();
	expect(await leafClass("coder :")).toContain("downleaf");
	await page.screenshot({ path: "e2e/test-results/w5302-b-stop.png", fullPage: true });
	laneSrv = Bun.serve({ hostname: "127.0.0.1", port: LANE, fetch: () => new Response("ok") });
	await refresh();
	expect(await leafClass("coder :")).toContain("up");
	await page.screenshot({ path: "e2e/test-results/w5302-b-restart.png", fullPage: true });
});

test("inaccessible registry serves last-good snapshot with the stale badge", async () => {
	registry.stop(true);
	nas.stop(true);
	vault.stop(true);
	await refresh();
	await expect(page.locator("#stamp")).toContainText("stale — last good");
	const t = await page.locator("#tree").innerText();
	expect(t).toContain("nas");
	expect(t).toContain("discovery: available"); // last-good content retained
	expect(t).toContain("shadow-prod (simulation)");
	await page.screenshot({ path: "e2e/test-results/w5302-c-stale.png", fullPage: true });
});
