// test/coord-workers.e2e.ts — W2886: `coord workers`/`coord hub <name> workers`
// federated worker inventory. Rides the test kit (scratchWorld + serveStub +
// runCliAsync, W1135.1.3) — a real scratch governor.db (GOVERNOR_STORE_URL
// local), a stub peer hub answering /v1/workers, no hand-rolled mkdtemp/spawn.
import { runCliAsync, scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rightsForTest, workerSchema } from "../hooks/coord/workers.ts";

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");

test.describe("@api", () => {
	const world = scratchWorld({ prefix: "coord-workers-" });
	const env = { HOME: world.home, GOVERNOR_STORE_URL: "local" };

	test.afterAll(() => world.clean());

	test("rightsFor: owner for the asker, steerable+read-only for other local lanes, read-only for remote", () => {
		expect(rightsForTest("sidA", "sidA", "local")).toEqual(["owner"]);
		expect(rightsForTest("sidB", "sidA", "local")).toEqual([
			"steerable",
			"read-only",
		]);
		expect(rightsForTest("sidB", null, "remote")).toEqual(["read-only"]);
	});

	test("workers register: upserts an unregistered-session row surfaced in the local listing", async () => {
		const reg = await runCliAsync(
			COORD,
			[
				"workers",
				"register",
				"--as",
				"remote-azure-1",
				"--name",
				"azure worker",
				"--origin-kind",
				"controller",
				"--compute-kind",
				"cloud",
				"--host",
				"azure-vm-1",
				"--region",
				"westeurope",
			],
			{ cwd: world.repo, env },
		);
		expect(reg.code).toBe(0);

		const listed = await runCliAsync(
			COORD,
			["workers", "--json", "--local-only"],
			{ cwd: world.repo, env },
		);
		expect(listed.code).toBe(0);
		const payload = JSON.parse(listed.out) as {
			workers: unknown[];
			errors: unknown[];
		};
		const parsed = payload.workers.map((w) => workerSchema.parse(w));
		const azure = parsed.find((w) => w.sid === "remote-azure-1");
		expect(azure).toBeTruthy();
		// azure-like compute row: no hub field, kind=cloud
		expect(azure?.compute).toEqual({
			kind: "cloud",
			host: "azure-vm-1",
			region: "westeurope",
			hub_id: null,
		});
		expect(azure?.class).toBe("remote");
		expect(azure?.reported_by).toBe("hub:announce");
		expect(azure?.rights).toEqual(["read-only"]);
	});

	test("workers register: owner_sid is a one-time claim, a later heartbeat cannot hijack it", async () => {
		const first = await runCliAsync(
			COORD,
			["workers", "register", "--as", "guarded-sid", "--owner-sid", "owner-a"],
			{ cwd: world.repo, env },
		);
		expect(first.code).toBe(0);
		const hijack = await runCliAsync(
			COORD,
			["workers", "register", "--as", "guarded-sid", "--owner-sid", "owner-b"],
			{ cwd: world.repo, env },
		);
		expect(hijack.code).toBe(2);
		expect(hijack.err).toContain("already owned by owner-a");
	});

	test("workers register: accepts the W2888 JSON-positional wire payload", async () => {
		const payload = JSON.stringify({
			sid: "pi-durable-1",
			name: "pi durable worker",
			origin_kind: "controller",
			origin_id: "ctl-1",
			compute_kind: "hub",
			compute_host: "nas.local",
			hub_id: "nas",
			owner_sid: "owner-pi",
			state: "RUNNING",
			task: "heartbeat",
		});
		const reg = await runCliAsync(COORD, ["workers", "register", payload], {
			cwd: world.repo,
			env,
		});
		expect(reg.code).toBe(0);
		const listed = await runCliAsync(
			COORD,
			["workers", "--json", "--local-only"],
			{ cwd: world.repo, env },
		);
		const out = JSON.parse(listed.out) as { workers: unknown[] };
		const parsed = out.workers.map((w) => workerSchema.parse(w));
		const row = parsed.find((w) => w.sid === "pi-durable-1");
		expect(row?.compute).toEqual({
			kind: "hub",
			host: "nas.local",
			region: null,
			hub_id: "nas",
		});
		expect(row?.owner_sid).toBe("owner-pi");
	});

	test("coord hub <name> workers: that hub's own answer only, no further federation", async () => {
		const hub = serveStub((req) => {
			if (new URL(req.url).pathname !== "/v1/workers")
				return new Response("ok");
			return Response.json({
				schema_version: 1,
				verb: "workers",
				asOf: Date.now(),
				errors: [],
				workers: [
					{
						sid: "peer-sid-1",
						name: "peer worker",
						class: "local",
						origin: { kind: "session", id: null },
						compute: { kind: "hub", host: null, region: null, hub_id: "Peer" },
						inference: [],
						owner_sid: null,
						rights: ["steerable", "read-only"],
						state: "RUNNING",
						task: null,
						activity: [],
						reported_by: "plane:session",
					},
				],
			});
		});
		const TOKEN = join(world.home, "peer.key");
		writeFileSync(TOKEN, "peer-key\n");
		const STACK = join(world.home, "stack.json");
		writeFileSync(
			STACK,
			JSON.stringify({
				hubs: {
					Peer: { host: "127.0.0.1", buckle_port: hub.port, token_file: TOKEN },
				},
			}),
		);
		try {
			const p = await runCliAsync(COORD, ["hub", "Peer", "workers", "--json"], {
				cwd: world.repo,
				env: { ...env, KLH_STACK: STACK },
			});
			expect(p.code).toBe(0);
			const out = JSON.parse(p.out) as { workers: Array<{ sid: string }> };
			expect(out.workers).toHaveLength(1);
			expect(out.workers[0]?.sid).toBe("peer-sid-1");
		} finally {
			hub.close();
		}
	});

	test("coord workers --json: federated merge marks an unreachable hub in errors, never silently drops it", async () => {
		const STACK = join(world.home, "stack2.json");
		writeFileSync(
			STACK,
			JSON.stringify({
				hubs: {
					Ghost: {
						host: "127.0.0.1",
						buckle_port: 1,
						token_file: join(world.home, "no-such-key"),
					},
				},
			}),
		);
		const p = await runCliAsync(COORD, ["workers", "--json"], {
			cwd: world.repo,
			env: { ...env, KLH_STACK: STACK },
		});
		expect(p.code).toBe(0);
		const out = JSON.parse(p.out) as {
			errors: Array<{ scope: string; message: string }>;
		};
		expect(out.errors.some((e) => e.scope === "Ghost")).toBe(true);
	});
});
