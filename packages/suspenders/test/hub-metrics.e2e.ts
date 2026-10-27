import { expect, test } from "./pw";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubMetricsEnv } from "../deploy/hub-metrics.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
const dir = mkdtempSync(join(tmpdir(), "hub-metrics-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
const profile: HubProfile = {
	host: "127.0.0.1",
	metrics: {
		litellm: {
			url: "http://127.0.0.1:4100/metrics/",
			key_env: "ENGINE_METRICS_KEY",
			source_id: "shared-engine",
		},
	},
	secrets: { upstream_keys: { ENGINE_METRICS_KEY: "/private/engine.key" } },
};
test("operator projection declares only endpoint and an existing credential name", () => {
	expect(hubMetricsEnv(profile)).toEqual({
		HUB_LITELLM_METRICS_URL: "http://127.0.0.1:4100/metrics/",
		HUB_LITELLM_METRICS_KEY_ENV: "ENGINE_METRICS_KEY",
		HUB_LITELLM_METRICS_SOURCE_ID: "shared-engine",
	});
	expect(hubMetricsEnv({ host: "127.0.0.1" })).toEqual({});
	for (const bad of [
		{ ...profile, secrets: undefined },
		{
			...profile,
			metrics: {
				litellm: {
					url: "http://host.docker.internal:4100/metrics",
					key_env: "ENGINE_METRICS_KEY",
					source_id: "shared-engine",
				},
			},
		},
		{
			...profile,
			metrics: {
				litellm: {
					url: "https://engine.example/metrics",
					key_env: "BAD\nNAME",
					source_id: "shared-engine",
				},
			},
		},
		{
			...profile,
			metrics: {
				litellm: {
					url: "https://engine.example/metrics",
					key_env: "VENDOR_KEY",
					source_id: "shared-engine",
				},
			},
		},
	])
		expect(() => hubMetricsEnv(bad)).toThrow();
	for (const litellm of [
		{ url: "https://engine.example/metrics", key_env: "ENGINE_METRICS_KEY" },
		{ ...profile.metrics?.litellm, source_id: "bad\r\nheader" },
		{ ...profile.metrics?.litellm, key_file: "/private/another.key" },
	])
		expect(() =>
			hubMetricsEnv({ ...profile, metrics: { litellm } } as HubProfile),
		).toThrow();
});
test("actual hubctl render and compose carry the same private connector bindings", () => {
	const stack = join(dir, "stack.json");
	writeFileSync(
		stack,
		JSON.stringify({ version: "v-fixture-metrics", hubs: { engine: profile } }),
		{ mode: 0o600 },
	);
	const p = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			"render",
			"engine",
		],
		{
			env: { ...process.env, KLH_STACK: stack },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(p.exitCode).toBe(0);
	const output = p.stdout.toString();
	expect(output).toContain("HUB_LITELLM_METRICS_KEY_ENV=ENGINE_METRICS_KEY");
	expect(output).not.toContain("/private/engine.key");
	const compose = readFileSync(
		join(import.meta.dir, "../deploy/hub-compose.yaml"),
		"utf8",
	);
	expect(compose).toContain(
		// biome-ignore lint/suspicious/noTemplateCurlyInString: compose contract
		"BUCKLE_LITELLM_METRICS_KEY_ENV: ${HUB_LITELLM_METRICS_KEY_ENV:-}",
	);
});
