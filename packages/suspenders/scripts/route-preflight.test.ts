import { describe, expect, test } from "bun:test";
import type { UpstreamPool } from "../../buckle/src/upstreams.ts";
import {
	checkRoutePreflight,
	routeInputs,
	type RoutePreflightSources,
} from "./route-preflight.ts";

const pool = (
	groups: Record<string, Array<{ url: string; dialect: "openai" }>>,
): UpstreamPool => ({
	groups: () => Object.keys(groups),
	deployments: (name) =>
		(groups[name] ?? []).map((row) => ({ ...row, group: name })),
});

function fixture(): RoutePreflightSources {
	return {
		stack: {
			hubs: {
				peer: {
					url: "http://127.0.0.1:4301",
					upstreams: {
						groups: {
							model: [
								{ url: "https://provider.example/v1", dialect: "openai" },
							],
						},
					},
				},
			},
		},
		localPool: pool({
			model: [{ url: "http://127.0.0.1:4301", dialect: "openai" }],
			fallback: [{ url: "https://other.example/v1", dialect: "openai" }],
		}),
		policy: { fallbacks: { model: ["fallback"] }, num_retries: 0 },
		litellm: { model_list: [] },
		deadlineMs: 900000,
	};
}

describe("route preflight before activation", () => {
	test("a mapped, reachable peer and both synthetic refusal paths pass", async () => {
		const result = await checkRoutePreflight(fixture(), async () => true);
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
		expect(result.drills.map((drill) => drill.failureStatus)).toEqual([
			429, 503,
		]);
	});

	test("unmapped local leaf and cyclic LiteLLM fallbacks block activation", async () => {
		const source = fixture();
		source.localPool = pool({
			model: [{ url: "http://127.0.0.1:11434", dialect: "openai" }],
			fallback: [{ url: "https://other.example/v1", dialect: "openai" }],
		});
		source.litellm = {
			model_list: [{ model_name: "a" }, { model_name: "b" }],
			litellm_settings: { fallbacks: [{ a: ["b"] }, { b: ["a"] }] },
		};
		const result = await checkRoutePreflight(source, async () => true);
		expect(result.ok).toBe(false);
		expect(result.findings.map((finding) => finding.code)).toContain("cycle");
		expect(result.findings.map((finding) => finding.code)).toContain(
			"unmapped_local_target",
		);
	});

	test("declared terminal still needs reachable hub; dead peer fails closed", async () => {
		const source = fixture();
		source.stack = {
			...(source.stack as object),
			route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
		};
		const result = await checkRoutePreflight(source, async () => false);
		expect(result.ok).toBe(false);
		expect(result.probes).toEqual([
			{ origin: "http://127.0.0.1:4301", reachable: false },
		]);
	});

	test("malformed terminal declaration fails instead of silently trusting a local URL", () => {
		const source = fixture();
		source.stack = {
			...(source.stack as object),
			route_preflight: { terminal_origins: "http://127.0.0.1:11434" },
		};
		expect(() => routeInputs(source)).toThrow(
			"terminal_origins must be an array",
		);
	});
});
