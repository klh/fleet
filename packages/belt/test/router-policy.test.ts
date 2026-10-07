import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	emitFallbackSettings,
	emitRouterSettings,
	loadGatewayPolicy,
	parsePolicy,
} from "../bin/router-policy.ts";

const REPO_POLICY = new URL("../bin/routing-policy.yaml", import.meta.url)
	.pathname;

/** Fixed ladder — pins the EMITTER shape independent of policy drift. */
const emitterTestFallbacks = () => ({
	fallbacks: {
		"glm-5.3-flash": ["zai-glm-5.3-flash", "local-reason"],
		"glm-5.3": ["zai-glm-5.3", "local-reason"],
		"glm-5.2": ["zai-glm-5.2", "local-reason"],
	},
});

describe("routing policy (W124 + W219.2 fold)", () => {
	test("committed default carries the hand-edit ladders + native knobs", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		expect(p.num_retries).toBe(1);
		expect(p.allowed_fails).toBe(3);
		expect(p.cooldown_time).toBe(30);
		expect(p.fallbacks).toEqual({
			"glm-5.3-flash": ["zai-glm-5.3-flash", "local-reason"],
			"glm-5.3": ["zai-glm-5.3", "local-reason"],
			"glm-5.2": ["zai-glm-5.2", "local-reason"],
		});
	});

	test("never flashx anywhere in the policy (owner directive)", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		expect(JSON.stringify(p).toLowerCase().includes("flashx")).toBe(false);
	});

	test("fallback order is zai twin → local-reason, per glm group", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		for (const [group, ladder] of Object.entries(p.fallbacks ?? {})) {
			expect(ladder).toHaveLength(2);
			expect(ladder?.[0]).toBe(`zai-${group}`);
			expect(ladder?.[1]).toBe("local-reason");
		}
	});

	test("emit → YAML round-trip: knobs in router_settings, no fallbacks", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		const doc = Bun.YAML.parse(emitRouterSettings(p)) as {
			router_settings: Record<string, unknown> & {
				fallbacks?: unknown;
			};
		};
		expect(doc.router_settings).toEqual({
			routing_strategy: "latency-based-routing",
			num_retries: 1,
			allowed_fails: 3,
			cooldown_time: 30,
		});
	});

	test("emitFallbackSettings → YAML round-trip preserves the ladders", () => {
		const doc = Bun.YAML.parse(emitFallbackSettings(emitterTestFallbacks())) as {
			litellm_settings: {
				fallbacks: Record<string, string[]>[];
			};
		};
		expect(doc.litellm_settings.fallbacks).toEqual([
			{ "glm-5.3-flash": ["zai-glm-5.3-flash", "local-reason"] },
			{ "glm-5.3": ["zai-glm-5.3", "local-reason"] },
			{ "glm-5.2": ["zai-glm-5.2", "local-reason"] },
		]);
	});

	test("emitted ladder line is verbatim LiteLLM fallback shape", () => {
		const out = emitFallbackSettings(emitterTestFallbacks());
		expect(out).toContain(
			"    - glm-5.3-flash: [zai-glm-5.3-flash, local-reason]",
		);
	});

	test("runtime copy overrides the committed default", () => {
		const dir = mkdtempSync(join(tmpdir(), "w124-policy-"));
		const path = join(dir, "routing-policy.yaml");
		writeFileSync(
			path,
			[
				"version: 1",
				"gateway:",
				"  num_retries: 2",
				"  allowed_fails: 5",
				"  cooldown_time: 60",
				"  fallbacks:",
				"    glm-5.3-flash: [local-swarm]",
			].join("\n"),
		);
		const p = loadGatewayPolicy(path);
		expect(p.num_retries).toBe(2);
		expect(p.allowed_fails).toBe(5);
		expect(p.cooldown_time).toBe(60);
		expect(p.fallbacks).toEqual({ "glm-5.3-flash": ["local-swarm"] });
		rmSync(dir, { recursive: true, force: true });
	});

	test("defaults apply when the gateway section is absent", () => {
		const p = parsePolicy("version: 1\n");
		expect(p.num_retries).toBe(1);
		expect(p.allowed_fails).toBe(3);
		expect(p.cooldown_time).toBe(30);
		expect(p.fallbacks).toBeUndefined();
	});

	test("emit omits the fallbacks key when none are configured", () => {
		const out = emitRouterSettings(parsePolicy("version: 1\n"));
		expect(out.includes("fallbacks")).toBe(false);
		expect(out).toContain("routing_strategy: latency-based-routing");
		expect(emitFallbackSettings(parsePolicy("version: 1\n"))).toBe("");
	});
});
