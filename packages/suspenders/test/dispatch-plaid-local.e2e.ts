// test/dispatch-plaid-local.test.ts — W1124.3: the INSTALLED dispatch face
// admits a config-declared local-coder pool route. dispatch-next (child
// process, fixture HOME) probes the stub buckle front's /v1/models, walls
// the pinned local-coder when the front doesn't serve it ("not served"),
// holds fail-closed on an unreachable front (catalog unavailable), and
// admits the lane onto the served model through the pool pick. The dry-run
// face (--dry-run, no probe ran) lets the explicit pin stand.
import { expect, test } from "@playwright/test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { HOME, REPO, dispatchA, addItem } = dispatchHarness(test.afterAll, {
	tag: "w1124-local",
	beltEnv: true,
});

// scratch `claude` on PATH — plaidHealth bin-probes the route executor
const binDir = join(HOME, "bin");
mkdirSync(binDir, { recursive: true });
const stubClaude = join(binDir, "claude");
writeFileSync(stubClaude, "#!/bin/sh\nexit 0\n");
chmodSync(stubClaude, 0o700);

const machineRoutes = (): void => {
	// the W1124.3 shape: the host's Belt local coder is the only configured
	// route (operator conf declares it; never a committed default row)
	mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
	writeFileSync(
		join(HOME, ".claude", "local-llm", "suspenders-board.json"),
		JSON.stringify({
			plaid_routes: [
				{
					name: "local-coder",
					label: "Belt local coder",
					executor: "claude",
					model: "local-coder",
					provider: "local",
				},
			],
		}),
	);
	// the W1102.2 host-pressure guard (0600) — plaid launches hold without it
	const guard = join(HOME, ".claude", "local-llm", "belt.env");
	writeFileSync(guard, "BELT_WIRED_GUARD_GB=90\n", { mode: 0o600 });
	chmodSync(guard, 0o600);
};

const plaidPosture = (): void => {
	mkdirSync(join(REPO, ".fleet"), { recursive: true });
	writeFileSync(join(REPO, ".fleet", "posture"), "plaid\n");
};

/** Stub buckle front serving /status + a fixture /v1/models catalog. */
const modelFront = (ids: string[]) => {
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const path = new URL(req.url).pathname;
			if (path === "/status") return new Response("ok");
			if (path === "/v1/models")
				return Response.json({ data: ids.map((id) => ({ id })) });
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
};

test.describe("W1124.3 plaid local-coder: dry-run + installed-face launch selection", () => {
	test("dry-run: the explicit local-coder pin is admitted, health checked at launch", async () => {
		machineRoutes();
		plaidPosture();
		const item = await addItem("W1124.3 local-coder dry-run fixture");
		try {
			const result = await dispatchA(
				{
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
					SUSPENDERS_PLAID_LAUNCH_GAP_MS: "5000",
				},
				"--route",
				"local-coder",
				"--item",
				item,
				"--dry-run",
			);
			expect(result.out).toContain("DRY selected route local-coder");
			expect(result.out).toContain("live health/capacity checked at launch");
		} finally {
			rmSync(join(REPO, ".fleet", "posture"));
		}
	}, 90_000);

	test("installed face: served local-coder is pool-admitted as its own provider", async () => {
		machineRoutes();
		plaidPosture();
		await addItem("W1124.3 local-coder dispatch fixture");
		const front = modelFront(["local-coder"]);
		try {
			const result = await dispatchA({
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
				SUSPENDERS_BUCKLE_FRONT: front.url,
				SUSPENDERS_PLAID_LAUNCH_GAP_MS: "5000",
			});
			// the pool pick rides the local route — no committed default and
			// no copilot/zai route ever prints (no fake attribution)
			expect(result.out).toContain("→ local-coder");
			expect(result.out).not.toContain("ikea-sonnet");
		} finally {
			front.stop();
			rmSync(join(REPO, ".fleet", "posture"));
		}
	}, 90_000);

	test("installed face: unserved pin walls the launch (MUST, fail-closed)", async () => {
		machineRoutes();
		plaidPosture();
		const item = await addItem("W1124.3 local-coder unserved fixture");
		const front = modelFront([]); // reachable front, zero models
		try {
			const result = await dispatchA(
				{
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
					SUSPENDERS_BUCKLE_FRONT: front.url,
					SUSPENDERS_PLAID_LAUNCH_GAP_MS: "5000",
				},
				"--route",
				"local-coder",
				"--item",
				item,
			);
			expect(result.out).toContain("not served");
		} finally {
			front.stop();
			rmSync(join(REPO, ".fleet", "posture"));
		}
	}, 90_000);

	test("installed face: unreachable front holds every plaid launch (fail-closed)", async () => {
		machineRoutes();
		plaidPosture();
		const item = await addItem("W1124.3 local-coder dead-front fixture");
		try {
			// the harness's pinned dead front (127.0.0.1:1) — the probe gets
			// no evidence, so the catalog is UNAVAILABLE, never empty
			const result = await dispatchA(
				{
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
					SUSPENDERS_PLAID_LAUNCH_GAP_MS: "5000",
				},
				"--route",
				"local-coder",
				"--item",
				item,
			);
			expect(result.out).toContain("catalog unavailable");
		} finally {
			rmSync(join(REPO, ".fleet", "posture"));
		}
	}, 90_000);
});
