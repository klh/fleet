import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import type { AppDeps } from "../src/app-deps.ts";
import { consoleRoute } from "../src/console-route.ts";
import { classify } from "../src/gov/middleware.ts";

const deps = { hubId: "test-hub" } as AppDeps;

test.describe("@unit Buckle installation console", () => {
	test("serves a Buckle-owned shell and bundled client", async () => {
		const page = await consoleRoute(
			new Request("http://localhost/console"),
			deps,
		);
		expect(page?.status).toBe(200);
		expect(page?.headers.get("content-security-policy")).toContain(
			"connect-src 'self'",
		);
		expect(await page?.text()).toContain("<buckle-console>");
		const app = await consoleRoute(
			new Request("http://localhost/console/app.js"),
			deps,
		);
		expect(app?.status).toBe(200);
		expect(await app?.text()).toContain("buckle-console");
	});

	test("navigates overview, status, settings, and the statistics placeholder", async ({
		page,
	}, testInfo) => {
		const server = serveStub(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/status")
				return Response.json({
					service: "buckle",
					healthy: true,
					port: 4101,
					uptime_s: 120,
					requests: { total: 5 },
				});
			if (path === "/v1/models")
				return Response.json({ data: [{ id: "test-model" }] });
			if (path === "/console/data")
				return Response.json({
					hub: "This Mac",
					observedAt: new Date().toISOString(),
					topology: {
						hubs: [{ id: "hub:peer", name: "Peer hub", freshnessS: 2 }],
						targets: [
							{ id: "target:cloud", kind: "cloud", host: "api.example.test" },
						],
						edges: [
							{
								from: "hub:peer",
								to: "target:cloud",
								requests: 3,
								failed: 0,
								active: 0,
							},
						],
						totals: { requests: 3, failed: 0, active: 0 },
						coverage: { ledgerAvailable: true, projectionAvailable: true },
					},
				});
			return (
				(await consoleRoute(request, deps)) ??
				new Response("not found", { status: 404 })
			);
		});
		try {
			await page.goto(`${server.url}/console`);
			await expect(page.getByText("Peer hub")).toBeVisible();
			await expect(page.getByText("test-model")).toBeVisible();
			await page.screenshot({
				path: testInfo.outputPath("overview.png"),
				fullPage: true,
			});
			await page.getByRole("button", { name: /Status/ }).click();
			await expect(page.getByText("Self-reported health")).toBeVisible();
			await page.getByRole("button", { name: /Settings/ }).click();
			await expect(page.getByLabel("Read key")).toBeVisible();
			await page.getByRole("button", { name: /Statistics/ }).click();
			await expect(
				page.getByText(
					"This section is reserved for gateway usage and trends.",
				),
			).toBeVisible();
		} finally {
			server.close();
		}
	});

	test("protects the network snapshot with the existing proxy read gate", async () => {
		expect(classify("/console")).toBe("public");
		expect(classify("/console/app.js")).toBe("public");
		expect(classify("/console/data")).toBe("proxy");
		const response = await consoleRoute(
			new Request("http://localhost/console/data"),
			deps,
		);
		expect(response?.status).toBe(200);
		const body = await response?.json();
		expect(body.hub).toBe("test-hub");
		expect(body.topology === null || Array.isArray(body.topology.hubs)).toBe(
			true,
		);
	});
});
