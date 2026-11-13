import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { join } from "node:path";

for (const scenario of ["empty", "missing", "configured"] as const)
	test(`shared gateway availability: ${scenario} @unit`, () => {
		const world = scratchWorld();
		try {
			// The kit owns HOME; a bounded child prevents server/settings background work reaching the real HOME.
			const child = Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "model-availability.fixture.ts"),
					scenario,
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: world.home,
						TMPDIR: world.home,
						KLH_SETTINGS: join(world.home, "absent-settings.json"),
						KLH_STACK: join(world.home, "absent-stack.json"),
						BUCKLE_AUTH: "on",
						BUCKLE_REPO_TIER_POLICY: "off",
						BUCKLE_HUB_ID: "availability-fixture",
						BUCKLE_LANE_CACHE_LOG: join(world.home, "lane-cache.jsonl"),
					},
					timeout: 15000,
					killSignal: "SIGKILL",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			const marker = child.stdout
				.toString()
				.split("\n")
				.find((line) => line.startsWith("AVAILABILITY_RESULT="));
			if (!marker) throw Error("Fixture result missing");
			const result = JSON.parse(marker.slice("AVAILABILITY_RESULT=".length));
			const unavailable =
				scenario !== "configured"
					? result.observations
					: [...result.unavailable, ...result.unpinned, result.pinned];
			for (const observation of unavailable) {
				expect(observation.status).toBe(503);
				expect(observation.contentType).toContain("application/problem+json");
				expect(observation.body.detail).toContain(
					"No models available or configured.",
				);
				expect(observation.body.detail).not.toMatch(
					/no (anthropic|openai) candidates/i,
				);
				expect(observation.body.choices).toBeUndefined();
				expect(observation.body.content).toBeUndefined();
			}
			if (scenario !== "configured") {
				expect(result.started).toBe(true);
				if (scenario === "empty") expect(result.modelCount).toBe(0);
				else {
					expect(result.missingConfig).toBe(true);
					expect(result.refusedOutbound).toBeGreaterThan(0);
					expect(result.modelCount).toBeGreaterThan(0);
				}
				expect(result.observations).toHaveLength(4);
				expect(
					result.denied.map((entry: { status: number }) => entry.status),
				).toEqual([401, 403]);
				for (const denied of result.denied)
					expect(denied.body.detail).not.toContain(
						"No models available or configured.",
					);
			} else {
				expect(result.configured).toBe(3);
				expect(result.healthy).toHaveLength(6);
				for (const healthy of result.healthy) expect(healthy.status).toBe(200);
				expect(result.unavailableAttempts).toBeGreaterThan(0);
				expect(result.recovered.status).toBe(200);
				expect(result.protectedErrors).toHaveLength(16);
				for (const protectedError of result.protectedErrors) {
					expect(protectedError.status).toBe(protectedError.expected);
					expect(protectedError.contentType).toContain(
						"application/problem+json",
					);
					expect(protectedError.body.detail).not.toContain(
						"No models available or configured.",
					);
				}
				expect(result.noDeniedOutbound).toBe(true);
				expect(result.pinned.body.code).toBe("no_healthy_fit");
				expect(result.pinned.body.detail).toContain("pin 'model-0'");
				expect(result.denied.body.code).toBe("buckle.tier_no_upstream");
				expect(result.denied.body.detail).not.toContain(
					"No models available or configured.",
				);
			}
		} finally {
			world.clean();
		}
	});
