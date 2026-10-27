// W1294.15: rebuilt Mac-specialist-hop coverage. The W1094.1 host boundary
// was silently dropped by the W1253 merge ("route-preflight.ts took W1253
// wholesale") while its test survived — the bun file has been dead on main
// (routeInputsByMachine import). These tests pin the remote-host rule
// against the current API: a deploy.ssh hub judges only its own declared
// terminals; co-hosted hubs and the local gate keep the specialist
// evidence. Companion repair of route-preflight.test.ts (W1294.13).
import { describe, expect, test } from "bun:test";
import type { Deployment, UpstreamPool } from "../../buckle/src/upstreams.ts";
import {
	checkRoutePreflight,
	type RoutePreflightSources,
} from "../scripts/route-preflight.ts";

const pool = (
	groups: Record<string, Array<Omit<Deployment, "group">>>,
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

describe("route preflight remote-host boundary", () => {
	test("Mac specialist hop passes locally and fails from a hub without its own declaration", async () => {
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

	test("a remote hub's own belt proxy is a configured service, not Mac evidence", async () => {
		const source = fixture();
		source.stack = {
			hubs: {
				nas: {
					url: "http://nas.example:4301",
					deploy: { ssh: "nas.example", dir: "/srv/nas" },
					belt_model: {
						port: 8914,
						health_port: 8915,
						upstream: "http://127.0.0.1:11434",
					},
					upstreams: {
						groups: {
							general: [{ url: "http://127.0.0.1:8914", dialect: "openai" }],
						},
					},
				},
			},
			route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
		};
		source.localPool = pool({
			model: [{ url: "https://provider.example/v1", dialect: "openai" }],
			fallback: [{ url: "https://other.example/v1", dialect: "openai" }],
		});
		const result = await checkRoutePreflight(source, async () => true);
		expect(result.ok).toBe(true);
		expect(result.findings).toEqual([]);
	});

	test("a declared terminal maps a remote hub's local leaf; undeclared it blocks", async () => {
		const source = fixture();
		source.stack = {
			hubs: {
				edge: {
					url: "http://edge.example:4301",
					deploy: { ssh: "edge.example", dir: "/srv/edge" },
					upstreams: {
						groups: {
							danish: [{ url: "http://127.0.0.1:11434", dialect: "openai" }],
						},
					},
				},
			},
		};
		const blocked = await checkRoutePreflight(source, async () => true);
		expect(blocked.ok).toBe(false);
		expect(
			blocked.findings.map(
				(finding) => `${finding.layer}:${finding.code}:${finding.path}`,
			),
		).toContain("fleet:unmapped_local_target:buckle:edge:danish");
		source.stack = {
			...source.stack,
			route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
		};
		source.localPool = pool({
			model: [{ url: "https://provider.example/v1", dialect: "openai" }],
			fallback: [{ url: "https://other.example/v1", dialect: "openai" }],
		});
		const mapped = await checkRoutePreflight(source, async () => true);
		expect(mapped.ok).toBe(true);
		expect(mapped.findings).toEqual([]);
	});
});

