import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	emitClassTiers,
	emitLiteLlmSettings,
	emitRouterSettings,
	loadGatewayPolicy,
	parsePolicy,
	resolveClassGroups,
	resolveReasoningEffort,
	resolveRoleClass,
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
		expect(p.litellm_num_retries).toBe(1);
		expect(p.allowed_fails).toBe(3);
		expect(p.cooldown_time).toBe(30);
		expect(p.fallbacks).toEqual({
			"glm-5.3-flash": ["zai-glm-5.3-flash", "local-reason"],
			"glm-5.3": ["zai-glm-5.3", "local-reason"],
			"glm-5.2": ["zai-glm-5.2", "local-reason"],
			"zai-glm-5.3-flash": ["glm-5.3-flash", "local-reason"],
			"zai-glm-5.3": ["glm-5.3", "local-reason"],
			"zai-glm-5.2": ["glm-5.2", "local-reason"],
			"local-swarm": ["local-reason"],
		});
		expect(p.enable_pre_call_checks).toBe(true);
		expect(p.context_window_fallbacks).toEqual({
			"local-extract": ["glm-5.3-flash"],
			"local-coder": ["glm-5.3-flash"],
			"local-reason": ["glm-5.3-flash"],
			"local-general": ["glm-5.3-flash"],
			"local-swarm": ["glm-5.3-flash"],
			"nas-qwen2.5-0.5b": ["glm-5.3-flash"],
		});
	});

	test("never flashx anywhere in the policy (owner directive)", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		expect(JSON.stringify(p).toLowerCase().includes("flashx")).toBe(false);
	});

	test("fallback order is zai twin → local-reason, per glm group", () => {
		const f = loadGatewayPolicy(REPO_POLICY).fallbacks ?? {};
		for (const [group, ladder] of Object.entries(f)) {
			expect(ladder?.at(-1)).toBe("local-reason");
			expect(ladder).not.toContain(group);
		}
	});

	test("W880: zai twins + local-swarm are laddered (F3 gap closed)", () => {
		const f = loadGatewayPolicy(REPO_POLICY).fallbacks ?? {};
		for (const twin of ["zai-glm-5.3-flash", "zai-glm-5.3", "zai-glm-5.2"]) {
			const mirror = twin.replace(/^zai-/, "");
			expect(f[twin]).toEqual([mirror, "local-reason"]);
		}
		expect(f["local-swarm"]).toEqual(["local-reason"]);
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
			default_litellm_params: { max_retries: 0 },
			allowed_fails: 3,
			cooldown_time: 30,
			enable_pre_call_checks: true,
		});
	});

	test("emitFallbackSettings emits the W880 context-window rescue rows", () => {
		const doc = Bun.YAML.parse(
			emitLiteLlmSettings(loadGatewayPolicy(REPO_POLICY)),
		) as {
			litellm_settings: {
				drop_params: boolean;
				callbacks: string[];
				require_auth_for_metrics_endpoint: boolean;
				prometheus_emit_stream_label: boolean;
				fallbacks: Record<string, string[]>[];
				context_window_fallbacks: Record<string, string[]>[];
			};
		};
		expect(doc.litellm_settings.fallbacks).toHaveLength(7);
		expect(doc.litellm_settings.drop_params).toBe(true);
		expect(doc.litellm_settings.callbacks).toEqual(["prometheus"]);
		expect(doc.litellm_settings.require_auth_for_metrics_endpoint).toBe(true);
		expect(doc.litellm_settings.prometheus_emit_stream_label).toBe(true);
		expect(doc.litellm_settings.context_window_fallbacks).toEqual([
			{ "local-extract": ["glm-5.3-flash"] },
			{ "local-coder": ["glm-5.3-flash"] },
			{ "local-reason": ["glm-5.3-flash"] },
			{ "local-general": ["glm-5.3-flash"] },
			{ "local-swarm": ["glm-5.3-flash"] },
			{ "nas-qwen2.5-0.5b": ["glm-5.3-flash"] },
		]);
	});

	test("verified front ownership opts out of inner retries without changing outer budget", () => {
		const policy = parsePolicy(
			"gateway:\n  num_retries: 1\n  litellm_num_retries: 0\n",
		);
		const generated = Bun.YAML.parse(emitRouterSettings(policy));
		expect(policy.num_retries).toBe(1);
		expect(generated.router_settings.num_retries).toBe(0);
	});

	test("outer retries stay independent from bounded inner router retries", () => {
		const policy = parsePolicy(
			"gateway:\n  num_retries: 1\n  litellm_num_retries: 3\n",
		);
		const generated = Bun.YAML.parse(emitRouterSettings(policy));
		expect(policy.num_retries).toBe(1);
		expect(generated.router_settings.num_retries).toBe(3);
		expect(generated.router_settings.default_litellm_params.max_retries).toBe(
			0,
		);
	});

	test("invalid inner retry budgets fail closed rather than generating YAML", () => {
		for (const invalid of [
			"-1",
			"4",
			"1.5",
			"null",
			'"2"',
			"true",
			".nan",
			".inf",
		]) {
			expect(() =>
				parsePolicy(`gateway:\n  litellm_num_retries: ${invalid}\n`),
			).toThrow("integer from 0 to 3");
		}
		expect(() => emitRouterSettings({ litellm_num_retries: -1 })).toThrow(
			"integer from 0 to 3",
		);
	});

	test("emitFallbackSettings → YAML round-trip preserves the ladders", () => {
		const doc = Bun.YAML.parse(emitLiteLlmSettings(emitterTestFallbacks())) as {
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
		const out = emitLiteLlmSettings(emitterTestFallbacks());
		expect(out).toContain(
			"    - glm-5.3-flash: [zai-glm-5.3-flash, local-reason]",
		);
	});

	test("explicit inner fallback opt-out preserves the front's policy ladder", () => {
		const policy = parsePolicy(
			"gateway:\n  litellm_fallbacks: false\n  fallbacks:\n    primary: [secondary]\n",
		);
		expect(Bun.YAML.parse(emitLiteLlmSettings(policy))).toEqual({
			litellm_settings: {
				drop_params: true,
				callbacks: ["prometheus"],
				require_auth_for_metrics_endpoint: true,
				prometheus_emit_stream_label: true,
			},
		});
		expect(policy.fallbacks).toEqual({ primary: ["secondary"] });
		expect(
			emitLiteLlmSettings({ ...policy, litellm_fallbacks: true }),
		).toContain("primary: [secondary]");
	});

	test("inner fallbacks default on and reject non-boolean config", () => {
		expect(parsePolicy("version: 1\n").litellm_fallbacks).toBe(true);
		for (const invalid of ["null", "0", "1", '"false"', "[]", "{}"])
			expect(() =>
				parsePolicy(`gateway:\n  litellm_fallbacks: ${invalid}\n`),
			).toThrow("must be a boolean");
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

	test("JSON sibling of a pinned YAML policy wins, then legacy YAML remains readable", () => {
		const dir = mkdtempSync(join(tmpdir(), "w975-belt-policy-"));
		const yaml = join(dir, "routing-policy.yaml");
		const json = join(dir, "routing-policy.json");
		try {
			writeFileSync(yaml, "gateway:\n  num_retries: 2\n");
			writeFileSync(
				json,
				JSON.stringify({
					version: 1,
					gateway: { num_retries: 3, litellm_num_retries: 0 },
				}),
			);
			expect(loadGatewayPolicy(yaml).num_retries).toBe(3);
			expect(loadGatewayPolicy(yaml).litellm_num_retries).toBe(0);
			writeFileSync(json, "gateway:\n  num_retries: 4\n");
			expect(() => loadGatewayPolicy(yaml)).toThrow();
			rmSync(json);
			expect(loadGatewayPolicy(yaml).num_retries).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("runtime JSON wins over runtime YAML", () => {
		const dir = mkdtempSync(join(tmpdir(), "w975-belt-home-"));
		const runtime = join(dir, ".claude", "local-llm");
		const previous = process.env.HOME;
		const previousPin = process.env.BELT_POLICY;
		try {
			mkdirSync(runtime, { recursive: true });
			writeFileSync(
				join(runtime, "routing-policy.yaml"),
				"gateway:\n  num_retries: 2\n",
			);
			writeFileSync(
				join(runtime, "routing-policy.json"),
				JSON.stringify({ gateway: { num_retries: 3 } }),
			);
			process.env.HOME = dir;
			delete process.env.BELT_POLICY;
			expect(loadGatewayPolicy().num_retries).toBe(3);
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
			if (previousPin === undefined) delete process.env.BELT_POLICY;
			else process.env.BELT_POLICY = previousPin;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("defaults apply when the gateway section is absent", () => {
		const p = parsePolicy("version: 1\n");
		expect(p.num_retries).toBe(1);
		expect(p.litellm_num_retries).toBe(1);
		expect(p.allowed_fails).toBe(3);
		expect(p.cooldown_time).toBe(30);
		expect(p.fallbacks).toBeUndefined();
	});

	test("emit omits the fallbacks key when none are configured", () => {
		const out = emitRouterSettings(parsePolicy("version: 1\n"));
		expect(out.includes("fallbacks")).toBe(false);
		expect(out).toContain("routing_strategy: latency-based-routing");
		expect(
			Bun.YAML.parse(emitLiteLlmSettings(parsePolicy("version: 1\n"))),
		).toEqual({
			litellm_settings: {
				drop_params: true,
				callbacks: ["prometheus"],
				require_auth_for_metrics_endpoint: true,
				prometheus_emit_stream_label: true,
			},
		});
	});
});

/** W648 fixture — suffix rule + explicit override + the effort axis. */
const W648_DOC = [
	"classes:",
	"  frontier: [glm-5.3]",
	"  standard: [glm-5.3-flash]",
	"  spark: [local-extract, local-coder]",
	"roles:",
	"  reviewer-low: frontier",
	"reasoning:",
	"  default: medium",
	"  classes:",
	"    spark: low",
	"  roles:",
	"    executor: xhigh",
	"",
].join("\n");

describe("role-class schema (W648, oh-my-codex §1 lift)", () => {
	test("committed default carries the three class rows + effort defaults", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		expect(p.classes).toEqual({
			frontier: ["glm-5.3"],
			standard: ["glm-5.3-flash"],
			spark: ["local-extract", "local-coder"],
		});
		expect(p.roles).toEqual({});
		expect(p.reasoning).toEqual({
			default: "medium",
			classes: { spark: "low" },
			roles: {},
		});
	});

	test("-low suffix drops to spark; explicit roles win; default is standard", () => {
		const p = parsePolicy(W648_DOC);
		expect(resolveRoleClass(p, "executor")).toBe("standard");
		expect(resolveRoleClass(p, "summarize-low")).toBe("spark");
		expect(resolveRoleClass(p, "reviewer-low")).toBe("frontier");
	});

	test("standard inherits frontier; spark inherits standard → frontier", () => {
		const p = parsePolicy("classes:\n  frontier: [glm-5.3]\n");
		expect(resolveClassGroups(p, "standard")).toEqual(["glm-5.3"]);
		expect(resolveClassGroups(p, "spark")).toEqual(["glm-5.3"]);
	});

	test("no rows configured → every class resolves empty (pre-schema files stay valid)", () => {
		const p = parsePolicy("version: 1\n");
		for (const cls of ["frontier", "standard", "spark"] as const)
			expect(resolveClassGroups(p, cls)).toEqual([]);
	});

	test("bad class keys, empty group lists and invalid efforts fail closed", () => {
		expect(() => parsePolicy("classes:\n  ultra: [glm-5.3]\n")).toThrow(
			"not one of",
		);
		expect(() => parsePolicy("classes:\n  spark: []\n")).toThrow(
			"non-empty list",
		);
		expect(() => parsePolicy("reasoning:\n  default: ultra\n")).toThrow(
			"must be one of",
		);
		expect(() => parsePolicy("roles:\n  executor: ✗\n")).toThrow("not one of");
	});

	test("effort precedence: role row > class row > global default", () => {
		const p = parsePolicy(
			"reasoning:\n  default: low\n  classes:\n    standard: medium\n  roles:\n    executor: xhigh\n",
		);
		expect(resolveReasoningEffort(p, "executor")).toBe("xhigh");
		expect(resolveReasoningEffort(p, "planner")).toBe("medium");
		expect(resolveReasoningEffort(p, "watcher-low")).toBe("low");
	});

	test("class-tiers.json artifact parses and carries the resolved map", () => {
		const doc = JSON.parse(emitClassTiers(parsePolicy(W648_DOC))) as {
			classes: Record<string, string[]>;
			roles: Record<string, string>;
			reasoning: {
				default: string;
				classes: Record<string, string>;
				roles: Record<string, string>;
			};
		};
		expect(doc.classes.spark).toEqual(["local-extract", "local-coder"]);
		expect(doc.roles["reviewer-low"]).toBe("frontier");
		expect(doc.reasoning.default).toBe("medium");
	});
});
