import { test } from "@playwright/test";
import { z } from "zod";
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
