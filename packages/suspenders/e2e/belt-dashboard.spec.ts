// e2e/belt-dashboard.spec.ts — W1270: the belt dashboard's observability and
// model-access surfaces render from their REAL shipped modules (packages/belt/
// bin) fed by a node:http fixture answering the dashboard APIs (the
// belt-topology.spec.ts pattern, extended past topology to the supervisor
// panel, the sparse-raster trends and the model-access catalog).

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { displayLabel } from "../../belt/bin/klh-theme.ts";

const BELT_BIN = join(
	fileURLToPath(import.meta.url),
	"..",
	"..",
	"..",
	"belt",
	"bin",
);
const OBSERVATION_TS = join(
	BELT_BIN,
	"..",
	"..",
	"local-llm",
	"observation.ts",
);

interface FixtureTarget {
	name: string;
	port: number;
	kind: "resident" | "ondemand" | "hub";
	state: string;
	lastProbe: string;
	owned?: boolean;
	alert?: boolean;
	lastError?: string;
	restarts?: number;
	restartsLastWindow?: number;
	lastOk?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const fixture = {
	targets: [] as FixtureTarget[],
	updatedAgoMs: 1_000,
	supervisorMissing: false,
	supervisorFail: false,
	history: {
		windowMs: 6 * 3_600_000,
		buckets: [] as [number, number, number, number | null, number][],
		endpoints: [] as { key: string; counts: number[]; models?: string[] }[],
	},
	historyFail: false,
	accessFail: false,
};

let server: Server;
let base = "";

const jsHeaders = { "content-type": "text/javascript" };

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
					`<!doctype html><html><head><meta charset="utf-8"><title>w1270 belt dashboard</title></head><body>` +
						`<belt-supervisor></belt-supervisor><belt-trends></belt-trends><div id="modelaccess"></div>` +
						`<script type="module">import "/dashboard-observability.js";</script>` +
						`<script type="module">import "/dashboard-model-access.js";</script></body></html>`,
				);
				return;
			}
			if (path === "/vendor/lit.js") {
				res.writeHead(200, jsHeaders);
				res.end(await readFile(join(BELT_BIN, "vendor", "lit.js")));
				return;
			}
			if (path === "/dashboard-state.js") {
				res.writeHead(200, jsHeaders);
				res.end(
					new Bun.Transpiler({ loader: "ts" }).transformSync(
						await readFile(join(BELT_BIN, "dashboard-state.ts"), "utf8"),
					),
				);
				return;
			}
			if (path === "/observation.js") {
				res.writeHead(200, jsHeaders);
				res.end(
					new Bun.Transpiler({ loader: "ts" }).transformSync(
						await readFile(OBSERVATION_TS, "utf8"),
					),
				);
				return;
			}
			if (path === "/dashboard-observability.js") {
				// the production serve path (dashboard.ts) prepends the
				// displayLabel helper the panel's rows call — same trick here
				res.writeHead(200, jsHeaders);
				res.end(
					`const displayLabel = ${displayLabel.toString()};\n${await readFile(
						join(BELT_BIN, "dashboard-observability.js"),
						"utf8",
					)}`,
				);
				return;
			}
			if (path === "/dashboard-model-access.js") {
				res.writeHead(200, jsHeaders);
				res.end(await readFile(join(BELT_BIN, "dashboard-model-access.js")));
				return;
			}
			if (path === "/api/supervisor") {
				if (fixture.supervisorFail) {
					res.writeHead(500);
					res.end("no");
					return;
				}
				if (fixture.supervisorMissing) {
					json(null);
					return;
				}
				const now = Date.now();
				json({
					intervalMs: 30_000,
					updated: iso(now - fixture.updatedAgoMs),
					observation: {
						source: "belt-supervisor",
						target: "supervised-targets",
						scope: "local-machine",
						kind: "supervisor",
						observedAt: now - fixture.updatedAgoMs,
						expiresAt: now + 600_000,
					},
					targets: fixture.targets,
				});
				return;
			}
			if (path === "/api/metrics/history") {
				if (fixture.historyFail) {
					res.writeHead(500);
					res.end("no");
					return;
				}
				json(fixture.history);
				return;
			}
			if (path === "/api/model-access") {
				if (fixture.accessFail) {
					res.writeHead(500);
					res.end("no");
					return;
				}
				json({
					copilot: {
						state: "live",
						models: [
							{
								id: "claude-sonnet-5.5",
								name: "Copilot Sonnet",
								vendor: "github",
								endpoints: ["/chat/completions", "/v1/messages"],
								routes: ["anthropic"],
								price: { status: "included-unreported" },
							},
						],
					},
					personal: { claude: "live", chatgpt: "live" },
					openrouter: {
						state: "live",
						fetchedAt: iso(Date.now() - 60_000),
						models: [
							{
								id: "z-ai/glm-free",
								name: "GLM free",
								price: { status: "free" },
							},
							{
								id: "z-ai/glm-priced",
								name: "GLM priced",
								price: { status: "unknown", note: "token price unreported" },
							},
						],
					},
					zaiPricing: {
						state: "live",
						fetchedAt: iso(Date.now() - 120_000),
						source: "https://zai.example/prices",
						models: [{ id: "glm-5", price: { status: "free" } }],
					},
					zaiAccount: { state: "available", modelIds: ["glm-5"] },
				});
				return;
			}
			if (path === "/api/model-capabilities") {
				const when = iso(Date.now() - 30_000);
				json({
					state: "live",
					observedAt: when,
					sources: { openrouter: "live", persistence: "ok" },
					records: [
						{
							provider: "copilot",
							modelId: "claude-sonnet-5.5",
							contextTokens: {
								value: 200_000,
								source: "https://docs.example.net/claude",
								observedAt: when,
							},
							maxOutputTokens: {
								value: 64_000,
								source: "https://docs.example.net/claude",
								observedAt: when,
							},
							inputModalities: { value: ["text", "image"], source: "docs" },
							outputModalities: { value: ["text"], source: "docs" },
							tools: { value: true, source: "docs" },
							structuredOutput: { value: true, source: "docs" },
							cost: {
								value: null,
								source: "https://docs.example.net/price",
								observedAt: when,
							},
						},
						{
							provider: "belt-local",
							modelId: "qwen3-coder-30b",
							contextTokens: {
								value: 262_144,
								source: "local probe",
								observedAt: when,
							},
							maxOutputTokens: { value: null, source: "local probe" },
							inputModalities: { value: ["text"], source: "local probe" },
							outputModalities: { value: ["text"], source: "local probe" },
							tools: { value: true, source: "local probe" },
							structuredOutput: { value: null, source: "local probe" },
							cost: { value: null, source: "local runtime", observedAt: when },
						},
					],
				});
				return;
			}
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
	fixture.targets = [
		{
			name: "router",
			port: 4000,
			kind: "resident",
			state: "up",
			owned: true,
			lastProbe: iso(Date.now() - 2_000),
			lastOk: iso(Date.now() - 2_000),
			restarts: 2,
			restartsLastWindow: 0,
		},
		{
			name: "extract",
			port: 8902,
			kind: "ondemand",
			state: "idle",
			lastProbe: iso(Date.now() - 2_000),
		},
		{
			name: "coder",
			port: 8901,
			kind: "ondemand",
			state: "backoff",
			alert: true,
			lastProbe: iso(Date.now() - 2_000),
			lastError: "upstream 429 wall held for the whole walk",
		},
		{
			name: "nas",
			port: 4101,
			kind: "hub",
			state: "up",
			lastProbe: iso(Date.now() - 2_000),
		},
	];
	fixture.updatedAgoMs = 1_000;
	fixture.supervisorMissing = false;
	fixture.supervisorFail = false;
	fixture.historyFail = false;
	fixture.accessFail = false;
	const t0 = Math.floor((Date.now() - 900_000) / 1000);
	fixture.history = {
		windowMs: 6 * 3_600_000,
		buckets: [
			[t0, 1, 0, 12_000, 1],
			[t0 + 300, 1, 1, null, 0],
			[t0 + 600, 0, 0, null, 0],
		],
		endpoints: [{ key: ":8901 coder", counts: [1, 1, 0] }],
	};
});

const expandSupervisor = async (page: Page): Promise<void> => {
	await page.goto(base);
	const panel = page.locator("belt-supervisor");
	await expect(panel).toBeVisible();
	await panel.locator("details").first().click();
};

test("supervisor panel renders the fresh snapshot with per-target states", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	await expandSupervisor(page);
	const panel = page.locator("belt-supervisor");
	await expect(
		panel.getByText(/1 need attention · 1 on demand · probes \d+s ago/),
	).toBeVisible();
	await expect(panel.getByText("Evidence: belt-supervisor")).toBeVisible();
	// resident row: label + supervised evidence, expanded on demand
	const router = panel.locator("details details", { hasText: "router :4000" });
	await expect(router).toHaveCount(1);
	await router.locator("summary").click();
	await expect(
		router.getByText(
			"resident · supervised · 0 restarts in budget window · 2 total",
		),
	).toBeVisible();
	// on-demand row renders the idle label
	await expect(
		panel.getByText("extract :8902").getByText("idle · on demand"),
	).toBeVisible();
	// the alerting row keeps its error reason
	const coder = panel.locator("details details", { hasText: "coder :8901" });
	await coder.locator("summary").click();
	await expect(
		coder.first().getByText("upstream 429 wall held for the whole walk"),
	).toBeVisible();
	// hubs render under their own group heading
	await expect(
		panel.getByText("hubs — remote buckle fronts, probe-only"),
	).toBeVisible();
	await expect(panel.getByText("nas :4101")).toBeVisible();
});

test("stale snapshot degrades to unknown; missing feed removes the panel", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.updatedAgoMs = 600_000;
	await expandSupervisor(page);
	const panel = page.locator("belt-supervisor");
	await expect(
		panel.getByText(/Supervisor snapshot stale \(\d+s old\)/),
	).toBeVisible();
	await expect(panel.getByText("router :4000")).toBeVisible();
	// stale evidence renders the unknown label, never a stale state as current
	await expect(panel.getByText("unknown").first()).toBeVisible();

	// W853: no supervisor ever → the panel removes itself entirely
	fixture.supervisorMissing = true;
	await page.goto(base);
	await expect(page.locator("belt-supervisor")).toBeAttached();
	expect(
		await page
			.locator("belt-supervisor")
			.evaluate((el) => el.shadowRoot?.textContent ?? ""),
	).not.toContain("Supervisor");
});

test("supervisor feed failure surfaces the alert", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.supervisorFail = true;
	await page.goto(base);
	await expect(
		page
			.locator("belt-supervisor")
			.getByText("Supervisor feed unavailable: HTTP 500"),
	).toBeVisible();
});

test("trends renders the sparse activity raster and the per-bucket table", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	await page.goto(base);
	const trends = page.locator("belt-trends");
	await expect(trends).toBeVisible();
	await expect(
		trends.getByText("Trends · 6h · 2 Belt routes · 1 failed"),
	).toBeVisible();
	const raster = trends.locator(".bt-raster");
	await expect(raster).toBeVisible();
	await expect(raster).toHaveAttribute(
		"aria-label",
		"2 intervals had Belt routes in the last six hours",
	);
	await expect(raster.locator(".bt-cell.active")).toHaveCount(2);
	await expect(raster.locator(".bt-cell.failed")).toHaveCount(1);
	// the per-bucket table pairs the failed bucket with its endpoint and the
	// honest no-sample dash (avg stays undefined, never 0 ms)
	const coderRow = trends.locator("tr", { hasText: ":8901 coder" }).first();
	await expect(coderRow).toBeVisible();
	await expect(coderRow).toContainText("—");
});

test("trends degrades honestly without the chart engine and on feed errors", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	const t0 = Math.floor((Date.now() - 900_000) / 1000);
	fixture.history = {
		windowMs: 6 * 3_600_000,
		buckets: Array.from({ length: 12 }, (_, i) => {
			return [t0 + i * 300, 1, 0, null, 0] as [
				number,
				number,
				number,
				number | null,
				number,
			];
		}),
		endpoints: [],
	};
	await page.goto(base);
	const trends = page.locator("belt-trends");
	await expect(
		trends.getByText("Trends · 6h · 12 Belt routes · 0 failed"),
	).toBeVisible();
	await expect(
		trends.getByText("chart engine not loaded — trend charts degraded"),
	).toBeVisible();

	fixture.historyFail = true;
	await page.goto(base);
	await expect(
		trends.getByText("Trend feed unavailable: HTTP 500"),
	).toBeVisible();
});

test("model access renders seats, catalog groups and capability provenance", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	await page.goto(base);
	const box = page.locator("#modelaccess");
	await expect(
		box.getByText("IKEA Copilot · live · 1 selectable models"),
	).toBeVisible();
	await expect(box.getByText("Personal Claude CLI · live")).toBeVisible();
	await expect(
		box.getByText("Personal ChatGPT/Codex CLI · live"),
	).toBeVisible();
	// copilot group: route + subscription price + capability row
	const copilot = box.locator("details", { hasText: "github · 1 model" });
	await expect(copilot).toBeVisible();
	await copilot.locator("summary").click();
	await expect(
		copilot.getByText(
			"local/Copilot/anthropic · subscription access · token price unreported",
		),
	).toBeVisible();
	await expect(
		copilot.getByText(
			"context 200,000 tokens · max output 64,000 tokens · input text, image · output text · tools yes · structured yes",
		),
	).toBeVisible();
	// openrouter groups split free from priced
	const free = box.locator("details", {
		hasText: "OpenRouter FREE · 1 models",
	});
	await free.locator("summary").click();
	await expect(
		free.getByText("FREE · $0 in / $0 out per 1M tokens"),
	).toBeVisible();
	// z.ai group marks the account-visible model
	const zai = box.locator("details", {
		hasText: "Z.ai model prices · 1 published",
	});
	await zai.locator("summary").click();
	await expect(zai.getByText("glm-5 · account visible")).toBeVisible();
	// belt-local group carries the unpriced local row
	const local = box.locator("details", { hasText: "Belt local models · 1" });
	await local.locator("summary").click();
	await expect(local.getByText("qwen3-coder-30b")).toBeVisible();
	// capabilities header rides its own provenance note
	await expect(
		box.getByText(
			/Capabilities · live · OpenRouter live · snapshot ok · checked /,
		),
	).toBeVisible();
});

test("model access feed failure degrades to the honest error line", {
	tag: ["@ui", "@smoke"],
}, async ({ page }) => {
	fixture.accessFail = true;
	await page.goto(base);
	await expect(
		page
			.locator("#modelaccess")
			.getByText("Model access unavailable · HTTP 500"),
	).toBeVisible();
});
