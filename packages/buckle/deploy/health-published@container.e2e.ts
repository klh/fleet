import { test } from "@playwright/test";
import { z } from "zod";
import { PlatformSchema } from "./seed-contract.ts";
import { verifyPublishedHealth } from "./test/health-published.ts";

const HealthImageSchema = z
	.string()
	.regex(
		/^ghcr\.io\/klh\/fleet\/buckle-seed(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$/,
	);
const image = HealthImageSchema.parse(
	process.env.BUCKLE_SEED_TEST_IMAGE ??
		"ghcr.io/klh/fleet/buckle-seed@sha256:166b3adfe7e2de430fe1858ad7fe2bdb1aa8aab4c6370727e242670bee0c4066",
);
const platforms = z
	.array(PlatformSchema)
	.parse(
		process.env.BUCKLE_SEED_TEST_PLATFORM
			? [process.env.BUCKLE_SEED_TEST_PLATFORM]
			: ["linux/amd64", "linux/arm64"],
	);

for (const platform of platforms)
	for (const explicit of [true, false])
		test(`published health ${platform} ${explicit ? "explicit wildcard reachable" : "default loopback isolated"}`, async () => {
			console.log(
				JSON.stringify(await verifyPublishedHealth(image, platform, explicit)),
			);
		});
