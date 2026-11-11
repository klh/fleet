// desktop-wiring.e2e.ts — W2869.3 leaf witness: real Docker Desktop
// container + real lease store + real credential journal; the buckle
// admin leg rides a loopback stub (the admin API shape is out of scope
// here — the live :4111 mint is the acceptance smoke).

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { listRunnerWorkers } from "../hooks/lib/runners/api/listing.ts";
import { RunnerSpecSchema } from "../hooks/lib/runners/control/control-state.ts";
import { ensureRunnerReaderSchema } from "../hooks/lib/runners/control/cursors.ts";
import {
	ensureRunnerLeaseSchema,
	revokeLease,
} from "../hooks/lib/runners/control/leases.ts";
import {
	RUNNER_SCOPES,
	type RunnerActor,
} from "../hooks/lib/runners/control/rights.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";
import { containerNameOf } from "../hooks/lib/runners/desktop/docker-executor.ts";
import { DESKTOP_RUNNER_IMAGE } from "../hooks/lib/runners/desktop/prereqs.ts";
import {
	canonicalSeedDigest,
	scanSeedDir,
} from "../hooks/lib/runners/desktop/seed.ts";
import { createDesktopRunnerLeaf } from "../hooks/lib/runners/desktop/wiring.ts";
import {
	createFixtureRuntime,
	fixtureResponse,
} from "./durable-runtime.fixtures.ts";

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
		const model = serveStub((_req, _body, n) =>
			fixtureResponse(n, {
				name: "desktop_sandbox_exec",
				arguments: JSON.stringify({ argv: ["cat", "/seed/seed.md"] }),
			}),
		);
		const store = memoryStore();
		const runId = crypto.randomUUID();
		const leafDeps = {
			store,
			durableRoot,
			runtime: {
				...createFixtureRuntime(model.url, async () => {
					throw new Error("unexpected non-sandbox tool");
				}),
				onReport: () => {},
			},
			container: {
				image: DESKTOP_RUNNER_IMAGE,
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
			provider: "fixture",
			model: "fixture",
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
		await expect.poll(() => model.requests.length).toBe(2);
		expect(model.requests.map((request) => request.auth)).toEqual([
			"Bearer bksk_stub_1",
			"Bearer bksk_stub_1",
		]);
		expect(JSON.stringify(model.requests[1]?.body)).toContain(
			"immutable seed body",
		);
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
		await expect.poll(() => model.requests.length).toBe(3);
		expect(model.requests[2]?.auth).toBe("Bearer bksk_stub_3");
		expect(
			await leaf2.controller.stopWithRevocation({ runId, actor: hostActor() }),
		).toEqual({ ok: true, state: "stopped" });
		await leaf2.close();
		await leaf.close();
		model.close();
		admin.close();
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
				image: DESKTOP_RUNNER_IMAGE,
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
		const reader = {
			keyId: spec.owner,
			kind: "api_key",
			scopes: ["buckle:runner:READ_"],
		};
		await expect
			.poll(() =>
				listRunnerWorkers(store, reader).workers.map((worker) => worker.sid),
			)
			.toEqual([runId]);
		expect(revokeLease(store, runId, Date.now()).ok).toBe(true);
		expect(listRunnerWorkers(store, reader).workers).toEqual([]);
		await expect
			.poll(
				() =>
					store.get<{ state: string }>(
						"SELECT state FROM runner_jobs WHERE run_id = ?",
						runId,
					)?.state,
				{ timeout: 20_000 },
			)
			.toBe("stopped");
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
		// a THIRD leaf cannot reattach the revoked run either — the halted
		// row is no longer state='running', so recover never scans it;
		// only a fresh admit (new generation, new runId) restarts.
		const leaf3 = createDesktopRunnerLeaf(leafDeps);
		const recovery = await leaf3.recover();
		expect(recovery.reattached).toEqual([]);
		await leaf3.close();
		await leaf.close();
	});
	test("SIGKILL the leaf process mid-run — reopen recovers the run from disk alone", async () => {
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
		const dbPath = join(world.home, "governor.db");
		const runId = crypto.randomUUID();
		const handoffPath = join(world.home, "handoff.json");
		// the child leaf runs in its own process so the parent can SIGKILL
		// it hard — process death is the only thing that releases the
		// journal host-writer lock without a graceful close(). The child
		// holds its OWN admin stub (same-process loopback only on this
		// machine; child→parent loopback hangs).
		const pkgDir = join(import.meta.dir, "..");
		const modUrl = (rel: string): string => `file://${join(pkgDir, rel)}`;
		const conf = {
			kit: modUrl("../test-kit/src/index.ts"),
			wiring: modUrl("hooks/lib/runners/desktop/wiring.ts"),
			cs: modUrl("hooks/lib/runners/control/control-state.ts"),
			seedMod: modUrl("hooks/lib/runners/desktop/seed.ts"),
			leases: modUrl("hooks/lib/runners/control/leases.ts"),
			cursors: modUrl("hooks/lib/runners/control/cursors.ts"),
			rights: modUrl("hooks/lib/runners/control/rights.ts"),
			storeMod: modUrl("hooks/lib/runners/control/store.ts"),
			pd: modUrl("node_modules/@earendil-works/pi-durable/dist/index.js"),
			home: world.home,
			db: dbPath,
			runId,
			handoff: handoffPath,
			seedRoot,
			spaces: workspacesDir,
			state: durableRoot,
			image: DESKTOP_RUNNER_IMAGE,
		};
		const childSrc = `
const fs = require("node:fs");
let conf = null;
try {
  conf = JSON.parse(process.env.WITNESS_CONF);
  const { serveStub } = await import(conf.kit);
  const { Database } = require("bun:sqlite");
  const { createDesktopRunnerLeaf } = await import(conf.wiring);
  const { RunnerSpecSchema } = await import(conf.cs);
  const { canonicalSeedDigest, scanSeedDir } = await import(conf.seedMod);
  const { ensureRunnerLeaseSchema } = await import(conf.leases);
  const { ensureRunnerReaderSchema } = await import(conf.cursors);
  const { RUNNER_SCOPES } = await import(conf.rights);
  const { sqliteStore } = await import(conf.storeMod);
  const { createRegistry } = await import(conf.pd);
  const stub = serveStub((req, body, n) =>
    n % 2 === 1
      ? Response.json(
          {
            key_id: "key-" + n,
            key: "bksk_stub_" + n,
            name: "witness",
            scopes: ["buckle:proxy:WRITE_"],
            expires_at: Date.now() + 3600000,
          },
          { status: 201 },
        )
      : Response.json({ revoked: "revoked: key-" + n }),
  );
  const store = sqliteStore(new Database(conf.db));
  ensureRunnerLeaseSchema(store);
  ensureRunnerReaderSchema(store);
  const leaf = createDesktopRunnerLeaf({
    store,
    durableRoot: conf.state,
    runtime: {
      models: {},
      registry: createRegistry(),
      env: {},
      settings: undefined,
      onReport: () => {},
    },
    container: { image: conf.image, workspacesDir: conf.spaces, seedRoot: conf.seedRoot },
    credentials: {
      baseUrl: stub.url,
      adminKey: "bksk_admin_stub",
      receiptsPath: conf.home + "/receipts.json",
    },
    executorSid: "executor-witness",
    leaseTtlMs: 6000,
    cleanupTimeoutMs: 2000,
  });
  const spec = RunnerSpecSchema.parse({
    version: 1,
    runId: conf.runId,
    owner: "lane-witness",
    generation: 1,
    kind: "coding",
    seedDigest: canonicalSeedDigest(await scanSeedDir(conf.seedRoot)),
    policyDigest: leaf.policyDigest(),
    provider: "belt",
    model: "glm-5.3",
  });
  const actor = {
    sid: "host-witness",
    scopes: [RUNNER_SCOPES.control, RUNNER_SCOPES.read],
  };
  await leaf.admitAndStart({ spec, actor, seedRoot: conf.seedRoot });
  await leaf.controller.submit({ runId: conf.runId, text: "before kill", actor });
  const out = await leaf.executor.dispatchTool(
    conf.runId,
    ["sh", "-c", "echo killed-witness > /workspace/marker.txt; cat /workspace/marker.txt"],
    { timeoutMs: 15000 },
  );
  if (out.code !== 0) throw new Error("child dispatch failed: " + out.stderr);
  fs.writeFileSync(conf.handoff, JSON.stringify({ ok: true, runId: conf.runId }));
  await new Promise(() => {});
} catch (e) {
  fs.writeFileSync(
    conf.handoff,
    JSON.stringify({ error: String(e) }),
  );
  process.exit(1);
}
`;
		const child = Bun.spawn({
			cmd: ["bun", "-e", childSrc],
			env: { ...process.env, WITNESS_CONF: JSON.stringify(conf) },
			stdout: "pipe",
			stderr: "pipe",
		});
		let handoff = "";
		for (let i = 0; i < 120; i++) {
			await new Promise((r) => setTimeout(r, 500));
			if (existsSync(handoffPath)) {
				handoff = readFileSync(handoffPath, "utf8");
				break;
			}
		}
		expect(handoff).toContain('"ok":true');
		expect(child.exitCode).toBe(null);
		child.kill("SIGKILL");
		await child.exited;
		await new Promise((r) => setTimeout(r, 500));
		// the container outlives the leaf process (docker daemon owns it);
		// the journal lock died with the process.
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
		// reopen: a fresh leaf over the SAME on-disk state recovers the run
		const store2 = sqliteStore(new Database(dbPath));
		ensureRunnerLeaseSchema(store2);
		ensureRunnerReaderSchema(store2);
		const recoveryAdmin = serveStub((request) =>
			new URL(request.url).pathname === "/v1/admin/keys"
				? Response.json(
						{
							key_id: "recovered",
							key: "bksk_recovered",
							name: "witness",
							scopes: ["buckle:proxy:WRITE_"],
							expires_at: Date.now() + 3_600_000,
						},
						{ status: 201 },
					)
				: Response.json({ revoked: "witness" }),
		);
		const leaf2 = createDesktopRunnerLeaf({
			store: store2,
			durableRoot,
			runtime: {
				models: {} as never,
				registry: createRegistry(),
				env: {},
				settings: undefined,
				onReport: () => {},
			},
			container: { image: conf.image, workspacesDir, seedRoot },
			credentials: {
				baseUrl: recoveryAdmin.url,
				adminKey: "bksk_admin_stub",
				receiptsPath: join(world.home, "receipts.json"),
			},
			executorSid: "executor-witness",
			leaseTtlMs: 6_000,
		});
		const recovery = await leaf2.recover();
		expect(recovery.refused).toEqual([]);
		expect(recovery.reattached).toContain(runId);
		// state retained: the marker the KILLED leaf wrote round-trips out
		// of the SAME container through the reopened leaf.
		const out2 = await leaf2.executor.dispatchTool(
			runId,
			["sh", "-c", "cat /workspace/marker.txt"],
			{ timeoutMs: 15_000 },
		);
		expect(out2.code).toBe(0);
		expect(out2.stdout).toContain("killed-witness");
		expect(
			await leaf2.controller.stopWithRevocation({ runId, actor: hostActor() }),
		).toEqual({ ok: true, state: "stopped" });
		await leaf2.close();
		recoveryAdmin.close();
	});
});
