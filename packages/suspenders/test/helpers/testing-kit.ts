// test/helpers/testing-kit.ts — W1294.1: the ONE playwright config builder
// behind the fleet's test framework unification (plan W1294). Every package
// playwright.config.ts imports defineFleetConfig and adds deltas only —
// projects, tags and the smoke dependency chain are declared HERE once, so
// the migration waves cannot fork the config shape. Fixtures re-export the
// existing kit faces (fixture-kit, cli-e2e-harness, board-fixture) so a spec
// imports one module for config + fixtures.
import {
	defineConfig,
	type PlaywrightTestConfig,
	type PlaywrightTestProject,
} from "@playwright/test";

export { cleanupDirs, gitInit, tmpDir } from "./fixture-kit.ts";
export { cliFixture, type CliResult } from "./cli-e2e-harness.ts";
export { boardFixture, unusedPort } from "./board-fixture.ts";

/** The fleet spec tags (test.agent.md delta contract 2). @smoke startup
 * proofs gate the rest via the smoke project's setup dependency. */
export const FLEET_TAGS = ["@smoke", "@unit", "@api", "@ui"] as const;
export type FleetTag = (typeof FLEET_TAGS)[number];

export interface FleetConfigOptions {
	/** Discovery root. Package configs pass `import.meta.dir` (the config
	 * file's own dir) — a relative/unset testDir discovers NOTHING when the
	 * runner is invoked from the repo root with --config (W1294.1 bisect:
	 * only absolute roots worked in this tree). */
	testDir?: string;
	/** Overrides the default spec glob(s). Defaults to the tagged *.e2e.ts
	 * corpus; deltas add dirs (e.g. the GUI *.spec.ts drives). */
	testMatch?: string | string[];
	/** Extra projects appended after the five standard ones. */
	extraProjects?: PlaywrightTestProject[];
	/** Per-test timeout in ms (default 120s — the sweep-H real-clock pace). */
	timeout?: number;
}

/** Hermetic env over a caller's process.env spread — pins ride LAST so a
 * lane's own SUSPENDERS_* or FORCE_COLOR leak cannot tint spawned fixtures
 * (sweep-A lesson: FORCE_COLOR=1 reflowed CLI output under the runner). */
export function hermeticEnv(
	env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	return { ...env, FORCE_COLOR: "0" };
}

/** The five standard projects. setup (the *.setup.ts slot) runs first;
 * smoke (@smoke startup proofs) depends on it; unit/api split the tagged
 * corpus; chromium hosts the @ui GUI drives. */
// Tag selection uses a REGEX per project, never an array — under
// bun+playwright 1.63.0 an array grep trips "TypeError: Attempted to assign
// to readonly property" during config normalization (W1294.1 bisect); the
// regex form is the proven green shape (W1315.2).
const FLEET_PROJECTS: PlaywrightTestProject[] = [
	{ name: "setup", testMatch: /.*\.setup\.ts/ },
	{
		name: "smoke",
		grep: /@smoke/,
		dependencies: ["setup"],
	},
	{ name: "unit", grep: /@unit/ },
	{ name: "api", grep: /@api/ },
	{
		name: "chromium",
		grep: /@ui/,
		use: { browserName: "chromium", headless: true },
	},
];

/** The ONE config shape. Package configs import this and pass deltas —
 * never re-declare projects/tags defaults (test.agent.md contract 3).
 * testMatch binds to every standard project except setup (which keeps its
 * *.setup.ts slot); the smoke dependency chain gates downstream runs. */
export function defineFleetConfig(
	opts: FleetConfigOptions = {},
): PlaywrightTestConfig {
	const testMatch = opts.testMatch ?? "**/*.e2e.ts";
	return defineConfig({
		testDir: opts.testDir ?? process.cwd(),
		testMatch,
		// node_modules / vendor / test-results stay out of discovery. Never
		// add a `.worktrees` pattern: a lane worktree IS the checkout (its
		// own testDir contains a `.worktrees` segment), so `**/.worktrees/**`
		// would match everything and zero the discovery (W1294.1 bisect).
		// Sibling lane trees never leak anyway: each config's testDir is
		// absolute and bounded to its own package/root dir.
		testIgnore: ["**/node_modules/**", "**/vendor/**", "**/test-results/**"],
		timeout: opts.timeout ?? 120_000,
		expect: { timeout: 5_000 },
		workers: 1,
		fullyParallel: false,
		retries: 0,
		reporter: [["list"]],
		outputDir: "test-results",
		projects: [
			...FLEET_PROJECTS.map((p) =>
				p.name === "setup" ? p : { ...p, testMatch },
			),
			...(opts.extraProjects ?? []),
		],
	});
}
