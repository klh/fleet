import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseZaiModelIds,
	ZAI_CATALOG_URL,
	type ZaiCatalogSnapshot,
} from "../../belt/bin/zai-catalog-rows.ts";
import { validateRouteLadders } from "../../buckle/src/route-ladder-validator.ts";
import type { Deployment } from "../../buckle/src/upstreams.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import {
	fetchZaiCatalog,
	mergeZaiHubUpstreams,
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
