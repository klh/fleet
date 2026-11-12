// test/models-route-capabilities.e2e.ts — W2979: /v1/models rows advertise
// operator-pinned serving capabilities (context_length / max_output_tokens /
// reasoning / capability_source) ONLY when every bound deployment pins them
// and they agree; a bare or disagreeing group stays a pure catalog row.
// Malformed conf capabilities are startup fatal (schema law). Pure app.fetch
// tests over testDeps — zero network.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { loadUpstreams } from "../src/upstreams.ts";
import { ModelRowSchema } from "../src/wire-schemas.ts";
import { testDeps } from "./deps.ts";

const CAPS = {
	context_length: 1_048_576,
	max_output_tokens: 131_072,
	reasoning: true,
	capability_source: "provider-published",
} as const;

const poolOf = (capped: Deployment[], bare: Deployment[]): UpstreamPool => ({
	groups: () => ["glm-5.3-flash", "gpt-6-sol"],
	deployments: (g) => (g === "glm-5.3-flash" ? capped : bare),
});

const capped: Deployment[] = [
	{
		group: "glm-5.3-flash",
		url: "https://api.z.ai",
		dialect: "anthropic",
		capabilities: { ...CAPS },
	},
];
// same group, second deployment disagreeing on the output limit
const disagreeing: Deployment[] = [
	{
		group: "glm-5.3-flash",
		url: "https://api.z.ai",
		dialect: "anthropic",
		capabilities: { ...CAPS },
	},
	{
		group: "glm-5.3-flash",
		url: "https://fallback.z.ai",
		dialect: "anthropic",
		capabilities: { ...CAPS, max_output_tokens: 16_384 },
	},
];
const bare: Deployment[] = [
	{ group: "gpt-6-sol", url: "https://api.invalid", dialect: "openai" },
];

test.describe("@api", () => {
	test("conf-pinned capabilities ride the row; bare groups stay bare", async () => {
		const app = createApp(testDeps(poolOf(capped, bare)));
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as { data: Array<Record<string, unknown>> };
		const glm = out.data.find((m) => m.id === "glm-5.3-flash");
		expect(glm).toMatchObject({ ...CAPS, object: "model", owned_by: "buckle" });
		const sol = out.data.find((m) => m.id === "gpt-6-sol");
		expect(sol).toEqual({
			id: "gpt-6-sol",
			object: "model",
			owned_by: "buckle",
		});
		// schema law: both rows parse through the named wire schema
		expect(() => ModelRowSchema.parse(glm)).not.toThrow();
		expect(() => ModelRowSchema.parse(sol)).not.toThrow();
	});

	test("disagreeing deployments advertise nothing (all-or-nothing)", async () => {
		const app = createApp(testDeps(poolOf(disagreeing, bare)));
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		const out = (await res.json()) as { data: Array<Record<string, unknown>> };
		const glm = out.data.find((m) => m.id === "glm-5.3-flash");
		expect(glm).toEqual({
			id: "glm-5.3-flash",
			object: "model",
			owned_by: "buckle",
		});
	});

	test("legacy rows (id/object/owned_by only) still parse — backwards compatible", () => {
		const parsed = ModelRowSchema.parse({
			id: "legacy",
			object: "model",
			owned_by: "buckle",
		});
		expect(parsed.context_length).toBeUndefined();
		expect(parsed.max_output_tokens).toBeUndefined();
	});

	test("malformed conf capabilities are startup fatal (schema law)", () => {
		const dir = mkdtempSync(join(tmpdir(), "buckle-caps-"));
		const path = join(dir, "upstreams.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				groups: {
					"glm-5.3-flash": [
						{
							url: "https://api.z.ai",
							dialect: "anthropic",
							capabilities: { context_length: -5 },
						},
					],
				},
			}),
		);
		expect(() => loadUpstreams(path)).toThrow(/capabilities/);
	});
});

test.describe("@api", () => {
	// W2979.1 (C448): the router walk crosses fallback groups — claims are
	// only guaranteed when EVERY reachable group agrees.
	test("fallback chain that agrees publishes the claim", async () => {
		const fallback: Deployment[] = [
			{
				group: "glm-5.3-flash-fb",
				url: "https://fb.z.ai",
				dialect: "anthropic",
				capabilities: { ...CAPS },
			},
		];
		const deps = testDeps(poolOf(capped, fallback), {
			policy: { fallbacks: { "glm-5.3-flash": ["glm-5.3-flash-fb"] } },
		});
		const app = createApp(deps);
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		const out = (await res.json()) as { data: Array<Record<string, unknown>> };
		expect(out.data.find((m) => m.id === "glm-5.3-flash")).toMatchObject(CAPS);
	});

	test("mismatched fallback limits omit the claim — never an invented minimum", async () => {
		const smaller: Deployment[] = [
			{
				group: "glm-5.3-flash-fb",
				url: "https://fb.z.ai",
				dialect: "anthropic",
				capabilities: { ...CAPS, context_length: 131072 },
			},
		];
		const deps = testDeps(poolOf(capped, smaller), {
			policy: { fallbacks: { "glm-5.3-flash": ["glm-5.3-flash-fb"] } },
		});
		const app = createApp(deps);
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		const out = (await res.json()) as { data: Array<Record<string, unknown>> };
		const glm = out.data.find((m) => m.id === "glm-5.3-flash");
		expect(glm).toEqual({
			id: "glm-5.3-flash",
			object: "model",
			owned_by: "buckle",
		});
	});

	test("fallback group without capabilities omits the claim", async () => {
		const deps = testDeps(poolOf(capped, bare), {
			policy: { fallbacks: { "glm-5.3-flash": ["gpt-6-sol"] } },
		});
		const app = createApp(deps);
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		const out = (await res.json()) as { data: Array<Record<string, unknown>> };
		expect(out.data.find((m) => m.id === "glm-5.3-flash")).toEqual({
			id: "glm-5.3-flash",
			object: "model",
			owned_by: "buckle",
		});
	});

	test("dangling fallback name (no deployments) omits the claim; cycles terminate", async () => {
		const cyclePolicy = {
			fallbacks: { "glm-5.3-flash": ["glm-5.3-flash", "ghost-group"] },
		};
		const deps = testDeps(poolOf(capped, bare), { policy: cyclePolicy });
		const app = createApp(deps);
		const res = await app.fetch(
			new Request("http://buckle.test/v1/models", { method: "GET" }),
		);
		const out = (await res.json()) as { data: Array<Record<string, unknown>> };
		expect(out.data.find((m) => m.id === "glm-5.3-flash")).toEqual({
			id: "glm-5.3-flash",
			object: "model",
			owned_by: "buckle",
		});
	});
});
