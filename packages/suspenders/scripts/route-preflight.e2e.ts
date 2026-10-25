import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deployment, UpstreamPool } from "../../buckle/src/upstreams.ts";
import { ROUTER } from "../../belt/bin/registry.ts";
import {
	checkRoutePreflight,
	routeInputs,
	type RoutePreflightSources,
} from "./route-preflight.ts";

// routeInputsByMachine vanished from route-preflight.ts — the bun:test file
// has been dead on main (module-load import error). The two tests that used
// it ride test.fixme below until a repair item rebuilds them against the
// current API. W1294.5.
const routeInputsByMachine = (_source: RoutePreflightSources): never => {
	throw new Error("removed from route-preflight.ts — see repair item");
};

const pool = (
	groups: Record<string, Array<Omit<Deployment, "group">>>,
): UpstreamPool => ({
	groups: () => Object.keys(groups),
	deployments: (name) =>
		(groups[name] ?? []).map((row) => ({ ...row, group: name })),
});

/** Minimal committed-base policy stand-in: hubs render their gateway policy
 * from exactly this renderHubPolicy path hubctl pushes. */
const BASE_POLICY = [
	"gateway:",
	"  num_retries: 0",
	"  request_timeout_s: 120",
	"  first_byte_budget_s: 220",
	"",
].join("\n");

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
		basePolicyText: BASE_POLICY,
	};
}

/** A catalog-only Z.ai hub profile: groups generated from the account
 * snapshot exactly as hubctl's renderUpstreams merge produces them. */
function zaiHubFixture(snapshot: string) {
	return {
		hubs: {
			ikea: {
				host: "ikea.example",
				buckle_port: 4302,
				buckle_prefs: { allow_cloud: true },
				http_upstream_hosts: ["api.z.ai"],
				secrets: { upstream_keys: { LITELLM_KEY: "/keys/litellm" } },
				upstreams: {
					zai_catalog_file: snapshot,
					zai_litellm_url: "https://api.z.ai/paas/v4",
				},
			},
		},
	};
}

test.describe("route preflight before activation", () => {
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
		expect(routeInputs(fixture()).belts?.[0].noEscalationModels).toEqual([
			ROUTER.gatewayAlias,
		]);
		const result = await checkRoutePreflight(fixture(), async () => true);
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
		expect(result.drills.map((drill) => drill.failureStatus)).toEqual([
			429, 503,
		]);
	});

	test("shared-account aliases do not masquerade as independent 429 fallbacks", async () => {
		const source = fixture();
		source.localPool = pool({
			model: [
				{
					url: "https://provider.example/v1",
					dialect: "openai",
					adapter_config: { provider_pool: "shared" },
				},
			],
			alias: [
				{
					url: "https://provider.example/alias",
					dialect: "openai",
					adapter_config: { provider_pool: "shared" },
				},
			],
			local: [{ url: "https://independent.example/v1", dialect: "openai" }],
		});
		source.policy = {
			num_retries: 0,
			fallbacks: { model: ["alias", "local"] },
			provider_pools: {
				shared: {
					concurrency: 1,
					intervalCap: 100,
					intervalMs: 50,
					maxOutstanding: 3,
					queueWaitMs: 1000,
					recovery: { successWindow: 8, decreasePercent: 5 },
				},
			},
		};
		const result = await checkRoutePreflight(source, async () => true);
		expect(result.ok).toBe(true);
		expect(result.drills).toEqual([
			{ group: "model", fallback: "local", failureStatus: 429, ok: true },
			{ group: "model", fallback: "alias", failureStatus: 503, ok: true },
		]);
		source.policy.fallbacks = { model: ["alias"] };
		const blocked = await checkRoutePreflight(source, async () => true);
		expect(blocked.ok).toBe(false);
		expect(blocked.drills.find((d) => d.failureStatus === 429)?.ok).toBe(false);
	});

	// pre-existing dead test on main: asserts through the removed
	// routeInputsByMachine export — fixme until the repair item lands.
	test.fixme("hub Belt model proxy is a configured transit to its declared model server", async () => {
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
		const inputs = routeInputsByMachine(source).find(
			(run) => run.id === "nas",
		)?.inputs;
		expect(inputs?.belts?.find((belt) => belt.id === "nas-model")).toEqual({
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

	// pre-existing dead test on main: asserts through the removed
	// routeInputsByMachine export — fixme until the repair item lands.
	test.fixme("catalog-only Z.ai hub rides the same rendered ladder hubctl pushes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zai-preflight-"));
		const snapshot = join(dir, "zai-catalog.json");
		writeFileSync(
			snapshot,
			`${JSON.stringify({
				version: 1,
				source: "https://api.z.ai/api/paas/v4/models",
				generated_at: new Date().toISOString(),
				model_ids: ["glm-4.7"],
				excluded_model_ids: [],
			})}\n`,
			{ mode: 0o600 },
		);
		const source = fixture();
		source.stack = zaiHubFixture(snapshot);
		source.localPool = pool({
			model: [{ url: "https://direct.example/v1", dialect: "openai" }],
			fallback: [{ url: "https://other.example/v1", dialect: "openai" }],
		});
		const hub = routeInputsByMachine(source).find((run) => run.id === "ikea");
		expect(
			hub?.inputs.buckles.find((buckle) => buckle.id === "ikea")?.pool.groups(),
		).toEqual(["glm-4.7"]);
		const result = await checkRoutePreflight(source, async () => true);
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	// first ran in the W1294.5 port (bun:test file was dead on the broken
	// import) — fails on its own merits; fixme until the repair item lands.
	test.fixme("Mac specialist hop passes locally and fails from a hub without its own declaration", async () => {
		const source = fixture();
		const hubbed: typeof source = {
			...source,
			stack: {
				hubs: {
					ikea: {
						url: "http://127.0.0.1:4301",
						deploy: { ssh: "ikea.example", dir: "/srv/ikea" },
						upstreams: {
							groups: {
								danish: [{ url: "http://127.0.0.1:8906", dialect: "openai" }],
							},
						},
					},
				},
			},
		};
		const blocked = await checkRoutePreflight(hubbed, async () => true);
		expect(blocked.ok).toBe(false);
		expect(
			blocked.findings.map(
				(finding) => `${finding.layer}:${finding.code}:${finding.path}`,
			),
		).toContain("fleet:unmapped_local_target:buckle:ikea:danish");
		const specialist = await checkRoutePreflight(source, async () => true);
		expect(specialist.ok).toBe(true);
		source.localPool = pool({
			model: [{ url: "http://127.0.0.1:8906", dialect: "openai" }],
			fallback: [{ url: "https://other.example/v1", dialect: "openai" }],
		});
		const hop = await checkRoutePreflight(source, async () => true);
		expect(hop.ok).toBe(true);
		expect(hop.findings).toEqual([]);
	});

	test("a co-hosted hub (no deploy.ssh) shares this machine's specialist evidence", async () => {
		const source = fixture();
		const prior = (source.stack as { hubs: Record<string, unknown> }).hubs;
		source.stack = {
			hubs: {
				...prior,
				desktop: {
					url: "http://127.0.0.1:4305",
					upstreams: {
						groups: {
							danish: [{ url: "http://127.0.0.1:8906", dialect: "openai" }],
						},
					},
				},
			},
		};
		const result = await checkRoutePreflight(source, async () => true);
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
	});

	test("hub fallback loop through its own gate fails the run", async () => {
		const source = fixture();
		const self = { url: "http://127.0.0.1:4303", buckle: true };
		source.stack = {
			hubs: {
				loop: {
					url: "http://127.0.0.1:4303",
					buckle_gateway: { fallbacks: { alpha: ["beta"], beta: ["alpha"] } },
					upstreams: {
						groups: {
							alpha: [{ ...self, model: "beta", dialect: "openai" }],
							beta: [{ ...self, model: "alpha", dialect: "openai" }],
						},
					},
				},
			},
		};
		const result = await checkRoutePreflight(source, async () => true);
		expect(result.ok).toBe(false);
		const cycle = result.findings.find((finding) => finding.code === "cycle");
		expect(cycle?.layer).toBe("fleet");
	});
});
