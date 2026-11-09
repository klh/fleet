// test/coord-hubs-models.e2e.ts — W2635: `coord hubs --json` carries each
// up hub's model offerings with the concurrency/connection numbers
// map.prefer pins are decided against (hub= picks the hub, must=/prefer=
// picks the model). A stub hub (test-kit serveStub) answers /v1/models with
// pool-bound rows; the stack token authenticates; pools aggregate per hub.
// W2635.1: rides the test kit (W1135.1.3) — scratchWorld fixture, serveStub
// hub, runCli spawns — no hand-rolled mkdtemp/serve/spawn. JSON stack
// fixture (the W1253 one-parser law — the YAML-writing ancestor suite is a
// pre-existing red, not the shape to copy).
import { runCliAsync, scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHubModels, poolRowsOf } from "../hooks/coord/hubs.ts";

/** W2635.2: shared listing assertions — the hub is up, the token-authed
 *  /v1/models rows ride the output, the pool aggregate is id-keyed. */
const expectHubListing = (payload: unknown): void => {
	const j = payload as {
		hubs: Array<{
			label: string;
			up: boolean;
			models: Array<{ id: string }> | null;
			pools: Array<{ id: string; models: string[] }>;
		}>;
	};
	const h = j.hubs.find((row) => row.label === "TestHub");
	expect(h?.up).toBe(true);
	expect(h?.models?.map((m) => m.id)).toContain("glm-5.3");
	expect(h?.pools[0]?.id).toBe("zai-coding-account");
};

test.describe("@api", () => {
	const world = scratchWorld({ prefix: "coord-hubs-models-" });
	const home = world.home;
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

	const hub = serveStub((req) => {
		if (new URL(req.url).pathname !== "/v1/models") return new Response("ok");
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
	});
	const hubUrl = hub.url;

	test.afterAll(() => {
		hub.close();
		world.clean();
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

	// W2635.2 (B1): the pool row keys the pool by id — provider_pool is the
	// wire admission name (HubPoolNumbers) and never rides the aggregate row.
	// The interface once extended HubPoolNumbers verbatim, lying to every
	// .provider_pool reader (undefined at runtime, tsc error at build).
	test("poolRowsOf row keys the pool by id, never provider_pool", () => {
		const pools = poolRowsOf([{ id: "glm-5.3", admission: ADMISSION }]);
		expect(pools[0]?.id).toBe("zai-coding-account");
		expect("provider_pool" in (pools[0] ?? {})).toBe(false);
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
		const p = await runCliAsync(
			join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
			["hubs", "--json"],
			{
				env: {
					HOME: home,
					SUSPENDERS_HUBS_FILE: HUBS,
					KLH_STACK: STACK,
				},
			},
		);
		expect(p.err).toBe("");
		expect(p.code).toBe(0);
		const out = p.out;
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

	test("--json: stack credential goes only to its own Buckle origin", async () => {
		let catalogCalls = 0;
		const other = serveStub((req) => {
			if (new URL(req.url).pathname !== "/v1/models") return new Response("ok");
			catalogCalls++;
			return new Response("wrong front", { status: 401 });
		});
		try {
			writeFileSync(TOKEN, "test-key\n");
			writeFileSync(
				HUBS,
				JSON.stringify({ TestHub: { candidates: [other.url] } }),
			);
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
			const p = await runCliAsync(
				join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
				["hubs", "--json"],
				{ env: { HOME: home, SUSPENDERS_HUBS_FILE: HUBS, KLH_STACK: STACK } },
			);
			expect(p.code).toBe(0);
			expectHubListing(JSON.parse(p.out));
			expect(catalogCalls).toBe(0);
		} finally {
			other.close();
		}
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
		const p = await runCliAsync(
			join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
			["hubs", "--json"],
			{
				env: {
					HOME: home,
					SUSPENDERS_HUBS_FILE: HUBS,
					KLH_STACK: STACK,
				},
			},
		);
		expect(p.code).toBe(0);
		const out = p.out;
		const j = JSON.parse(out) as {
			hubs: Array<{ label: string; models: unknown; pools: unknown[] }>;
		};
		const h = j.hubs.find((row) => row.label === "TestHub");
		expect(h?.models).toBeNull();
		expect(h?.pools).toEqual([]);
	});

	// W2635.2 (N1): the stack.json buckle arm — no hubs.json entry at all
	// (SUSPENDERS_HUBS_FILE points at a nonexistent path), the only candidate
	// is the stack-declared buckle_port. The listing must still ride it with
	// the stack token, same as the hubs.json arm above.
	test("--json: stack.json buckle candidate alone serves the listing", async () => {
		writeFileSync(TOKEN, "test-key\n");
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
		const p = await runCliAsync(
			join(import.meta.dir, "..", "hooks", "bin", "coord.ts"),
			["hubs", "--json"],
			{
				env: {
					HOME: home,
					SUSPENDERS_HUBS_FILE: join(home, "no-such-hubs.json"),
					KLH_STACK: STACK,
				},
			},
		);
		expect(p.err).toBe("");
		expect(p.code).toBe(0);
		await expectHubListing(JSON.parse(p.out));
	});
});
