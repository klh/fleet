// W1029.1: the scheduled Z.ai refresh activation sequence, probed through
// the injected ZaiRefreshDeps seam — no real LiteLLM, key, or hub touched.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubProfile, StackConfig } from "../hooks/lib/stack-config.ts";
import { markerHash } from "./litellm-activation.ts";
import {
	refreshConfiguredZai,
	type ZaiRefreshDeps,
} from "./zai-catalog-refresh.ts";

const catalog = { data: [{ id: "glm-5.3" }, { id: "glm-4.7" }] };
const MODEL_IDS = ["glm-4.7", "glm-5.3"];

const recorder = () => {
	const rec = {
		runs: [] as Array<{ argv: string[]; env?: Record<string, string> }>,
		restarts: 0,
		waits: [] as string[][],
		applied: {} as Record<string, string>,
		deps: undefined as unknown as ZaiRefreshDeps,
	};
	rec.deps = {
		fetcher: (async () => Response.json(catalog)) as typeof fetch,
		activation: {
			run: (argv, env) => {
				rec.runs.push({ argv, env });
			},
			restartLiteLLM: () => {
				rec.restarts += 1;
			},
			waitForLiteLLMModels: async (names) => {
				rec.waits.push(names);
			},
			appliedHash: (path) => rec.applied[path] ?? null,
			writeAppliedHash: (path, hash) => {
				rec.applied[path] = hash;
			},
		},
	};
	return rec;
};

const macHub = (dir: string) =>
	({
		buckle_prefs: { allow_cloud: true },
		secrets: {
			upstream_keys: {
				LITELLM_KEY: join(dir, "litellm.key"),
				Z_AI_API_KEY: join(dir, "zai.key"),
			},
		},
		upstreams: {
			zai_catalog_file: join(dir, "zai-models.json"),
			openrouter_free_catalog_file: join(dir, "openrouter-free.json"),
		},
	}) as HubProfile;

const stackOf = (hub: HubProfile): StackConfig =>
	({ hubs: { mac: hub } }) as StackConfig;

describe("Z.ai catalog refresh (W1029.1)", () => {
	test("activation order: both-knob regen, restart, wait zai- rows, hub reload, then marker", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-refresh-test-"));
		try {
			writeFileSync(join(dir, "zai.key"), "test-secret\n", { mode: 0o600 });
			const rec = recorder();
			const messages = await refreshConfiguredZai(
				stackOf(macHub(dir)),
				rec.deps,
			);
			expect(messages).toEqual(["mac: activated 2 Z.ai account routes"]);
			expect(rec.restarts).toBe(1);
			expect(rec.waits).toEqual([["zai-glm-4.7", "zai-glm-5.3"]]);
			expect(rec.runs).toHaveLength(2);
			const [regen, reload] = rec.runs;
			expect(regen.env).toEqual({
				ZAI_CATALOG_FILE: join(dir, "zai-models.json"),
				OPENROUTER_FREE_CATALOG: join(dir, "openrouter-free.json"),
			});
			expect(regen.argv[1]?.endsWith("gateway-config.ts")).toBe(true);
			expect(reload.argv.at(-2)).toBe("reload-upstreams");
			expect(reload.argv.at(-1)).toBe("mac");
			expect(reload.argv[1]?.endsWith("hubctl.ts")).toBe(true);
			expect(rec.applied[join(dir, "zai-models.json")]).toBe(
				markerHash(MODEL_IDS),
			);
			expect(readFileSync(join(dir, "zai-models.json"), "utf8")).toContain(
				"glm-4.7",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("marker match skips activation but still refreshes the snapshot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-refresh-test-"));
		try {
			writeFileSync(join(dir, "zai.key"), "test-secret\n", { mode: 0o600 });
			const hub = macHub(dir);
			const rec = recorder();
			rec.applied[join(dir, "zai-models.json")] = markerHash(MODEL_IDS);
			const messages = await refreshConfiguredZai(stackOf(hub), rec.deps);
			expect(messages).toEqual(["mac: 2 routes unchanged"]);
			expect(rec.restarts).toBe(0);
			expect(rec.runs).toHaveLength(0);
			expect(rec.waits).toHaveLength(0);
			expect(readFileSync(join(dir, "zai-models.json"), "utf8")).toContain(
				"glm-4.7",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("wait failure keeps last-good: rejects, never reloads, marker not advanced", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-refresh-test-"));
		try {
			writeFileSync(join(dir, "zai.key"), "test-secret\n", { mode: 0o600 });
			const rec = recorder();
			if (rec.deps.activation)
				rec.deps.activation.waitForLiteLLMModels = async () => {
					throw new Error("did not list");
				};
			await expect(
				refreshConfiguredZai(stackOf(macHub(dir)), rec.deps),
			).rejects.toThrow("did not list");
			expect(rec.runs).toHaveLength(1);
			expect(rec.runs[0]?.argv[1]?.endsWith("gateway-config.ts")).toBe(true);
			expect(rec.applied).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("idle: no configured catalog, or no cloud opt-in and LiteLLM key path", async () => {
		const rec = recorder();
		expect(
			await refreshConfiguredZai(
				{ hubs: { mac: {} } } as StackConfig,
				rec.deps,
			),
		).toEqual(["Z.ai refresh idle: no hub configures a zai catalog file"]);
		const hub = macHub("/unused");
		hub.buckle_prefs = undefined;
		expect(await refreshConfiguredZai(stackOf(hub), rec.deps)).toEqual([
			"Z.ai refresh idle: no hub has cloud opt-in and a LiteLLM key path",
		]);
		expect(rec.runs).toHaveLength(0);
		expect(rec.waits).toHaveLength(0);
	});

	test("remote hub refuses activation before any run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-refresh-test-"));
		try {
			writeFileSync(join(dir, "zai.key"), "test-secret\n", { mode: 0o600 });
			const hub = {
				...macHub(dir),
				deploy: { ssh: "kk@nas.threads.dk" },
			} as HubProfile;
			const rec = recorder();
			await expect(
				refreshConfiguredZai(stackOf(hub), rec.deps),
			).rejects.toThrow("local macOS hub");
			expect(rec.runs).toHaveLength(0);
			expect(rec.applied).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
