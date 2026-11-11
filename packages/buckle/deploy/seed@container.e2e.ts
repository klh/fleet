import { expect, test } from "@playwright/test";
import { z } from "zod";
import { parsePolicy } from "../src/policy.ts";
import { PlatformSchema } from "./seed-contract.ts";
import { fixture } from "./test/fixture.ts";
import { docker, safe, start, cleanupOwnedFixture } from "./test/docker.ts";
import {
	verifyApi,
	verifyNeutral,
	verifyRuntime,
	verifyUnkeyed,
} from "./test/checks.ts";

const ContainerImageSchema = z
	.string()
	.regex(
		/^ghcr\.io\/klh\/fleet\/buckle-seed(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$/,
	);
const image = ContainerImageSchema.parse(
	process.env.BUCKLE_SEED_TEST_IMAGE ??
		"ghcr.io/klh/fleet/buckle-seed:0.1.0-experimental.w2989",
);
const platforms = z
	.array(PlatformSchema)
	.parse(
		process.env.BUCKLE_SEED_TEST_PLATFORM
			? [process.env.BUCKLE_SEED_TEST_PLATFORM]
			: ["linux/amd64", "linux/arm64"],
	);
for (const platform of platforms)
	test(`packaged ${platform} omits capabilities across a mismatched fallback without guessing limits`, async () => {
		const data = await fixture();
		let id = "";
		try {
			const { ModelListResponseSchema } = await import(
				"../src/wire-schemas.ts"
			);
			const upstreamPath = `${data.site}/upstreams.json`;
			const upstreams = await Bun.file(upstreamPath).json();
			const selected = upstreams.groups["seed-model"][0];
			const fallbackCapabilities = {
				...selected.capabilities,
				max_output_tokens: 8192,
			};
			upstreams.groups["seed-fallback"] = [
				{
					...selected,
					model: "seed-fallback",
					group: "seed-fallback",
					capabilities: fallbackCapabilities,
				},
			];
			await Bun.write(upstreamPath, JSON.stringify(upstreams));
			const policyPath = `${data.site}/policy.json`;
			const policy = await Bun.file(policyPath).json();
			policy.gateway.fallbacks = { "seed-model": ["seed-fallback"] };
			policy.tags["seed-fallback"] = ["locality:hub-local"];
			await Bun.write(policyPath, JSON.stringify(policy));
			const EffectiveFallbackPolicySchema = z.object({
				num_retries: z.literal(0),
				request_timeout_s: z.literal(5),
				fallbacks: z.object({
					"seed-model": z.tuple([z.literal("seed-fallback")]),
				}),
			});
			EffectiveFallbackPolicySchema.parse(
				parsePolicy(await Bun.file(policyPath).text()),
			);
			const service = await start(data, image, platform, "runtime");
			id = service.id;
			const response = await fetch(`${service.origin}/v1/models`, {
				headers: { authorization: `Bearer ${data.rootKey}` },
			});
			expect(response.status).toBe(200);
			const catalog = ModelListResponseSchema.parse(await response.json());
			expect(catalog.data).toEqual([
				{ id: "seed-model", object: "model", owned_by: "buckle" },
				{
					id: "seed-fallback",
					object: "model",
					owned_by: "buckle",
					...fallbackCapabilities,
				},
			]);
			console.log(
				JSON.stringify({
					image,
					platform,
					fallbackMismatchOmission: true,
					catalog: catalog.data,
				}),
			);
		} finally {
			await cleanupOwnedFixture(id, data);
		}
	});

for (const platform of platforms)
	test(`packaged ${platform} serves only explicit routes and preserves authentication, SSE, fresh state and probe closure`, async () => {
		const data = await fixture();
		let id = "";
		try {
			const service = await start(data, image, platform, "runtime");
			id = service.id;
			const api = await verifyApi(data, service.origin);
			const runtime = await verifyRuntime(data, image, platform, id);
			const neutral = await verifyNeutral(data, image, platform);
			const unkeyed = await verifyUnkeyed(data, image, platform);
			const receipt = { platform, image, api, runtime, neutral, unkeyed };
			console.log(JSON.stringify(receipt));
			await Bun.write(
				`/tmp/w2989-smoke-${platform.split("/")[1]}.json`,
				`${JSON.stringify(receipt, null, 2)}\n`,
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					fixtureRequests: data.stub.requests.map((request) => ({
						path: request.path,
						authenticated: request.auth === `Bearer ${data.upstreamKey}`,
					})),
				}),
			);
			if (id) {
				const logs = await docker(["logs", id]);
				console.error(safe(logs.out + logs.err, data));
			}
			throw error;
		} finally {
			await cleanupOwnedFixture(id, data);
		}
	});
