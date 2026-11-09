// desktop-wiring.e2e.ts — W2869.3 leaf witness: real Docker Desktop
// container + real lease store + real credential journal; the buckle
// admin leg rides a loopback stub (the admin API shape is out of scope
// here — the live :4111 mint is the acceptance smoke).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { createDesktopRunnerLeaf } from "../hooks/lib/runners/desktop/wiring.ts";
import { RunnerSpecSchema } from "../hooks/lib/runners/control/control-state.ts";
import {
	canonicalSeedDigest,
	scanSeedDir,
} from "../hooks/lib/runners/desktop/seed.ts";
import { containerNameOf } from "../hooks/lib/runners/desktop/docker-executor.ts";
import {
	ensureRunnerLeaseSchema,
	revokeLease,
} from "../hooks/lib/runners/control/leases.ts";
import { ensureRunnerReaderSchema } from "../hooks/lib/runners/control/cursors.ts";
import {
	RUNNER_SCOPES,
	type RunnerActor,
} from "../hooks/lib/runners/control/rights.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";
import { scratchWorld, serveStub } from "@klh/test-kit";

const dockerUp = (): boolean =>
	Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
		stdout: "pipe",
		stderr: "pipe",
	}).exitCode === 0;

const memoryStore = () => {
	const store = sqliteStore(new Database(":memory:"));
	ensureRunnerLeaseSchema(store);
	ensureRunnerReaderSchema(store);
	return store;
};

const hostActor = (): RunnerActor => ({
	sid: "host-witness",
	scopes: [RUNNER_SCOPES.control, RUNNER_SCOPES.read],
});

// Buckle-admin stub: odd request = mint → 201, even = revoke → 200.
const adminStub = () =>
	serveStub((_req, _body, n) =>
		n % 2 === 1
			? Response.json(
					{
						key_id: `key-${n}`,
						key: `bksk_stub_${n}`,
						name: "witness",
						scopes: ["buckle:proxy:WRITE_"],
						expires_at: Date.now() + 3_600_000,
					},
					{ status: 201 },
				)
			: Response.json({ revoked: `revoked: key-${n}` }),
	);

test.describe("desktop runner leaf (W2869.3)", () => {
	test("admit → real container → fenced effect → revoke blocks → reopen recovers", async () => {
		test.skip(
			!dockerUp(),
			"real Docker Desktop witness — docker daemon unreachable",
		);
		const world = scratchWorld({ prefix: "desktop-wiring-" });
		const durableRoot = join(world.home, "state");
		const workspacesDir = join(world.home, "workspaces");
		const seedRoot = join(world.home, "seed");
		mkdirSync(durableRoot, { recursive: true });
		mkdirSync(workspacesDir, { recursive: true });
		mkdirSync(seedRoot, { recursive: true });
		writeFileSync(join(seedRoot, "seed.md"), "immutable seed body\n");
		const admin = adminStub();
		const store = memoryStore();
		const runId = crypto.randomUUID();
		const leafDeps = {
			store,
			durableRoot,
			runtime: {
				models: {} as never,
				registry: createRegistry(),
				env: {},
				settings: undefined,
				onReport: () => {},
			},
			container: {
				image:
					"alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
				workspacesDir,
				seedRoot,
			},
			credentials: {
				baseUrl: admin.url,
				adminKey: "bksk_admin_stub",
				receiptsPath: join(world.home, "receipts.json"),
			},
			executorSid: "executor-witness",
			leaseTtlMs: 6_000,
			cleanupTimeoutMs: 2_000,
		};
		const leaf = createDesktopRunnerLeaf(leafDeps);
		const spec = RunnerSpecSchema.parse({
			version: 1 as const,
			runId,
			owner: "lane-witness",
			generation: 1,
			kind: "coding" as const,
			seedDigest: canonicalSeedDigest(await scanSeedDir(seedRoot)),
			policyDigest: leaf.policyDigest(),
			provider: "belt",
			model: "glm-5.3",
		});
		const { token } = await leaf.admitAndStart({
			spec,
			actor: hostActor(),
			seedRoot,
		});
		expect(token.epoch).toBe(1);
		// the cold start (container + durable job) rides the first submit
		await leaf.controller.submit({
			runId,
			text: "first turn",
			actor: hostActor(),
		});
		const ps = Bun.spawnSync(
			[
				"docker",
				"ps",
				"--filter",
				`name=${containerNameOf(runId)}`,
				"--format",
				"{{.Names}}",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(ps.stdout.toString().trim()).toBe(containerNameOf(runId));
		const marker = `witness-${Date.now()}`;
		const out = await leaf.executor.dispatchTool(
			runId,
			[
				"sh",
				"-c",
				`echo ${marker} > /workspace/marker.txt; cat /workspace/marker.txt`,
			],
			{ timeoutMs: 15_000 },
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain(marker);
		// crash/reopen: a NEW leaf over the SAME store + journal + container
		// recovers the run from the control row alone. The OLD leaf's
		// still-open durable job holds the journal's host-writer lock, so
		// close it first — close() stops jobs/watchdogs WITHOUT revoking
		// the lease or credential, exactly a crash minus the revocation.
		await leaf.close();
		const leaf2 = createDesktopRunnerLeaf(leafDeps);
		const recovery = await leaf2.recover();
		expect(recovery.reattached).toContain(runId);
		await leaf2.controller.submit({
			runId,
			text: "second turn",
			actor: hostActor(),
		});
		expect(
			store.get<{ state: string }>(
				"SELECT state FROM runner_jobs WHERE run_id = ?",
				runId,
			)?.state,
		).toBe("running");
		await leaf2.close();
		await leaf.close();
	});

	test("lease revoke blocks every next effect — halt, revoke, refused reattach", async () => {
		const world = scratchWorld({ prefix: "desktop-wiring-" });
		const durableRoot = join(world.home, "state");
		const workspacesDir = join(world.home, "workspaces");
		const seedRoot = join(world.home, "seed");
		mkdirSync(durableRoot, { recursive: true });
		mkdirSync(workspacesDir, { recursive: true });
		mkdirSync(seedRoot, { recursive: true });
		writeFileSync(join(seedRoot, "seed.md"), "immutable seed body\n");
		const admin = adminStub();
		const store = memoryStore();
		const leafDeps = {
			store,
			durableRoot,
			runtime: {
				models: {} as never,
				registry: createRegistry(),
				env: {},
				settings: undefined,
				onReport: () => {},
			},
			container: {
				image:
					"alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
				workspacesDir,
				seedRoot,
			},
			credentials: {
				baseUrl: admin.url,
				adminKey: "bksk_admin_stub",
				receiptsPath: join(world.home, "receipts.json"),
			},
			executorSid: "executor-witness",
			leaseTtlMs: 6_000,
			cleanupTimeoutMs: 2_000,
		};
		const leaf = createDesktopRunnerLeaf(leafDeps);
		const runId = crypto.randomUUID();

		const spec = RunnerSpecSchema.parse({
			version: 1 as const,
			runId,
			owner: "lane-witness",
			generation: 1,
			kind: "coding" as const,
			seedDigest: canonicalSeedDigest(await scanSeedDir(seedRoot)),
			policyDigest: leaf.policyDigest(),
			provider: "belt",
			model: "glm-5.3",
		});
		await leaf.admitAndStart({ spec, actor: hostActor(), seedRoot });
		await leaf.controller.submit({
			runId,
			text: "turn before revoke",
			actor: hostActor(),
		});
		const ps = Bun.spawnSync(
			[
				"docker",
				"ps",
				"--filter",
				`name=${containerNameOf(runId)}`,
				"--format",
				"{{.Names}}",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(ps.stdout.toString().trim()).toBe(containerNameOf(runId));
		expect(revokeLease(store, runId, Date.now()).ok).toBe(true);
		await new Promise((r) => setTimeout(r, 5_000));

		const jobRow = store.get<{ state: string }>(
			"SELECT state FROM runner_jobs WHERE run_id = ?",
			runId,
		);
		expect(jobRow?.state).not.toBe("running");
		const receipts = JSON.parse(
			readFileSync(join(world.home, "receipts.json"), "utf8"),
		) as { revokedAt: number | null }[];
		expect(receipts.some((r) => r.revokedAt != null)).toBe(true);
		const refused = await leaf.controller.submit({
			runId,
			text: "after revoke",
			actor: hostActor(),
		});
		expect(refused.ok).toBe(false);
		// a THIRD leaf cannot reattach the revoked run either — the lease
		// is gone; only a fresh admit (new generation, new runId) restarts.
		// a THIRD leaf cannot reattach the revoked run either — the halted
		// row is no longer state='running', so recover never scans it;
		// only a fresh admit (new generation, new runId) restarts.
		const leaf3 = createDesktopRunnerLeaf(leafDeps);
		const recovery = await leaf3.recover();
		expect(recovery.reattached).toEqual([]);
		await leaf3.close();
		await leaf.close();
	});
});
