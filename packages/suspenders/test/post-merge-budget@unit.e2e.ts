// test/post-merge-budget@unit.e2e.ts — W2574 N2-budget-nan: the
// --budget-ms CLI contract. Number("abc") → NaN made every poll's
// `now() + interval > deadline(NaN)` compare false, so a persistent
// transport-failure (status 0) poll spun forever instead of exhausting
// truthfully. parseBudgetMs refuses junk/NaN/±Infinity/0/negative values
// at the CLI boundary — BEFORE any poll seam can run — while the absent
// flag and any finite positive value keep the normal default path (the
// bounded startup polling itself is pinned by post-merge-activation.e2e.ts
// N1: 31-iteration budget exhaustion under the deterministic clock).
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { runCli, scratchWorld } from "@klh/test-kit";
import {
	DEFAULT_READINESS_BUDGET_MS,
	parseBudgetMs,
} from "../scripts/lib/activation-readiness.ts";

const BIN = `${import.meta.dir}/../scripts/post-merge-sync.ts`;

// Kit lifecycle (root #102613/#102620): the shared afterEach always runs —
// an assertion failure mid-test still cleans the fixture dirs.
const worlds: ReturnType<typeof scratchWorld>[] = [];
test.afterEach(() => {
	while (worlds.length > 0) worlds.pop()?.clean();
});
const worldFixture = (): ReturnType<typeof scratchWorld> => {
	const world = scratchWorld({ prefix: "w2574-budget-" });
	worlds.push(world);
	return world;
};

/** Run the CLI hermetically: --repo/--state/--log all inside the scratch
 * world, so no spawn touches the machine stamp or log. */
const sync = (
	world: ReturnType<typeof scratchWorld>,
	...args: string[]
): { code: number; out: string; err: string } => {
	const r = runCli(BIN, args, {
		cwd: world.repo,
		env: { HOME: world.home },
	});
	return { code: r.code, out: r.out, err: r.err };
};

test.describe("@unit W2574 parseBudgetMs", () => {
	for (const raw of ["abc", "", " ", "NaN", "Infinity", "-Infinity"]) {
		test(`refuses non-finite junk (${raw === "" ? "empty" : raw})`, () => {
			expect(parseBudgetMs(raw)).toBeNull();
		});
	}
	for (const raw of ["0", "-1", "-30000", "0.0"]) {
		test(`refuses non-positive (${raw})`, () => {
			expect(parseBudgetMs(raw)).toBeNull();
		});
	}
	test("absent flag keeps the finite default", () => {
		expect(parseBudgetMs(undefined)).toBe(DEFAULT_READINESS_BUDGET_MS);
		expect(DEFAULT_READINESS_BUDGET_MS).toBe(30_000);
	});
	for (const [raw, want] of [
		["30000", 30_000],
		["1", 1],
		["45000.5", 45_000.5],
		["+25000", 25_000],
	] as const) {
		test(`accepts finite positive (${raw})`, () => {
			expect(parseBudgetMs(raw)).toBe(want);
		});
	}
});

test.describe("@unit W2574 post-merge-sync --budget-ms CLI gate", () => {
	for (const raw of ["abc", "NaN", "Infinity", "0", "-30000", ""]) {
		test(`invalid --budget-ms "${raw}" refuses exit 1 before any poll`, () => {
			const world = worldFixture();
			const r = sync(
				world,
				"--repo",
				world.repo,
				"--state",
				join(world.home, "state.json"),
				"--log",
				join(world.home, "log"),
				"--budget-ms",
				raw,
			);
			expect(r.code).toBe(1);
			expect(r.out).toContain("refused: --budget-ms");
		});
	}
	test("absent flag keeps the normal default path (--check decides, no refusal)", () => {
		const world = worldFixture();
		const r = sync(
			world,
			"--repo",
			world.repo,
			"--state",
			join(world.home, "state.json"),
			"--log",
			join(world.home, "log"),
			"--check",
		);
		// --check prints the decision JSON and spawns nothing — the point is
		// the absent flag runs the normal path, never a budget refusal
		expect(r.code).toBe(0);
		expect(r.out).not.toContain("refused");
		expect(
			JSON.parse(r.out.split("\n").filter(Boolean).at(-1) ?? "{}"),
		).toHaveProperty("decision");
	});
	test("finite positive --budget-ms takes the normal path", () => {
		const world = worldFixture();
		const r = sync(
			world,
			"--repo",
			world.repo,
			"--state",
			join(world.home, "state.json"),
			"--log",
			join(world.home, "log"),
			"--budget-ms",
			"30000",
			"--check",
		);
		expect(r.code).toBe(0);
		// --check prints the decision JSON — the budget reached the core
		expect(
			JSON.parse(r.out.split("\n").filter(Boolean).at(-1) ?? "{}"),
		).toHaveProperty("decision");
	});
});
