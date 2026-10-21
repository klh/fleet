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
	test("--help returns usage without reading the machine stack", () => {
		const command = Bun.spawnSync(
			[
				process.execPath,
				new URL("./route-preflight.ts", import.meta.url).pathname,
				"--help",
			],
			{ env: { ...process.env, KLH_STACK: "/missing/stack.yaml" } },
		);
		expect(command.exitCode).toBe(0);
		expect(command.stdout.toString()).toContain("--static");
	});

	test("uses the same KLH_STACK path as hubctl when conflicting overrides exist", () => {
		const command = Bun.spawnSync(
			[
				process.execPath,
				new URL("./route-preflight.ts", import.meta.url).pathname,
				"--static",
			],
			{
				env: {
					...process.env,
					KLH_STACK: "/missing/canonical-stack.yaml",
					KLH_STACK_CONFIG: "/dev/null",
				},
			},
		);
		expect(command.exitCode).toBe(1);
		expect(command.stderr.toString()).toContain(
			"/missing/canonical-stack.yaml",
		);
	});

	test("a mapped, reachable peer and both synthetic refusal paths pass", async () => {
		const result = await checkRoutePreflight(fixture(), async () => true);
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
		expect(result.drills.map((drill) => drill.failureStatus)).toEqual([
			429, 503,
		]);
	});

	test("hub Belt model proxy is a configured transit to its declared model server", async () => {
		const source = fixture();
		source.stack = {
			route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
			hubs: {
				nas: {
					host: "nas.example",
					buckle_port: 4301,
					belt_model: {
						port: 8914,
						health_port: 8915,
						upstream: "http://127.0.0.1:11434",
					},
					upstreams: {
						groups: {
							model: [{ url: "http://127.0.0.1:8914", dialect: "openai" }],
						},
					},
				},
			},
		};
		source.localPool = pool({
			model: [{ url: "http://nas.example:4301", dialect: "openai" }],
			fallback: [{ url: "https://other.example/v1", dialect: "openai" }],
		});
		const inputs = routeInputs(source);
		expect(inputs.belts?.find((belt) => belt.id === "nas-model")).toEqual({
			id: "nas-model",
			origins: ["http://nas.example:8914", "http://127.0.0.1:8914"],
			upstream: "http://127.0.0.1:11434",
		});
		const result = await checkRoutePreflight(source, async () => true);
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
		delete (source.stack as { route_preflight?: unknown }).route_preflight;
		const missingLeaf = await checkRoutePreflight(source, async () => true);
		expect(missingLeaf.findings.map((finding) => finding.code)).toContain(
			"unmapped_local_target",
		);
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

	test("static first-deploy mode validates graph and drill without requiring the target to be up", async () => {
		const result = await checkRoutePreflight(
			fixture(),
			async () => {
				throw new Error("must not probe an unstarted target");
			},
			{ probeHubs: false },
		);
		expect(result.mode).toBe("static");
		expect(result.ok).toBe(true);
		expect(result.probes).toEqual([]);
		expect(result.drills).toHaveLength(2);
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
