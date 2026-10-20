import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import {
	eligibleFreeModelIds,
	classifyFreeModels,
	fetchFreeSnapshot,
	mergedHubUpstreams,
	OPENROUTER_ACCOUNT_CATALOG_URL,
	OPENROUTER_CATALOG_URL,
	OPENROUTER_FREE_MAX_AGE_MS,
	snapshotFromCatalog,
	writeFreeSnapshot,
} from "./openrouter-free.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tempPath = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "openrouter-free-test-"));
	dirs.push(dir);
	return join(dir, "snapshot.json");
};

const model = (
	id: string,
	pricing: Record<string, string> = { prompt: "0", completion: "0" },
	input = ["text"],
	output = ["text"],
) => ({
	id,
	pricing,
	architecture: { input_modalities: input, output_modalities: output },
});
const catalog = (data: unknown[]) => ({ data });
const free = model("nvidia/nemotron:free");

test("accepts free text models and rejects paid, request-fee, and non-text entries", () => {
	const ids = eligibleFreeModelIds(
		catalog([
			free,
			free,
			model("nvidia/vision:free", undefined, ["image"], ["text"]),
			model("vendor/paid:free", { prompt: "0", completion: "0.0001" }),
			model("vendor/fee:free", {
				prompt: "0",
				completion: "0",
				request: "0.01",
			}),
			model("vendor/paid", { prompt: "0", completion: "0" }),
			model(
				"vendor/text:free",
				{ prompt: "0.000", completion: "0", request: "0" },
				["text", "image"],
			),
		]),
	);
	expect(ids).toEqual(["nvidia/nemotron:free", "vendor/text:free"]);
});

test("records why free IDs cannot be exposed as text chat routes", () => {
	const result = classifyFreeModels(
		catalog([
			free,
			model("vendor/audio:free", undefined, ["audio"], ["audio"]),
			model("vendor/fee:free", { prompt: "0", completion: "0", request: "1" }),
		]),
	);
	expect(result.ids).toEqual(["nvidia/nemotron:free"]);
	expect(result.excluded).toEqual([
		{ id: "vendor/audio:free", reason: "no text input and output" },
		{ id: "vendor/fee:free", reason: "request fee is nonzero or unreported" },
	]);
});

test("account catalog limits advertised routes and admits the free router", () => {
	const publicCatalog = catalog([
		free,
		model("vendor/private:free"),
		model("openrouter/free"),
	]);
	const accountCatalog = catalog([free, model("openrouter/free")]);
	const snapshot = snapshotFromCatalog(
		publicCatalog,
		new Date("2026-10-20T10:00:00Z"),
		accountCatalog,
	);
	expect(Object.keys(snapshot.groups)).toEqual([
		"openrouter/nvidia/nemotron:free",
		"openrouter/free",
	]);
	expect(snapshot.groups["openrouter/free"]?.[0]?.model).toBe(
		"openrouter/free",
	);
	expect(snapshot.excluded_free_models).toContainEqual({
		id: "vendor/private:free",
		reason: "excluded by account privacy, provider preferences, or guardrails",
	});
	expect(snapshot.public_model_count).toBe(3);
	expect(snapshot.account_model_count).toBe(2);
});

test("an account with no permitted free models publishes no stale routes", () => {
	const snapshot = snapshotFromCatalog(
		catalog([free]),
		new Date("2026-10-20T10:00:00Z"),
		catalog([]),
	);
	expect(snapshot.groups).toEqual({});
	expect(snapshot.excluded_free_models).toContainEqual({
		id: free.id,
		reason: "excluded by account privacy, provider preferences, or guardrails",
	});
});

test("fetch joins full public catalog with authenticated account catalog", async () => {
	const seen: Array<{ url: string; authorization: string | null }> = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		const resolved = String(url);
		const headers = new Headers(init?.headers);
		seen.push({ url: resolved, authorization: headers.get("authorization") });
		return Response.json(
			resolved === OPENROUTER_CATALOG_URL
				? catalog([free, model("vendor/private:free")])
				: catalog([free]),
		);
	}) as typeof fetch;
	const snapshot = await fetchFreeSnapshot(fetcher, "test-inference-key");
	expect(Object.keys(snapshot.groups)).toEqual([
		"openrouter/nvidia/nemotron:free",
	]);
	expect(seen).toEqual([
		{ url: OPENROUTER_CATALOG_URL, authorization: null },
		{
			url: OPENROUTER_ACCOUNT_CATALOG_URL,
			authorization: "Bearer test-inference-key",
		},
	]);
});

test("rejects malformed or empty catalog without changing a prior snapshot", () => {
	const path = tempPath();
	const old = snapshotFromCatalog(
		catalog([free]),
		new Date("2026-10-20T00:00:00Z"),
	);
	writeFreeSnapshot(path, old);
	expect(() => snapshotFromCatalog(catalog([]))).toThrow(/no eligible free/);
	expect(() => eligibleFreeModelIds({ data: null })).toThrow(/data array/);
	expect(readFileSync(path, "utf8")).toContain("nvidia/nemotron:free");
});

test("snapshot writer avoids churn for unchanged routes and replaces changed routes", () => {
	const path = tempPath();
	const first = snapshotFromCatalog(
		catalog([free]),
		new Date("2026-10-20T00:00:00Z"),
	);
	expect(writeFreeSnapshot(path, first)).toBe(true);
	expect(
		writeFreeSnapshot(
			path,
			snapshotFromCatalog(catalog([free]), new Date("2026-10-20T00:01:00Z")),
		),
	).toBe(false);
	const second = snapshotFromCatalog(
		catalog([model("vendor/new:free")]),
		new Date("2026-10-20T00:02:00Z"),
	);
	expect(writeFreeSnapshot(path, second)).toBe(true);
	expect(
		JSON.parse(readFileSync(path, "utf8")).groups[
			"openrouter/vendor/new:free"
		][0].model,
	).toBe("openrouter/vendor/new:free");
});

test("hub merge requires cloud opt-in, a secret path, and a fresh snapshot; explicit groups win", () => {
	const path = tempPath();
	const now = Date.parse("2026-10-20T10:00:00Z");
	const snapshot = snapshotFromCatalog(catalog([free]), new Date(now));
	writeFileSync(path, JSON.stringify(snapshot));
	const hub: HubProfile = {
		host: "127.0.0.1",
		upstreams: {
			openrouter_free_catalog_file: path,
			groups: {
				"openrouter/nvidia/nemotron:free": [
					{ url: "http://localhost:9999", dialect: "openai" },
				],
			},
		},
		buckle_prefs: { allow_cloud: true },
		secrets: { upstream_keys: { LITELLM_KEY: "/secret/key" } },
	};
	expect(
		mergedHubUpstreams(hub, now)["openrouter/nvidia/nemotron:free"]?.[0]?.url,
	).toBe("http://localhost:9999");
	expect(() =>
		mergedHubUpstreams(hub, now + OPENROUTER_FREE_MAX_AGE_MS + 1),
	).toThrow(/stale/);
	expect(() =>
		mergedHubUpstreams({ ...hub, buckle_prefs: { allow_cloud: false } }, now),
	).toThrow(/allow_cloud/);
	expect(() => mergedHubUpstreams({ ...hub, secrets: undefined }, now)).toThrow(
		/LITELLM_KEY/,
	);
});
