// test/install-activate-gateway.e2e.ts — W2546 executed default-plan
// regression (#101713): the ordinary install carries the authorized
// generation-only gateway activation itself. Proves through the REAL
// runner + contract (children spawned, no mocks): (1) activateGateway is
// in the default plan and inert under --dry-run; (2) explicit --step
// syncHarness stays publication-only; (3) an EXECUTED activateGateway on
// a fresh-host fixture (isolated HOME/PREFIX, no harness receipt) is the
// truthful skip — never an error, never a ledger write; (4) the step
// never touches the global post-merge sync stamp (gateway-only step must
// not overwrite the multi-service ledger).
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchWorld } from "@klh/test-kit";

const BIN = `${import.meta.dir}/../scripts/install.ts`;

// Kit lifecycle (root #102613/#102620): trailing world.clean() leaks the
// fixture dirs when an assertion fails mid-test — the shared afterEach
// always runs, an assertion failure still cleans.
const worlds: ReturnType<typeof scratchWorld>[] = [];
test.afterEach(() => {
	while (worlds.length > 0) worlds.pop()?.clean();
});
const worldFixture = (prefix: string): ReturnType<typeof scratchWorld> => {
	const world = scratchWorld({ prefix: `${prefix}-` });
	worlds.push(world);
	return world;
};

/** test-kit CLI run: the child inherits this process's env plus the
 * fixture's isolated HOME/PREFIX (W1135.1.3 — no hand-rolled spawn). */
function run(
	args: string[],
	env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
	const r = runCli(BIN, args, { env });
	return { code: r.code, stdout: r.out, stderr: r.err };
}

test("default plan carries activateGateway; dry-run stays inert", async () => {
	const { code, stdout } = await run(["--json", "--dry-run"], {});
	expect(code).toBe(0);
	const doc = JSON.parse(stdout);
	const row = doc.steps.find(
		(s: { name: string }) => s.name === "activateGateway",
	);
	expect(row).toBeDefined();
	expect(row.status).toBe("planned"); // mutating step, zero side effects
	// the explicit opt-in staging step stays OUT of the default plan
	const upgrade = doc.steps.find(
		(s: { name: string }) => s.name === "upgradeGateway",
	);
	expect(upgrade.status).toBe("skipped");
});

test("explicit --step syncHarness remains publication-only", async () => {
	const { code, stdout } = await run(
		["--json", "--dry-run", "--step", "syncHarness"],
		{},
	);
	expect(code).toBe(0);
	const doc = JSON.parse(stdout);
	expect(doc.steps).toHaveLength(1);
	expect(doc.steps[0].name).toBe("syncHarness");
	expect(doc.steps[0].status).toBe("planned");
});

test("executed activateGateway on a fresh host is the truthful skip", async () => {
	const world = worldFixture("w2546-fresh");
	const prefix = join(world.home, "prefix");
	const statePath = join(world.home, "state", "post-merge-sync.json");
	const { code, stdout } = run(
		["--json", "--step", "activateGateway", "--yes"],
		{ HOME: world.home, SUSPENDERS_PREFIX: prefix },
	);
	expect(code).toBe(0);
	const doc = JSON.parse(stdout);
	expect(doc.steps).toHaveLength(1);
	expect(doc.steps[0].name).toBe("activateGateway");
	expect(doc.steps[0].status).toBe("skipped");
	expect(doc.steps[0].note).toContain("fresh host");
	// the global multi-service sync ledger is untouched by the gateway step
	expect(() => readFileSync(statePath)).toThrow();
});

test("executed dry-run activateGateway never stages", async () => {
	const world = worldFixture("w2546-dry");
	const prefix = join(world.home, "prefix");
	mkdirSync(prefix, { recursive: true });
	// a published receipt at the prefix: dry-run must STILL do nothing
	writeFileSync(
		join(prefix, "harness-receipt.json"),
		JSON.stringify({
			schema: "fleet.harness.v1",
			revision: "a".repeat(40),
			payloadSha256: "b".repeat(64),
		}),
	);
	const { code, stdout } = run(
		["--json", "--step", "activateGateway", "--yes", "--dry-run"],
		{ HOME: world.home, SUSPENDERS_PREFIX: prefix },
	);
	expect(code).toBe(0);
	const doc = JSON.parse(stdout);
	expect(doc.steps[0].status).toBe("planned");
});
