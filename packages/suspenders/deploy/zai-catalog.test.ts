import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseZaiModelIds,
	readZaiSnapshot,
	ZAI_CATALOG_URL,
	type ZaiCatalogSnapshot,
} from "../../belt/bin/zai-catalog-rows.ts";
import { validateRouteLadders } from "../../buckle/src/route-ladder-validator.ts";
import { loadUpstreams, type Deployment } from "../../buckle/src/upstreams.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import {
	fetchZaiCatalog,
	mergeZaiHubUpstreams,
	refreshStaleZaiSnapshot,
	writeZaiSnapshot,
} from "./zai-catalog.ts";

const catalog = {
	data: [
		{ id: "glm-5.3-flash", object: "model" },
		{ id: "glm-5.3", object: "model" },
		{ id: "glm-4.7", object: "model" },
		{ id: "glm-5.3", object: "model" },
	],
};

const hubWithCatalog = (path: string) =>
	({
		http_upstream_hosts: ["host.docker.internal"],
		buckle_prefs: { allow_cloud: true },
		secrets: { upstream_keys: { LITELLM_KEY: "/private/litellm.key" } },
		upstreams: {
			zai_catalog_file: path,
			zai_litellm_url: "http://host.docker.internal:4100",
		},
	}) as HubProfile;

const zaiSnapshot = (model_ids: string[]): ZaiCatalogSnapshot => ({
	version: 1,
	source: ZAI_CATALOG_URL,
	generated_at: new Date().toISOString(),
	model_ids,
	excluded_model_ids: [],
});

const poolFor = (groups: Record<string, Array<Record<string, unknown>>>) => ({
	groups: () => Object.keys(groups),
	deployments: (name: string) =>
		(groups[name] ?? []).map((row) => ({
			...row,
			group: name,
		})) as Deployment[],
});

const litellmWithModel = (model_name: string) => ({
	id: "engine",
	origins: ["http://host.docker.internal:4100"],
	config: {
		model_list: [
			{ model_name, litellm_params: { api_base: "https://api.z.ai" } },
		],
	},
});

describe("Z.ai account catalog", () => {
	test("deduplicates and sorts account-visible model IDs", () => {
		expect(parseZaiModelIds(catalog)).toEqual({
			model_ids: ["glm-4.7", "glm-5.3", "glm-5.3-flash"],
			excluded_model_ids: [],
		});
		expect(() => parseZaiModelIds({ data: [{ id: "../../bad" }] })).toThrow(
			"no chat GLM models",
		);
	});

	test("filters non-chat IDs while keeping the chat GLMs", () => {
		expect(
			parseZaiModelIds({
				data: [
					{ id: "glm-5.3-flash" },
					{ id: "glm-4.6v" },
					{ id: "glm-4.5v" },
					{ id: "glm-5.3-flash" },
				],
			}),
		).toEqual({
			model_ids: ["glm-5.3-flash"],
			excluded_model_ids: ["glm-4.5v", "glm-4.6v"],
		});
	});

	test("authenticates without retaining the key and keeps a valid old snapshot on fetch failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-catalog-test-"));
		try {
			const keyFile = join(dir, "zai.key");
			const snapshotFile = join(dir, "zai-models.json");
			writeFileSync(keyFile, "test-secret\n", { mode: 0o600 });
			const fetcher = (async (
				_url: string | URL | Request,
				init?: RequestInit,
			) => {
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer test-secret",
				);
				return Response.json(catalog);
			}) as typeof fetch;
			const snapshot = await fetchZaiCatalog(keyFile, fetcher);
			expect(snapshot.source).toBe(ZAI_CATALOG_URL);
			expect(writeZaiSnapshot(snapshotFile, snapshot)).toBe(true);
			expect(writeZaiSnapshot(snapshotFile, snapshot)).toBe(false);
			const before = readFileSync(snapshotFile, "utf8");
			await expect(
				fetchZaiCatalog(
					keyFile,
					(async () => new Response(null, { status: 429 })) as typeof fetch,
				),
			).rejects.toThrow("HTTP 429");
			expect(readFileSync(snapshotFile, "utf8")).not.toContain("test-secret");
			expect(readFileSync(snapshotFile, "utf8")).toBe(before);
			chmodSync(keyFile, 0o644);
			await expect(fetchZaiCatalog(keyFile, fetcher)).rejects.toThrow("0600");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("generates only LiteLLM hub routes; explicit groups retain priority", () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-catalog-test-"));
		try {
			const path = join(dir, "models.json");
			const snapshot: ZaiCatalogSnapshot = {
				version: 1,
				source: ZAI_CATALOG_URL,
				generated_at: new Date().toISOString(),
				model_ids: ["glm-4.7", "glm-5.3"],
				excluded_model_ids: [],
			};
			writeZaiSnapshot(path, snapshot);
			const hub = hubWithCatalog(path);
			const explicit = { "glm-5.3": [{ model: "operator-model" }] };
			const merged = mergeZaiHubUpstreams(hub, explicit);
			expect(merged["glm-4.7"]).toEqual([
				{
					url: "http://host.docker.internal:4100",
					dialect: "openai",
					adapter: "openai-compat",
					model: "zai-glm-4.7",
					adapter_config: { proxy_kind: "litellm" },
					api_key_env: "LITELLM_KEY",
				},
			]);
			expect(merged["glm-5.3"]).toEqual(explicit["glm-5.3"]);
			const classified = mergeZaiHubUpstreams(
				{
					...hub,
					upstreams: {
						...hub.upstreams,
						zai_concurrency_error_codes: ["capacity"],
					},
				},
				explicit,
			);
			expect(classified["glm-4.7"][0].adapter_config).toEqual({
				proxy_kind: "litellm",
				provider_concurrency_error_codes: ["capacity"],
			});
			expect(classified["glm-5.3"]).toEqual(explicit["glm-5.3"]);
			expect(() =>
				mergeZaiHubUpstreams(
					{
						...hub,
						upstreams: {
							...hub.upstreams,
							zai_concurrency_error_codes: ["capacity", "capacity"],
						},
					},
					explicit,
				),
			).toThrow("unique bounded tokens");
			expect(() =>
				mergeZaiHubUpstreams({ ...hub, http_upstream_hosts: [] }, explicit),
			).toThrow("allowed LiteLLM host");
			expect(() =>
				mergeZaiHubUpstreams(hub, {
					"glm-5.3": [{ url: "https://api.z.ai", model: "glm-5.3" }],
				}),
			).toThrow("direct provider route");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("permits only guarded Flash Coding Plan routes directly to Z.ai", () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-catalog-test-"));
		try {
			const path = join(dir, "models.json");
			writeZaiSnapshot(path, zaiSnapshot(["glm-5.3-flash"]));
			const baseHub = hubWithCatalog(path);
			const hub = {
				...baseHub,
				secrets: {
					upstream_keys: {
						...baseHub.secrets?.upstream_keys,
						Z_AI_API_KEY: "/private/zai.key",
					},
				},
			};
			const anthropic = {
				url: "https://api.z.ai",
				dialect: "anthropic",
				model: "glm-5.3-flash",
				api_key_env: "Z_AI_API_KEY",
				adapter_config: {
					path_rewrite: { "/v1/messages": "/api/anthropic/v1/messages" },
					blocked_outbound: {
						paths: ["/api/paas/v4/"],
						corrections: {
							anthropic: "https://api.z.ai/api/anthropic/v1/messages",
							openai: "https://api.z.ai/api/coding/paas/v4/chat/completions",
						},
					},
				},
			};
			const openai = {
				...anthropic,
				dialect: "openai",
				adapter: "openai-compat",
				adapter_config: {
					...anthropic.adapter_config,
					path_rewrite: {
						"/v1/chat/completions": "/api/coding/paas/v4/chat/completions",
					},
				},
			};
			const groups = { "glm-5.3-flash": [anthropic, openai] };
			expect(mergeZaiHubUpstreams(hub, groups)["glm-5.3-flash"]).toEqual(
				groups["glm-5.3-flash"],
			);
			const upstreamsPath = join(dir, "upstreams.json");
			writeFileSync(
				upstreamsPath,
				JSON.stringify({ version: 1, inherit_defaults: false, groups }),
			);
			expect(
				loadUpstreams(upstreamsPath).deployments("glm-5.3-flash"),
			).toHaveLength(2);
			for (const mutation of [
				{ ...anthropic, url: "http://api.z.ai" },
				{ ...anthropic, model: "glm-5.3" },
				{ ...anthropic, api_key_env: "LITELLM_KEY" },
				{
					...anthropic,
					adapter_config: { ...anthropic.adapter_config, path_rewrite: {} },
				},
				{
					...anthropic,
					adapter_config: {
						...anthropic.adapter_config,
						blocked_outbound: { paths: [] },
					},
				},
				{
					...anthropic,
					adapter_config: {
						...anthropic.adapter_config,
						blocked_outbound: { paths: ["/api/paas/v4/"] },
					},
				},
			])
				expect(() =>
					mergeZaiHubUpstreams(hub, { "glm-5.3-flash": [mutation] }),
				).toThrow("direct provider route");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("generated LiteLLM rows pass the Buckle route preflight", () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-catalog-test-"));
		try {
			const catalogPath = join(dir, "models.json");
			writeZaiSnapshot(catalogPath, zaiSnapshot(["glm-5.3-flash"]));
			const generated = mergeZaiHubUpstreams(hubWithCatalog(catalogPath), {});
			const result = validateRouteLadders({
				buckles: [
					{
						id: "hub",
						origins: ["http://hub.local:4101"],
						policy: { num_retries: 1, request_timeout_s: 30 },
						pool: poolFor(generated),
					},
				],
				litellms: [litellmWithModel("zai-glm-5.3-flash")],
			});
			expect(result.errors).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const staleHomes: string[] = [];
afterAll(() => {
	for (const dir of staleHomes.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// W1469 fixture: a HOME whose Z.ai snapshot is `ageMs` old (default 3 days).
const staleHome = (modelIds: string[], ageMs = 3 * 86_400_000, key = true) => {
	const home = mkdtempSync(join(tmpdir(), "zai-stale-test-"));
	staleHomes.push(home);
	const llm = join(home, ".claude", "local-llm");
	mkdirSync(llm, { recursive: true });
	const path = join(llm, "zai-models.json");
	const aged = {
		...zaiSnapshot(modelIds),
		generated_at: new Date(Date.now() - ageMs).toISOString(),
	};
	writeFileSync(path, JSON.stringify(aged), { mode: 0o600 });
	if (key)
		writeFileSync(join(llm, "zai.key"), "test-secret\n", { mode: 0o600 });
	return { home, path, llm };
};

const liveFetcher = (ids: string[], calls: string[] = []) =>
	(async (url: string | URL | Request) => {
		calls.push(String(url));
		return Response.json({ data: ids.map((id) => ({ id })) });
	}) as typeof fetch;

describe("W1469 stale Z.ai snapshot preflight", () => {
	test("timestamp-only staleness: refreshed in place, one fetch, key never persisted", async () => {
		const { home, path } = staleHome(["glm-4.7", "glm-5.3", "glm-5.3-flash"]);
		expect(() => readZaiSnapshot(path)).toThrow("stale");
		const calls: string[] = [];
		const live = liveFetcher(["glm-5.3-flash", "glm-4.7", "glm-5.3"], calls);
		const result = await refreshStaleZaiSnapshot(home, live, {});
		expect(result).toEqual({ kind: "refreshed", models: 3 });
		expect(calls).toEqual([ZAI_CATALOG_URL]);
		expect(readZaiSnapshot(path).model_ids).toEqual([
			"glm-4.7",
			"glm-5.3",
			"glm-5.3-flash",
		]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).not.toContain("test-secret");
	});

	test("real model-set delta: reported, snapshot left stale and byte-identical", async () => {
		const { home, path } = staleHome(["glm-4.7", "glm-5.3"]);
		const before = readFileSync(path, "utf8");
		const live = liveFetcher(["glm-5.3", "glm-5.4"]);
		expect(await refreshStaleZaiSnapshot(home, live, {})).toEqual({
			kind: "delta",
			added: ["glm-5.4"],
			removed: ["glm-4.7"],
		});
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(() => readZaiSnapshot(path)).toThrow("stale");
	});

	test("unverifiable (HTTP 429, no key file): failed loudly, snapshot untouched", async () => {
		const { home, path } = staleHome(["glm-5.3"]);
		const before = readFileSync(path, "utf8");
		const limited = (async () =>
			new Response(null, { status: 429 })) as typeof fetch;
		const result = await refreshStaleZaiSnapshot(home, limited, {});
		expect(result).toMatchObject({ kind: "failed" });
		expect(JSON.stringify(result)).toContain("HTTP 429");
		const keyless = staleHome(["glm-5.3"], undefined, false);
		expect(
			await refreshStaleZaiSnapshot(keyless.home, liveFetcher(["glm-5.3"]), {}),
		).toMatchObject({ kind: "failed" });
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("fresh, absent, or structurally invalid snapshots cost zero fetches", async () => {
		const calls: string[] = [];
		const live = liveFetcher(["glm-5.3"], calls);
		expect(
			await refreshStaleZaiSnapshot(
				staleHome(["glm-5.3"], 60_000).home,
				live,
				{},
			),
		).toBeNull();
		const absent = staleHome(["glm-5.3"]);
		rmSync(absent.path);
		expect(await refreshStaleZaiSnapshot(absent.home, live, {})).toBeNull();
		const invalid = staleHome(["glm-5.3"]);
		writeFileSync(invalid.path, JSON.stringify({ version: 2 }), {
			mode: 0o600,
		});
		expect(await refreshStaleZaiSnapshot(invalid.home, live, {})).toBeNull();
		expect(calls).toEqual([]);
	});

	test("excluded-only drift (new non-chat id) refreshes silently", async () => {
		const { home, path } = staleHome(["glm-5.3"]);
		const live = liveFetcher(["glm-5.3", "glm-4.6v"]);
		expect(await refreshStaleZaiSnapshot(home, live, {})).toEqual({
			kind: "refreshed",
			models: 1,
		});
		expect(readZaiSnapshot(path).excluded_model_ids).toEqual(["glm-4.6v"]);
	});

	test("ZAI_CATALOG_FILE override is the path repaired, not the HOME default", async () => {
		const aside = staleHome(["glm-5.3"]);
		const base = staleHome(["glm-4.7"]);
		const before = readFileSync(base.path, "utf8");
		const env = { ZAI_CATALOG_FILE: aside.path };
		const live = liveFetcher(["glm-5.3"]);
		expect(await refreshStaleZaiSnapshot(base.home, live, env)).toEqual({
			kind: "refreshed",
			models: 1,
		});
		expect(readZaiSnapshot(aside.path).model_ids).toEqual(["glm-5.3"]);
		expect(readFileSync(base.path, "utf8")).toBe(before);
	});

	test("future-dated timestamp is repaired like an expired one", async () => {
		const { home, path } = staleHome(["glm-5.3"], -3_600_000);
		expect(() => readZaiSnapshot(path)).toThrow("stale");
		const live = liveFetcher(["glm-5.3"]);
		expect(await refreshStaleZaiSnapshot(home, live, {})).toEqual({
			kind: "refreshed",
			models: 1,
		});
		expect(readZaiSnapshot(path).model_ids).toEqual(["glm-5.3"]);
	});
});
