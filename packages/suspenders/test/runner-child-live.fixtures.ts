import { Database } from "bun:sqlite";
import { DESKTOP_RUNNER_IMAGE } from "../hooks/lib/runners/desktop/prereqs.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { RUNNER_SCOPES } from "../hooks/lib/runners/control/rights.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";
import {
	canonicalSeedDigest,
	scanSeedDir,
} from "../hooks/lib/runners/desktop/seed.ts";
import { createDesktopRunnerLeaf } from "../hooks/lib/runners/desktop/wiring.ts";
import {
	createFixtureRuntime,
	fixtureResponse,
} from "./durable-runtime.fixtures.ts";

export async function liveChildWorld() {
	const world = scratchWorld({ prefix: "runner-child-live-" });
	const durableRoot = join(world.home, "state");
	const workspacesDir = join(world.home, "workspaces");
	const seedRoot = join(world.home, "seed");
	for (const path of [durableRoot, workspacesDir, seedRoot])
		mkdirSync(path, { recursive: true });
	writeFileSync(join(seedRoot, "seed.md"), "delegated fixture seed\n");
	let minted = 0;
	let revoked = 0;
	const admin = serveStub((req) => {
		if (new URL(req.url).pathname.endsWith("/revoke")) {
			revoked++;
			return Response.json({ revoked: "fixture revoked" });
		}
		minted++;
		return Response.json(
			{
				key_id: `fixture-${minted}`,
				key: `bksk_fixture_${minted}`,
				name: "delegated-fixture",
				scopes: ["buckle:proxy:WRITE_"],
				expires_at: Date.now() + 3600000,
			},
			{ status: 201 },
		);
	});
	let hold = false;
	const model = serveStub((_req, _body, n) => {
		if (hold)
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(": fixture waiting\n\n"),
						);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		return fixtureResponse(n, {
			name: "desktop_sandbox_exec",
			arguments: JSON.stringify({ argv: ["cat", "/seed/seed.md"] }),
		});
	});
	const db = new Database(":memory:");
	const store = sqliteStore(db);
	const leaf = createDesktopRunnerLeaf({
		store,
		durableRoot,
		runtime: createFixtureRuntime(model.url, async () => {
			throw new Error("Unexpected fixture tool");
		}),
		container: {
			image: DESKTOP_RUNNER_IMAGE,
			workspacesDir,
			seedRoot,
		},
		credentials: {
			baseUrl: admin.url,
			adminKey: "bksk_admin_fixture",
			receiptsPath: join(world.home, "credentials.json"),
		},
		executorSid: "delegated-executor",
		leaseTtlMs: 60000,
	});
	const actor = {
		sid: "delegating-host",
		scopes: [RUNNER_SCOPES.control, RUNNER_SCOPES.read],
	};
	return {
		actor,
		deps: {
			store,
			actor,
			routes: [{ provider: "fixture", model: "fixture" }],
			execution: {
				seedDigest: canonicalSeedDigest(await scanSeedDir(seedRoot)),
				policyDigest: leaf.policyDigest(),
			},
			controller: {
				admit: (input: Parameters<typeof leaf.controller.admit>[0]) =>
					leaf.admitAndStart({ ...input, seedRoot }),
				stopWithRevocation: leaf.controller.stopWithRevocation,
			},
		},
		async close() {
			try {
				await leaf.close();
			} finally {
				model.close();
				admin.close();
				db.close();
				world.clean();
			}
		},
		leaf,
		store,
		db,
		model,
		holdModel: () => {
			hold = true;
		},
		world,
		durableRoot,
		workspacesDir,
		seedRoot,
		admin,
		counts: () => ({ minted, revoked }),
	};
}
