// test/coord-hubs-models.e2e.ts — W2635: `coord hubs --json` carries each
// up hub's model offerings with the concurrency/connection numbers
// map.prefer pins are decided against (hub= picks the hub, must=/prefer=
// picks the model). A real Bun.serve hub answers /v1/models with pool-bound
// rows; the stack token authenticates; pools aggregate per hub. JSON stack
// fixture (the W1253 one-parser law — the YAML-writing ancestor suite is a
// pre-existing red, not the shape to copy).
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHubModels, poolRowsOf } from "../hooks/coord/hubs.ts";

test.describe("@api", () => {
	const home = mkdtempSync(join(tmpdir(), "suspenders-coord-hubs-models-"));
	const HUBS = join(home, "hubs.json");
	const STACK = join(home, "stack.json");
	const TOKEN = join(home, "hub.key");

	const ADMISSION = {
		provider_pool: "zai-coding-account",
		concurrency: 6,
		concurrency_ceiling: 8,
		outstanding: 2,
		queued: 1,
		active: 2,
		max_outstanding: 64,
		rate_per_interval: 50,
		interval_ms: 1000,
	};

	const hub = Bun.serve({
		port: 0,
		fetch: (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/v1/models") {
				if (req.headers.get("authorization") !== `Bearer test-key`)
					return Response.json({ error: "auth" }, { status: 401 });
				return Response.json({
					object: "list",
					data: [
						{
							id: "glm-5.3",
							object: "model",
							owned_by: "buckle",
							admission: ADMISSION,
						},
						{
							id: "glm-5.3-flash",
							object: "model",
							owned_by: "buckle",
							admission: ADMISSION,
						},
						{ id: "copilot/gpt-6-sol", object: "model", owned_by: "buckle" },
					],
				});
			}
			return new Response("ok");
		},
	});
	const hubUrl = `http://127.0.0.1:${hub.port}`;

	test.afterAll(() => {
		hub.stop(true);
		rmSync(home, { recursive: true, force: true });
	});

	test("parseHubModels keeps pool rows, drops malformed admission blocks", () => {
		const rows = parseHubModels({
			data: [
				{ id: "a", admission: ADMISSION },
				{ id: "b", admission: { provider_pool: "x" } },
				{ id: "", admission: ADMISSION },
				"junk",
				{ id: "c" },
			],
		});
		expect(rows?.map((r) => r.id)).toEqual(["a", "b", "c"]);
		expect(rows?.[0]?.admission).toEqual(ADMISSION);
		expect(rows?.[1]?.admission).toBeUndefined();
		expect(parseHubModels({ nope: true })).toBeNull();
		expect(parseHubModels(null)).toBeNull();
	});

	test("poolRowsOf aggregates member models under one pool", () => {
		const pools = poolRowsOf([
			{ id: "glm-5.3", admission: ADMISSION },
			{ id: "glm-5.3-flash", admission: ADMISSION },
			{ id: "copilot/gpt-6-sol" },
		]);
		expect(pools).toHaveLength(1);
		expect(pools[0]?.id).toBe("zai-coding-account");
		expect(pools[0]?.concurrency).toBe(6);
		expect(pools[0]?.models).toEqual(["glm-5.3", "glm-5.3-flash"]);
	});

	test("--json: up hub lists models + pool aggregate via the stack token", async () => {
		writeFileSync(TOKEN, "test-key\n");
		writeFileSync(HUBS, JSON.stringify({ TestHub: { candidates: [hubUrl] } }));
		writeFileSync(
			STACK,
			JSON.stringify({
				hubs: {
					TestHub: {
						host: "127.0.0.1",
						buckle_port: hub.port,
						token_file: TOKEN,
					},
				},
			}),
		);
		const p = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
				"hubs",
				"--json",
			],
			{
				env: {
					...process.env,
					HOME: home,
					SUSPENDERS_HUBS_FILE: HUBS,
					KLH_STACK: STACK,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
		]);
		const code = await p.exited;
		expect(err).toBe("");
		expect(code).toBe(0);
		const j = JSON.parse(out) as {
			hubs: Array<{
				label: string;
				up: boolean;
				models: Array<{ id: string; admission?: typeof ADMISSION }> | null;
				pools: Array<{ id: string; models: string[]; concurrency: number }>;
			}>;
		};
		const h = j.hubs.find((row) => row.label === "TestHub");
		expect(h?.up).toBe(true);
		expect(h?.models?.map((m) => m.id)).toEqual([
			"glm-5.3",
			"glm-5.3-flash",
			"copilot/gpt-6-sol",
		]);
		expect(h?.models?.[0]?.admission).toEqual(ADMISSION);
		expect(h?.pools).toEqual([
			{
				id: "zai-coding-account",
				concurrency: 6,
				concurrency_ceiling: 8,
				outstanding: 2,
				queued: 1,
				active: 2,
				max_outstanding: 64,
				rate_per_interval: 50,
				interval_ms: 1000,
				models: ["glm-5.3", "glm-5.3-flash"],
			},
		]);
	});

	test("--json: wrong-scope token reports models null, never a guess", async () => {
		const badToken = join(home, "bad.key");
		writeFileSync(badToken, "wrong-key\n");
		writeFileSync(HUBS, JSON.stringify({ TestHub: { candidates: [hubUrl] } }));
		writeFileSync(
			STACK,
			JSON.stringify({
				hubs: {
					TestHub: {
						host: "127.0.0.1",
						buckle_port: hub.port,
						token_file: badToken,
					},
				},
			}),
		);
		const p = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
				"hubs",
				"--json",
			],
			{
				env: {
					...process.env,
					HOME: home,
					SUSPENDERS_HUBS_FILE: HUBS,
					KLH_STACK: STACK,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = await new Response(p.stdout).text();
		expect(await p.exited).toBe(0);
		const j = JSON.parse(out) as {
			hubs: Array<{ models: unknown; pools: unknown[] }>;
		};
		const h = j.hubs.find((row) => row.label === "TestHub");
		expect(h?.models).toBeNull();
		expect(h?.pools).toEqual([]);
	});
});
