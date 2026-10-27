// test/dispatch-refill-plaid.test.ts — W1145: live plaid dispatch binds the
// machine plaid_routes (suspenders-board.json) instead of the committed
// defaults, and an item-local deferral (unbanked worktree residue) no longer
// stops the whole plaid refill: the next independent READY item still rides.
import { expect, test } from "@playwright/test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { HOME, REPO, toolA, dispatchA, addItem } = dispatchHarness(test.afterAll, {
	tag: "w1145-refill",
	beltEnv: true,
});

// scratch `claude` on PATH — plaidHealth bin-probes the route executor
const binDir = join(HOME, "bin");
mkdirSync(binDir, { recursive: true });
const stubClaude = join(binDir, "claude");
writeFileSync(stubClaude, "#!/bin/sh\nexit 0\n");
chmodSync(stubClaude, 0o700);

const machineRoutes = (): void => {
	// the live operator shape: GLM is the only configured route
	mkdirSync(join(HOME, ".claude", "local-llm"), { recursive: true });
	writeFileSync(
		join(HOME, ".claude", "local-llm", "suspenders-board.json"),
		JSON.stringify({
			plaid_routes: [
				{
					name: "glm-5.3-flash",
					label: "GLM 5.3 Flash",
					executor: "claude",
					model: "glm-5.3-flash",
					provider: "zai",
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

const residueItem = async (title: string): Promise<string> => {
	const id = await addItem(title);
	// the live W1124.8.2.2 shape: a READY item whose leftover tree is dirty —
	// unclaimed, so dispatch meets it fresh and the W349 guard must defer it
	// item-locally (never spawn into unbanked state, never discard the work)
	Bun.spawnSync(
		[
			"git",
			"-C",
			REPO,
			"worktree",
			"add",
			join(".worktrees", id),
			"-b",
			`suspenders/${id}`,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	writeFileSync(join(REPO, ".worktrees", id, "residue.txt"), "x");
	return id;
};

test.describe("W1145 plaid refill: machine routes + item-local deferrals", () => {
	test("machine plaid_routes ride; a residue deferral lets the next READY item launch", async () => {
		machineRoutes();
		plaidPosture();
		const a = await residueItem("W1145 residue deferral fixture");
		const b = await addItem("W1145 clean dispatch fixture");
		try {
			const result = await dispatchA(
				{
					PATH: `${binDir}:${process.env.PATH ?? ""}`,
					SUSPENDERS_PLAID_LAUNCH_GAP_MS: "5000",
				},
				"--no-belt",
			);
			// bug 1: the machine table feeds dispatch — GLM rides, the
			// quota-walled committed default never does
			expect(result.out).toContain("→ glm-5.3-flash");
			expect(result.out).not.toContain("ikea-sonnet");
			// bug 2: A's unbanked residue defers A alone; B still launches
			expect(result.out).toContain("unbanked residue");
			expect(result.out).toContain("launch failed"); // B attempted (stub exits)
			expect(result.out).toContain(`STARTER ${b}`); // B was next up
			// ...and the deferral came BEFORE B's attempt: refill continued
			expect(result.out.indexOf("unbanked residue")).toBeLessThan(
				result.out.indexOf(`STARTER ${b}`),
			);
			// the W349 guard stands: residue untouched, claim released
			expect(existsSync(join(REPO, ".worktrees", a, "residue.txt"))).toBe(true);
			const state = JSON.parse(
				(await toolA({}, "work.ts", "show", a, "--json")).out,
			).state;
			expect(state).toBe("READY");
		} finally {
			rmSync(join(REPO, ".fleet", "posture"));
		}
	}, 90_000);
});
