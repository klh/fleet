// test/install-preflight.test.ts — W1195.1: the installer's mutation
// preflight fires BEFORE syncHarness or any persistent mutation when
// --with-launchd rides the plan. Regression (2026-10-23): install
// --with-launchd from a linked item worktree published unreviewed worktree
// code into the live harness prefix and only then refused at registerLaunchd
// (W631 stable-worktree authority guard). Contract: an invalid linked
// worktree leaves the original prefix, settings and services byte-identical;
// a valid plan still runs its normal steps.
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan, type StepContext } from "../scripts/install-run.ts";
import { registerLaunchdPreflight } from "../scripts/install-preflight.ts";

const roots: string[] = [];

// seedSource — a checkout-shaped tree: .git DIR = pinned checkout, .git FILE
// = linked worktree (the W427 marker resolveStableRepo keys on).
function seedSource(root: string, shape: "pinned" | "worktree"): string {
	const source = join(root, "source");
	mkdirSync(join(source, ".git"), { recursive: true });
	if (shape === "worktree") {
		rmSync(join(source, ".git"), { recursive: true });
		writeFileSync(join(source, ".git"), "gitdir: /somewhere/else\n");
	}
	mkdirSync(join(source, "packages/suspenders"), { recursive: true });
	return join(source, "packages/suspenders");
}

// seedHome — the user-level surfaces: settings.json, the LaunchAgents
// services dir, and a VALID belt.env (0600 + BELT_WIRED_GUARD_GB) so the
// worktree case isolates the authority finding.
function seedHome(root: string): string {
	const home = join(root, "home");
	mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
	writeFileSync(join(home, ".claude/settings.json"), '{\n\t"hooks": {}\n}\n', {
		mode: 0o600,
	});
	writeFileSync(
		join(home, ".claude/local-llm/belt.env"),
		"BELT_WIRED_GUARD_GB=1\n",
		{ mode: 0o600 },
	);
	mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
	writeFileSync(
		join(home, "Library/LaunchAgents/com.suspenders.buckle-spoke.plist"),
		'<?xml version="1.0" encoding="UTF-8"?>\n<plist></plist>\n',
	);
	return home;
}

// seedPrefix — the live harness prefix as the incident found it: a plain
// directory holding operator bytes, never a symlink.
function seedPrefix(root: string): string {
	const prefix = join(root, "state/harness");
	mkdirSync(prefix, { recursive: true });
	writeFileSync(join(prefix, "operator.env"), "private-preserved\n", {
		mode: 0o600,
	});
	writeFileSync(join(prefix, "old-code.ts"), "export const old = true;\n");
	return prefix;
}

// buildFixture — compose the source checkout shape and the seeded surfaces.
function buildFixture(shape: "pinned" | "worktree") {
	const root = mkdtempSync(join(tmpdir(), "fleet-install-preflight-"));
	roots.push(root);
	return {
		root,
		repo: seedSource(root, shape),
		home: seedHome(root),
		prefix: seedPrefix(root),
	};
}

// planCtx — the StepContext a --with-launchd plan run carries (fixture paths
// throughout; yes=false keeps every mutating step at its consent pause).
function planCtx(
	f: ReturnType<typeof buildFixture>,
	overrides: Partial<StepContext> = {},
): StepContext {
	return {
		repo: f.repo,
		prefix: f.prefix,
		shimBin: join(f.root, "shims"),
		llmHome: join(f.root, "models"),
		home: f.home,
		dryRun: false,
		yes: false,
		json: true,
		verbose: false,
		withLaunchd: true,
		...overrides,
	};
}

// seededBytes — the persisted bytes of every surface the incident mutated.
function seededBytes(f: ReturnType<typeof buildFixture>) {
	return {
		prefixOperator: readFileSync(join(f.prefix, "operator.env"), "utf8"),
		prefixOldCode: readFileSync(join(f.prefix, "old-code.ts"), "utf8"),
		settings: readFileSync(join(f.home, ".claude/settings.json"), "utf8"),
		plist: readFileSync(
			join(f.home, "Library/LaunchAgents/com.suspenders.buckle-spoke.plist"),
			"utf8",
		),
	};
}

// assertUntouched — the regression contract: the prefix is still the ORIGINAL
// directory (never a generation symlink), every seeded byte survives, and no
// stage/generation/backup residue leaked beside the prefix.
function assertUntouched(
	f: ReturnType<typeof buildFixture>,
	before: Record<string, string>,
): void {
	expect(statSync(f.prefix).isDirectory()).toBe(true);
	expect(readFileSync(join(f.prefix, "operator.env"), "utf8")).toBe(
		before.prefixOperator,
	);
	expect(readFileSync(join(f.prefix, "old-code.ts"), "utf8")).toBe(
		before.prefixOldCode,
	);
	expect(readFileSync(join(f.home, ".claude/settings.json"), "utf8")).toBe(
		before.settings,
	);
	expect(readdirSync(join(f.root, "state"))).toEqual(["harness"]);
}

describe("registerLaunchdPreflight", () => {
	test("predicts the W631 stable-worktree refusal for a linked worktree", () => {
		const f = buildFixture("worktree");
		const findings = registerLaunchdPreflight(planCtx(f));
		expect(findings).toHaveLength(1);
		expect(findings[0]?.step).toBe("registerLaunchd");
		expect(findings[0]?.refusal).toContain("linked git worktree");
	});

	test("finds nothing for a pinned checkout with a valid belt.env", () => {
		const f = buildFixture("pinned");
		expect(registerLaunchdPreflight(planCtx(f))).toEqual([]);
	});

	test("predicts the belt-wired-guard refusal when belt.env is invalid", () => {
		const f = buildFixture("pinned");
		writeFileSync(
			join(f.home, ".claude/local-llm/belt.env"),
			"BELT_WIRED_GUARD_GB=not-a-number\n",
		);
		const findings = registerLaunchdPreflight(planCtx(f));
		expect(findings).toHaveLength(1);
		expect(findings[0]?.refusal).toContain("BELT_WIRED_GUARD_GB");
	});
});

// The incident contract at plan level: the refused run executes NO step and
// leaves every persistent surface byte-identical.
describe("executePlan --with-launchd mutation preflight", () => {
	test("refused worktree plan mutates nothing (the 2026-10-23 incident)", async () => {
		const f = buildFixture("worktree");
		const before = seededBytes(f);
		const result = await executePlan(
			"plan",
			null,
			planCtx(f, { yes: true }),
			() => {},
		);
		expect(result.outcome).toBe("failed");
		expect(result.pauses).toEqual([]);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.name).toBe("registerLaunchd");
		expect(result.rows[0]?.status).toBe("failed");
		expect(result.rows[0]?.note).toContain("mutation preflight");
		expect(result.rows[0]?.note).toContain("linked git worktree");
		assertUntouched(f, before);
	});

	test("dry-run previews the same refusal with zero side effects", async () => {
		const f = buildFixture("worktree");
		const before = seededBytes(f);
		const result = await executePlan(
			"plan",
			null,
			planCtx(f, { dryRun: true, yes: true }),
			() => {},
		);
		expect(result.outcome).toBe("failed");
		expect(result.rows.map((row) => row.name)).toEqual(["registerLaunchd"]);
		assertUntouched(f, before);
	});

	test("valid pinned plan still runs its normal steps", async () => {
		const f = buildFixture("pinned");
		const before = seededBytes(f);
		const result = await executePlan("plan", null, planCtx(f), () => {});
		// no consent → every mutating step pauses, none fails: the preflight
		// is transparent for a valid plan
		expect(result.outcome).toBe("need_user_action");
		expect(result.rows.some((row) => row.status === "failed")).toBe(false);
		expect(result.pauses.length).toBeGreaterThan(0);
		assertUntouched(f, before);
	});
});
