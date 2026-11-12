// test/bench-env@unit.e2e.ts — W2971.3 the bench-local leaf composition
// (CI-safe: bun-only, no Docker, no network). The W2971.3 blocker was a
// PARTIAL deps shape — admission refused at the missing container keys —
// so these tests pin the FULL DesktopLeafDeps composition: schema drift
// refuses loud, the mint credential rides in, the store/lease/reader
// schemas exist, and every required deps group (store/durableRoot/
// runtime/container/credentials/executorSid) is present and correctly
// wired to the machine-local bench.local.json.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld, type ScratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	BenchLocalSchema,
	loadBenchEnv,
	loadBenchLocal,
} from "../bench/durable/bench-env.ts";

/** One hermetic bench-local world: temp bench.local.json + 0600 mint file
 *  inside the scratch repo; the machine's real file is never touched. */
function benchWorld(mintContent = "bksk_test_mint_root_not_a_real_key\n") {
	const world = scratchWorld();
	const stateDir = join(world.repo, "bench-state");
	const mintFile = join(world.repo, "mint-root.raw");
	writeFileSync(mintFile, mintContent, { mode: 0o600 });
	const localPath = join(world.repo, "bench.local.json");
	writeFileSync(
		localPath,
		JSON.stringify({
			repos: { sphinx: world.repo },
			identityUrl: "http://127.0.0.1:4599",
			mintCredentialFile: mintFile,
			image: "fleet-supervisor-seed:0.1.2-experimental.test",
			judgeImage: "klh/blam-judge@sha256:" + "b".repeat(64),
			stateDir,
		}),
	);
	return { world, stateDir, mintFile, localPath };
}

test.describe("bench.local.json schema law", () => {
	test("the W2971.3-minimum shape (no stateDir) refuses loudly", () => {
		const legacy = {
			repos: { sphinx: "/tmp/w2971-sphinx" },
			identityUrl: "http://127.0.0.1:4599",
			mintCredentialFile: "/tmp/mint-root.raw",
			image: "fleet-supervisor-seed:0.1.2",
		};
		const parsed = BenchLocalSchema.safeParse(legacy);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.message).toContain("stateDir");
		}
	});

	test("a full shape parses; modelBaseUrl splits the model plane when given", () => {
		const full = {
			repos: { sphinx: "/tmp/w2971-sphinx" },
			identityUrl: "http://127.0.0.1:4599",
			mintCredentialFile: "/tmp/mint-root.raw",
			image: "fleet-supervisor-seed:0.1.2",
			judgeImage: "klh/blam-judge@sha256:" + "a".repeat(64),
			stateDir: "/tmp/w2971-bench-state",
		};
		expect(BenchLocalSchema.safeParse(full).success).toBe(true);
		expect(
			BenchLocalSchema.safeParse({
				...full,
				modelBaseUrl: "http://127.0.0.1:4111",
			}).success,
		).toBe(true);
	});

	test("loadBenchLocal refuses a drifted file with the schema message", () => {
		const world = scratchWorld();
		const path = join(world.repo, "bench.local.json");
		writeFileSync(path, JSON.stringify({ repos: {} }));
		expect(() => loadBenchLocal(path)).toThrow(/drift refused/);
		world.clean();
	});
});

test.describe("loadBenchEnv full DesktopLeafDeps composition", () => {
	test("composes store, private dirs, belt runtime, container, credentials, executorSid", async () => {
		const { world, stateDir, localPath } = benchWorld();
		const seedRoot = join(world.repo, "seed");
		const deps = await loadBenchEnv({
			seedRoot,
			model: "glm-5.3-flash",
			wallClockMin: 30,
			localPath,
		});
		// every required DesktopLeafDeps group present — the W2971.3
		// dockerBin-class refusal was a missing group, not a missing field
		expect(deps.store).toBeTruthy();
		expect(typeof deps.store.all).toBe("function");
		expect(deps.durableRoot).toBe(join(stateDir, "durable"));
		expect(deps.executorSid).toBe("desktop-runner");
		expect(deps.runtime.models).toBeTruthy();
		expect(deps.runtime.registry).toBeTruthy();
		expect(deps.container.image).toContain("fleet-supervisor-seed");
		expect(deps.container.seedRoot).toBe(seedRoot);
		expect(deps.container.workspacesDir).toBe(join(stateDir, "workspaces"));
		expect(deps.credentials.baseUrl).toBe("http://127.0.0.1:4599");
		expect(deps.credentials.adminKey).toBe(
			"bksk_test_mint_root_not_a_real_key",
		);
		expect(deps.credentials.receiptsPath).toBe(
			join(stateDir, "credentials.json"),
		);
		// store is schema-live: the lease control table exists (fresh store)
		const tables = deps.store.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table'",
		);
		expect(tables.map((t) => t.name)).toContain("runner_leases");
		world.clean();
	});

	test("an empty mint credential file refuses (fail-closed)", async () => {
		const { world, localPath } = benchWorld("   \n");
		await expect(
			loadBenchEnv({
				seedRoot: join(world.repo, "seed"),
				model: "glm-5.3-flash",
				wallClockMin: null,
				localPath,
			}),
		).rejects.toThrow(/mint credential file empty/);
		world.clean();
	});
});
