// e2e/belt-topology-flows.spec.ts — W858.7.32 slice-3 browser verification:
// trace-backed lane flows on the hub topology. REAL belt modules served from
// packages/belt/bin, fed by a node:http fixture answering /api/network with a
// parametric v2 snapshot: measured edge widths, rate-bounded flow animation,
// lane counts, joined two-/three-hop traces and the uPlot edge drilldown.
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

const fixture = {
	hubCount: 3,
	staleFirstEdge: false,
	failedSecondEdge: false,
	v1: false,
	ledgerHubLink: false,
};
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

/** 15 one-minute buckets ending now; the last two carry the hops. */
const seriesFor = (hops: number) =>
	Array.from({ length: 15 }, (_, i) => ({
		t: Date.now() - (14 - i) * 60_000,
		requests: i >= 13 ? hops : 0,
		failed: 0,
	}));

/** v2 snapshot: a 3-hub chain whose hub↔hub edges carry lanes/series, each
 * hub forwarding to one provider target. Modes: stale first edge, failed
 * second edge, v1 schema (no lane/series fields), ledger hub↔hub link. */
function snapshotFor() {
	const names = Array.from({ length: fixture.hubCount }, (_, i) => nameOf(i));
	const edges = [];
	const fresh = fixture.staleFirstEdge ? ago(600_000) : ago(30_000);
	for (let i = 0; i < fixture.hubCount; i++) {
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
			...(fixture.v1
				? {}
				: { lanes: 1, activeLanes: null, series: seriesFor(1) }),
		});
		if (i > 0) {
			edges.push({
				id: `edge:hub:${names[i - 1]}->hub:${names[i]}`,
				from: `hub:${names[i - 1]}`,
				to: `hub:${names[i]}`,
				requests: i === 1 ? 8 : 45,
				failed: fixture.failedSecondEdge && i === 2 ? 2 : 0,
				active: 0,
				inputTokens: null,
				outputTokens: null,
				coverage: { source: "projection", usageBearingRequests: 0 },
				lastSeenAt: i === 1 ? fresh : ago(30_000),
				evidence: "trace",
				...(fixture.v1
					? {}
					: {
							lanes: i === 1 ? 2 : 1,
							activeLanes: i === 1 ? 1 : null,
							series: seriesFor(i === 1 ? 2 : 5),
						}),
			});
		}
	}
	if (fixture.ledgerHubLink) {
		edges.push({
			id: `edge:hub:${names[0]}->hub:${names[fixture.hubCount - 1]}`,
			from: `hub:${names[0]}`,
			to: `hub:${names[fixture.hubCount - 1]}`,
			requests: 5,
			failed: 0,
			active: 0,
			inputTokens: null,
			outputTokens: null,
			coverage: { source: "projection", usageBearingRequests: 0 },
			lastSeenAt: ago(30_000),
			evidence: "ledger",
			lanes: null,
			activeLanes: null,
			series: null,
		});
	}
	const traces = [];
	if (fixture.hubCount > 1)
		traces.push({
			id: "trace-two-hop-abcdef",
			hops: names.slice(0, 2),
			complete: true,
			lastSeenAt: ago(30_000),
		});
	if (fixture.hubCount > 2)
		traces.push({
			id: "trace-three-hop-123456",
			hops: names.slice(0, 3),
			complete: false,
			lastSeenAt: ago(45_000),
		});
	return {
		ok: true,
		schemaVersion: fixture.v1 ? 1 : 2,
		observedAt: new Date().toISOString(),
		windowStart: ago(900_000),
		hubId: "local",
		hubs: names.map(HUB),
		targets: [TARGET],
		edges,
		traces,
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
			tracesReturned: traces.length,
			tracesTotal: traces.length,
			projectionTruncated: false,
			tokensScope: "unreported",
			usageBearingOrigins: null,
			seriesEdges: fixture.v1 ? 0 : 3,
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
		"/vendor/uPlot.iife.min.js",
		"/vendor/uPlot.min.css",
	];
	if (!allowed.includes(path)) return false;
	const bytes = await readFile(join(BELT_BIN, path.replace(/^\//, "")));
	const css = path.endsWith(".css");
	res.writeHead(200, { "content-type": css ? "text/css" : "text/javascript" });
	res.end(bytes);
	return true;
};

test.beforeAll(async () => {
	server = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://fixture").pathname;
		const json = (value: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(value));
		};
		try {
			if (path === "/") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					`<!doctype html><html><head><meta charset="utf-8"><title>w858-7-32</title><style>:root{--klh-info:#8888aa;--klh-danger:#c0392b;}</style><link rel="stylesheet" href="/vendor/uPlot.min.css"><script src="/vendor/uPlot.iife.min.js"></script></head><body><belt-topology></belt-topology><belt-topology-hubs></belt-topology-hubs><script type="module">import "/dashboard-topology.js";import "/dashboard-topology-hubs.js";</script></body></html>`,
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
			if (path === "/api/remotes")
				return json({ ts: new Date().toISOString(), rows: [], routes: [] });
			if (path === "/api/network")
				return json({
					ok: true,
					ts: new Date().toISOString(),
					gateway: null,
					network: {
						ok: true,
						observations: { available: true },
						hops: [],
						throughput: { interfaces: [] },
					},
					topology: snapshotFor(),
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
	fixture.hubCount = 3;
	fixture.staleFirstEdge = false;
	fixture.failedSecondEdge = false;
	fixture.v1 = false;
	fixture.ledgerHubLink = false;
});

const A_ID = "edge:hub:hub-00->hub:hub-01";
const B_ID = "edge:hub:hub-01->hub:hub-02";

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

const shadowTextOf = async (page: Page) =>
	page.evaluate(
		() =>
			document.querySelector("belt-topology-hubs")?.shadowRoot?.textContent ??
			"",
	);

/** Class/style/stroke of the hub-link path inside a link's SVG group. */
const linkPath = (page: Page, id: string) =>
	page.evaluate((nodeId) => {
		const path = document
			.querySelector("belt-topology-hubs")
			?.shadowRoot?.querySelector(`g[data-node="${nodeId}"] path.hub-link`);
		if (!path) return null;
		return {
			cls: path.getAttribute("class") ?? "",
			style: path.getAttribute("style") ?? "",
			stroke: getComputedStyle(path).stroke,
		};
	}, id);

const canvasCount = (page: Page) =>
	page.evaluate(
		() =>
			document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelectorAll(".edge-chart canvas").length ?? 0,
	);

const inspectLink = (page: Page, from: string, to: string) =>
	page
		.locator("belt-topology-hubs tr", { hasText: from })
		.filter({ hasText: to })
		.getByRole("button", { name: "Inspect link" })
		.click();

test("two- and three-hop traces ride measured flows: widths, durations, lanes, drilldown", async ({
	page,
}) => {
	await render(page);
	// 8 hops / 15m ≈ 0.53/min → 2px, fresh → animate at the slowest bound
	const a = await linkPath(page, A_ID);
	expect(a?.style).toContain("stroke-width:2px");
	expect(a?.style).toContain("--flow-duration:12s");
	expect(a?.cls).toContain("flow");
	// 45 hops / 15m = 3/min → 3px, animate at the 6s bound
	const b = await linkPath(page, B_ID);
	expect(b?.style).toContain("stroke-width:3px");
	expect(b?.style).toContain("--flow-duration:6s");
	expect(b?.cls).toContain("flow");
	const aria = await page.evaluate(
		(nodeId) =>
			document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelector(`g[data-node="${nodeId}"]`)
				?.getAttribute("aria-label") ?? "",
		A_ID,
	);
	expect(aria).toContain("2 lanes");
	expect(aria).toContain("trace evidence");
	// the drilldown: joined two-/three-hop traces, lane counts, uPlot grid
	await inspectLink(page, "hub-00", "hub-01");
	await expect
		.poll(async () => shadowTextOf(page), { timeout: 5_000 })
		.toContain("Link · hub-00 → hub-01");
	const text = await shadowTextOf(page);
	expect(text).toContain("2 in the window · 1 active");
	expect(text).toContain("Joined traces · 2");
	expect(text).toContain("partial");
	await expect
		.poll(async () => canvasCount(page), { timeout: 5_000 })
		.toBeGreaterThan(0);
	await inspectLink(page, "hub-01", "hub-02");
	await expect
		.poll(async () => shadowTextOf(page), { timeout: 5_000 })
		.toContain("Link · hub-01 → hub-02");
	const bText = await shadowTextOf(page);
	expect(bText).toContain("Joined traces · 1");
	expect(bText).toContain("active unreported");
});

test("stale telemetry renders distinctly: numbers stay, dashes stop", async ({
	page,
}) => {
	fixture.staleFirstEdge = true;
	await render(page);
	const a = await linkPath(page, A_ID);
	expect(a?.cls).not.toContain("flow");
	expect(a?.style).not.toContain("--flow-duration");
	await inspectLink(page, "hub-00", "hub-01");
	await expect
		.poll(async () => shadowTextOf(page), { timeout: 5_000 })
		.toContain("stale, flow off");
});

test("reduced motion turns the flow off", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await render(page);
	const anim = await page.evaluate((nodeId) => {
		const path = document
			.querySelector("belt-topology-hubs")
			?.shadowRoot?.querySelector(`g[data-node="${nodeId}"] path.hub-link`);
		return path ? getComputedStyle(path).animationName : null;
	}, A_ID);
	expect(anim).toBe("none");
});

test("hiding the tab pauses the flow", async ({ page }) => {
	await render(page);
	const state = await page.evaluate(async (nodeId) => {
		const pause = (hidden: boolean) => {
			Object.defineProperty(document, "hidden", {
				configurable: true,
				get: () => hidden,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		};
		const component = document.querySelector("belt-topology-hubs") as {
			updateComplete?: Promise<boolean>;
		} | null;
		const path = () =>
			document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelector(`g[data-node="${nodeId}"] path.hub-link`);
		pause(true);
		await (component?.updateComplete ?? Promise.resolve());
		await new Promise((done) => requestAnimationFrame(() => done(null)));
		const paused = {
			section: document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelector("section")
				?.getAttribute("class"),
			playState: path()
				? getComputedStyle(path() as Element).animationPlayState
				: null,
		};
		return { paused };
	}, A_ID);
	expect(state.paused.section).toContain("flow-paused");
	expect(state.paused.playState).toBe("paused");
});

test("failed telemetry renders red and distinct", async ({ page }) => {
	fixture.failedSecondEdge = true;
	await render(page);
	const a = await linkPath(page, A_ID);
	const b = await linkPath(page, B_ID);
	expect(b?.cls).toContain("failed");
	expect(a?.stroke).not.toBe(b?.stroke);
});

test("v1 snapshot degrades honestly: lanes unreported, no grid, flow survives", async ({
	page,
}) => {
	fixture.v1 = true;
	await render(page);
	const a = await linkPath(page, A_ID);
	expect(a?.cls).toContain("flow");
	const aria = await page.evaluate(
		(nodeId) =>
			document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelector(`g[data-node="${nodeId}"]`)
				?.getAttribute("aria-label") ?? "",
		A_ID,
	);
	expect(aria).toContain("lanes unreported");
	await inspectLink(page, "hub-00", "hub-01");
	await expect
		.poll(async () => shadowTextOf(page), { timeout: 5_000 })
		.toContain("Link · hub-00 → hub-01");
	const text = await shadowTextOf(page);
	expect(text).toContain("unreported");
	expect(text).toContain("No per-minute grid for this edge");
	expect(await canvasCount(page)).toBe(0);
});

test("ledger hub links render dashed and never animate", async ({ page }) => {
	fixture.ledgerHubLink = true;
	await render(page);
	// ledger hub↔hub edges ride the connected layer, not observed
	await page
		.locator("belt-topology-hubs label", { hasText: "connected" })
		.locator("input")
		.check();
	const ledgerId = "edge:hub:hub-00->hub:hub-02";
	await expect
		.poll(async () => linkPath(page, ledgerId), { timeout: 5_000 })
		.not.toBeNull();
	const led = await linkPath(page, ledgerId);
	expect(led?.cls).toContain("ledger");
	expect(led?.cls).not.toContain("flow");
	await inspectLink(page, "hub-00", "hub-02");
	await expect
		.poll(async () => shadowTextOf(page), { timeout: 5_000 })
		.toContain("Link · hub-00 → hub-02");
	const aria = await page.evaluate(
		(nodeId) =>
			document
				.querySelector("belt-topology-hubs")
				?.shadowRoot?.querySelector(`g[data-node="${nodeId}"]`)
				?.getAttribute("aria-label") ?? "",
		ledgerId,
	);
	expect(aria).toContain("ledger evidence");
	expect(aria).toContain("lanes unreported");
	const text = await shadowTextOf(page);
	expect(text).not.toContain("flow animating");
	expect(text).toContain("Joined traces · 0");
	expect(text).toContain("a ledger target edge never claims a provider hop.");
});
