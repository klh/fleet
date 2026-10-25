// e2e/belt-topology-hubs.spec.ts — W858.7.31 slice-2 browser verification
// (THE DONE DIGEST: 1/10/100 hub fixtures). The hub-first overview —
// aggregated cards, layer/window controls, search, inspector drawer and
// accessible lists — rides REAL belt modules served from packages/belt/bin,
// fed by a node:http fixture answering the dashboard APIs with parametric
// topology snapshots. Camera stability rides the host's live 10s refresh.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const BELT_BIN = join(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"..",
	"..",
	"packages",
	"belt",
	"bin",
);

const fixture = { hubCount: 1 };
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const nameOf = (i: number) => `hub-${String(i).padStart(2, "0")}`;

const HUB = (name: string) => ({
	id: `hub:${name}`,
	name,
	lastSeenAt: ago(30_000),
});
const TARGET = {
	id: "target:provider:api.z.ai:443",
	kind: "provider",
	host: "api.z.ai",
	port: 443,
	lastSeenAt: ago(30_000),
};

/** Topology snapshot v1: a chain of hubs, each forwarding to one provider. */
function snapshotFor(count: number) {
	const names = Array.from({ length: count }, (_, i) => nameOf(i));
	const edges = [];
	for (let i = 0; i < count; i++) {
		edges.push({
			id: `edge:hub:${names[i]}->${TARGET.id}`,
			from: `hub:${names[i]}`,
			to: TARGET.id,
			requests: 4,
			failed: 1,
			active: 0,
			inputTokens: 120,
			outputTokens: 340,
			coverage: { source: "projection", usageBearingRequests: 3 },
			lastSeenAt: ago(30_000),
			evidence: "trace",
		});
		if (i > 0) {
			edges.push({
				id: `edge:hub:${names[i - 1]}->hub:${names[i]}`,
				from: `hub:${names[i - 1]}`,
				to: `hub:${names[i]}`,
				requests: 2,
				failed: 0,
				active: 0,
				inputTokens: null,
				outputTokens: null,
				coverage: { source: "projection", usageBearingRequests: 0 },
				lastSeenAt: ago(30_000),
				evidence: "trace",
			});
		}
	}
	return {
		ok: true,
		schemaVersion: 1,
		observedAt: now(),
		windowStart: ago(900_000),
		hubId: "local",
		hubs: names.map(HUB),
		targets: [TARGET],
		edges,
		traces:
			count > 1
				? [
						{
							id: "trace-abc123",
							hops: names.slice(0, 2),
							complete: true,
							lastSeenAt: ago(30_000),
						},
					]
				: [],
		totals: {
			requests: null,
			failed: null,
			active: null,
			inputTokens: null,
			outputTokens: null,
		},
		coverage: {
			projectionAvailable: true,
			ledgerAvailable: false,
			tracesReturned: 1,
			tracesTotal: 1,
			projectionTruncated: false,
			tokensScope: "unreported",
			usageBearingOrigins: null,
		},
	};
}

let server: Server;
let base = "";

const serveFile = async (
	res: import("node:http").ServerResponse,
	path: string,
): Promise<boolean> => {
	const allowed = [
		"/dashboard-topology.js",
		"/dashboard-topology-model.js",
		"/dashboard-topology-hubs.js",
		"/dashboard-topology-hubs-model.js",
		"/vendor/lit.js",
	];
	if (!allowed.includes(path)) return false;
	const bytes = await readFile(join(BELT_BIN, path.replace(/^\//, "")));
	res.writeHead(200, { "content-type": "text/javascript" });
	res.end(bytes);
	return true;
};

test.beforeAll(async () => {
	server = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://fixture").pathname;
		const ts = new Date().toISOString();
		const json = (value: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(value));
		};
		try {
			if (path === "/") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					`<!doctype html><html><head><meta charset="utf-8"><title>w858-7-31</title></head><body><belt-topology></belt-topology><belt-topology-hubs></belt-topology-hubs><script type="module">import "/dashboard-topology.js";import "/dashboard-topology-hubs.js";</script></body></html>`,
				);
				return;
			}
			if (await serveFile(res, path)) return;
			if (path === "/api/status")
				return json({
					router: { up: true },
					specialists: [],
					observation: { expiresAt: Date.now() + 10_000 },
				});
			if (path === "/api/remotes") return json({ ts, rows: [], routes: [] });
			if (path === "/api/supervisor")
				return json({
					observation: { expiresAt: Date.now() + 10_000 },
					targets: Array.from({ length: fixture.hubCount }, (_, i) => ({
						kind: "hub",
						name: nameOf(i),
						state: "up",
						port: 4101 + i,
					})),
				});
			if (path === "/api/network")
				return json({
					ok: true,
					ts,
					gateway: null,
					network: {
						ok: true,
						observations: { available: true },
						hops: [],
						throughput: { interfaces: [] },
					},
					topology: snapshotFor(fixture.hubCount),
				});
			if (path === "/api/topology-context")
				return json({
					hubConsoles: [],
					hubRoutes: Array.from({ length: fixture.hubCount }, (_, i) => ({
						name: nameOf(i),
						providerIntents: [],
						providerHosts: [],
						models: ["glm-5.3-flash"],
					})),
					hubProviderObservations: [],
				});
			res.writeHead(404);
			res.end("no");
		} catch (error) {
			res.writeHead(500);
			res.end(String(error));
		}
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
});

test.afterAll(async () => {
	await new Promise<void>((done) => server.close(() => done()));
});

test.beforeEach(() => {
	fixture.hubCount = 1;
});

const render = async (page: Page) => {
	await page.goto(base);
	await page.waitForFunction(() =>
		Boolean(
			document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelector("svg"),
		),
	);
};

const cards = (page: Page) =>
	page.evaluate(() => {
		const shadow =
			document.querySelector("belt-topology-hubs")?.shadowRoot ?? null;
		if (!shadow) return [];
		return Array.from(
			shadow.querySelectorAll("g[aria-label$='observed endpoints']"),
		).map((node) => node.getAttribute("aria-label") ?? "");
	});

const rows = (page: Page) =>
	page.evaluate(() => {
		const shadow =
			document.querySelector("belt-topology-hubs")?.shadowRoot ?? null;
		return shadow
			? Array.from(shadow.querySelectorAll("table.hub-list tbody tr")).map(
					(tr) => tr.textContent ?? "",
				)
			: [];
	});

test("one hub renders its aggregated card, metrics and accessible list", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	await render(page);
	const list = await cards(page);
	expect(list).toHaveLength(1);
	expect(list[0]).toContain("hub-00");
	expect(list[0]).toContain("active");
	expect(list[0]).toContain("4 hops");
	expect(list[0]).toContain("1 observed endpoints");
	const table = await rows(page);
	expect(table).toHaveLength(1);
	const shadowText = await page.evaluate(
		() =>
			document.querySelector("belt-topology-hubs")?.shadowRoot?.textContent ??
			"",
	);
	expect(shadowText).toContain("hubs in view");
	const windowTitles = await page.evaluate(() =>
		Array.from(
			document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelectorAll("input[disabled]") ?? [],
		).map((input) => input.getAttribute("title") ?? ""),
	);
	expect(windowTitles).toHaveLength(2);
	expect(windowTitles[0]).toContain("15m window");
	expect(shadowText).toContain("Select a hub card");
});

test("ten hubs: chain renders, search narrows, drawer inspects hub-05", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.hubCount = 10;
	await render(page);
	expect(await cards(page)).toHaveLength(10);
	expect(await rows(page)).toHaveLength(10);
	const input = page.locator("belt-topology-hubs input[type=search]");
	await input.fill("hub-03");
	await expect
		.poll(async () => (await cards(page)).length, { timeout: 5_000 })
		.toBe(10);
	const shadowText = await page.evaluate(
		() =>
			document.querySelector("belt-topology-hubs")?.shadowRoot?.textContent ??
			"",
	);
	expect(shadowText).toContain("Search hits:");
	const hit = page
		.locator("belt-topology-hubs")
		.getByRole("button", { name: "hub-03" })
		.first();
	await hit.click();
	await expect
		.poll(async () => shadowTextOf(page), { timeout: 5_000 })
		.toContain("hub-03");
	const drawer = await shadowTextOf(page);
	expect(drawer).toContain("Observed endpoints · 1");
	expect(drawer).toContain("Model inventory · 1");
	expect(drawer).toContain("glm-5.3-flash");
	expect(drawer).toContain("Input / output tokens");
	expect(drawer).toContain("120");
});

const shadowTextOf = async (page: Page) =>
	page.evaluate(
		() =>
			document.querySelector("belt-topology-hubs")?.shadowRoot?.textContent ??
			"",
	);

test("a hundred hubs all render; the map grows and stays scrollable", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.hubCount = 100;
	await render(page);
	expect(await cards(page)).toHaveLength(100);
	expect(await rows(page)).toHaveLength(100);
	const width = await page.evaluate(() => {
		const map = document
			.querySelector("belt-topology-hubs")
			?.shadowRoot?.querySelector(".hubs-map");
		return map ? { sw: map.scrollWidth, cw: map.clientWidth } : null;
	});
	expect(width).not.toBeNull();
	expect(Number(width?.sw) - Number(width?.cw)).toBeGreaterThan(100);
});

test("camera stability: scroll, selection and drawer survive the live 10s refresh", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.hubCount = 10;
	await render(page);
	const input = page.locator("belt-topology-hubs input[type=search]");
	await input.fill("hub-05");
	await page
		.locator("belt-topology-hubs")
		.getByRole("button", { name: "hub-05" })
		.first()
		.click();
	await expect
		.poll(async () => shadowTextOf(page), { timeout: 5_000 })
		.toContain("Observed endpoints · 1");
	await input.fill("");
	const scroll = await page.evaluate(() => {
		const map = document
			.querySelector("belt-topology-hubs")
			?.shadowRoot?.querySelector(".hubs-map");
		if (!map) return null;
		map.scrollTop = 84;
		map.scrollLeft = 200;
		return { top: map.scrollTop, left: map.scrollLeft };
	});
	expect(scroll).toEqual({ top: 84, left: 200 });
	await page.waitForTimeout(11_000);
	const after = await page.evaluate(() => {
		const map = document
			.querySelector("belt-topology-hubs")
			?.shadowRoot?.querySelector(".hubs-map");
		return {
			top: map?.scrollTop,
			left: map?.scrollLeft,
			drawer: document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelector(".inspector")?.textContent,
		};
	});
	expect(after).toEqual(expect.objectContaining({ top: 84, left: 200 }));
	expect(after.drawer).toContain("hub-05");
});
