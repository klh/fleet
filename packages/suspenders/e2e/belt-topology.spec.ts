// e2e/belt-topology.spec.ts — W993.4: every observed hub→provider connection
// renders independently of preferred-card placement. Real Chromium (the
// Playwright runner) rides the REAL belt component+model modules served from
// packages/belt/bin, fed by a node:http fixture answering the dashboard APIs.
// The pre-fix negative control (only the placement hub rendered its observed
// edge) is banked in /tmp/fleet-W993-browser-negative.log.
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

type Observation = {
	hub: string;
	provider: string;
	successes15: number;
	failures15: number;
	lastStatus: number;
	lastAt: string;
};

const fixture = { observed: [] as Observation[] };

const observation = (hub: string, ageMs: number): Observation => ({
	hub,
	provider: "copilot",
	successes15: 3,
	failures15: 0,
	lastStatus: 200,
	lastAt: new Date(Date.now() - ageMs).toISOString(),
});

const HUBS = [
	{ kind: "hub", name: "alpha", state: "up", port: 4101 },
	{ kind: "hub", name: "beta", state: "up", port: 4111 },
];
const HUB_ROUTES = [
	{
		name: "alpha",
		providerIntents: ["copilot"],
		providerHosts: ["api.githubcopilot.com"],
	},
	{ name: "beta", providerIntents: ["copilot"] },
];

let server: Server;
let base = "";

const serveFile = async (
	res: import("node:http").ServerResponse,
	path: string,
): Promise<boolean> => {
	if (
		path !== "/dashboard-topology.js" &&
		path !== "/dashboard-topology-model.js" &&
		path !== "/vendor/lit.js"
	)
		return false;
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
					`<!doctype html><html><head><meta charset="utf-8"><title>w993.4</title></head><body><belt-topology></belt-topology><script type="module">import "/dashboard-topology.js";</script></body></html>`,
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
					targets: HUBS,
				});
			if (path === "/api/network")
				return json({
					ok: true,
					ts,
					network: {
						ok: true,
						observations: { available: true },
						hops: [],
						throughput: { interfaces: [] },
					},
				});
			if (path === "/api/topology-context")
				return json({
					hubConsoles: [],
					hubRoutes: HUB_ROUTES,
					hubProviderObservations: fixture.observed,
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
	fixture.observed = [];
});

const edgeTitles = (page: Page): Promise<string[]> =>
	page.evaluate(() => {
		const root = document.querySelector("belt-topology")?.shadowRoot;
		return root
			? Array.from(root.querySelectorAll("path.edge")).map(
					(edge) =>
						edge.closest("g")?.querySelector("title")?.textContent ?? "",
				)
			: [];
	});

const gTitles = (page: Page): Promise<string[]> =>
	page.evaluate(() => {
		const root = document.querySelector("belt-topology")?.shadowRoot;
		return root
			? Array.from(root.querySelectorAll("g title")).map(
					(title) => title.textContent ?? "",
				)
			: [];
	});

async function render(page: Page): Promise<void> {
	await page.goto(base);
	await page.waitForFunction(() =>
		Boolean(
			document
				.querySelector("belt-topology")
				?.shadowRoot?.querySelector(".map svg"),
		),
	);
}

test("placement-only world keeps the configured edge on the preferred hub", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	await render(page);
	const titles = await edgeTitles(page);
	expect(titles.filter((title) => title.includes("Buckle ledger"))).toEqual([]);
	expect(
		titles.filter((title) => title.includes("configured upstream")),
	).toEqual(["Configured path · alpha configured upstream"]);
	expect(
		(await gTitles(page)).some((title) => title.includes("shown under alpha")),
	).toBe(true);
});

test("draws every observed hub link, not just the placement hub", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.observed = [
		observation("alpha", 30_000),
		observation("beta", 45_000),
	];
	await render(page);
	expect(
		(await edgeTitles(page)).filter((title) => title.includes("Buckle ledger")),
	).toEqual([
		expect.stringContaining("alpha Buckle ledger"),
		expect.stringContaining("beta Buckle ledger"),
	]);
	expect(
		(await gTitles(page)).some((title) => title.includes("shown under alpha")),
	).toBe(true);
});

test("failover: a stale hub's edge disappears, the peer stays observed", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.observed = [
		observation("alpha", 16 * 60_000),
		observation("beta", 30_000),
	];
	await render(page);
	expect(
		(await edgeTitles(page)).filter((title) => title.includes("Buckle ledger")),
	).toEqual([expect.stringContaining("beta Buckle ledger")]);
	// no fabricated replacement: alpha keeps no edge, and the preferred card
	// placement follows the hub still carrying fresh evidence
	const titles = await edgeTitles(page);
	expect(titles.some((title) => title.includes("alpha"))).toBe(false);
	expect(
		(await gTitles(page)).some((title) => title.includes("shown under beta")),
	).toBe(true);
});
