import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	emitClassTiers,
	emitFallbackSettings,
	emitGeneralSettings,
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
			default_litellm_params: { max_retries: 0 },
			allowed_fails: 3,
			cooldown_time: 30,
		});
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
		const doc = Bun.YAML.parse(
			emitFallbackSettings(emitterTestFallbacks()),
		) as {
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

	test("explicit inner fallback opt-out preserves the front's policy ladder", () => {
		const policy = parsePolicy(
			"gateway:\n  litellm_fallbacks: false\n  fallbacks:\n    primary: [secondary]\n",
		);
		expect(emitFallbackSettings(policy)).toBe("");
		expect(policy.fallbacks).toEqual({ primary: ["secondary"] });
		expect(
			emitFallbackSettings({ ...policy, litellm_fallbacks: true }),
		).toContain("primary: [secondary]");
	});

	test("inner fallbacks default on and reject non-boolean config", () => {
		expect(parsePolicy("version: 1\n").litellm_fallbacks).toBe(true);
		for (const invalid of ["null", "0", "1", '"false"', "[]", "{}"])
			expect(() =>
				parsePolicy(`gateway:\n  litellm_fallbacks: ${invalid}\n`),
			).toThrow("must be a boolean");
	});

	test("background health checks default on, reject non-boolean, gate the general_settings block (W886)", () => {
		expect(parsePolicy("version: 1\n").litellm_health_checks).toBe(true);
		for (const invalid of ["null", "0", "1", '"true"', "[]", "{}"])
			expect(() =>
				parsePolicy(`gateway:\n  litellm_health_checks: ${invalid}\n`),
			).toThrow("must be a boolean");
		const on = Bun.YAML.parse(
			emitGeneralSettings(parsePolicy("version: 1\n")),
		) as { general_settings: Record<string, unknown> };
		expect(on.general_settings.background_health_checks).toBe(true);
		expect(on.general_settings.health_check_interval).toBe(300);
		expect(on.general_settings.master_key).toBe("os.environ/LITELLM_KEY");
		const off = Bun.YAML.parse(
			emitGeneralSettings({
				...parsePolicy("version: 1\n"),
				litellm_health_checks: false,
			}),
		) as { general_settings: Record<string, unknown> };
		expect(off.general_settings.background_health_checks).toBeUndefined();
		expect(off.general_settings.master_key).toBe("os.environ/LITELLM_KEY");
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
		expect(p.litellm_num_retries).toBe(1);
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
