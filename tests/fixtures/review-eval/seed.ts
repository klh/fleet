// tests/fixtures/review-eval/seed.ts — W1144 review-skill eval fixture.
// Three fleet-documented trap classes, planted verbatim. The
// skills-catalog contract test proves the improved `review` skill names
// every class and that this fixture contains the corresponding examples.
// It does not run an agent or establish detection quality. Fixture code is
// intentionally wrong — never import it.
import { existsSync, readFileSync } from "node:fs";

export function trapPipeToTail(): boolean {
	// class 1: pipe-to-tail — the chain gates on tail's exit code, bun test
	// failures vanish
	const proc = Bun.spawnSync(["bash", "-c", "bun test | tail -5"]);
	return proc.exitCode === 0;
}

export function trapSqliteNullGuard(rows: unknown[]): unknown {
	// class 2: bun:sqlite .get() returns null — an `!== undefined` guard is
	// always true, so the "missing" row falls through
	for (const row of rows) {
		const hit = row as { get: () => unknown };
		if (hit.get() !== undefined) return hit;
	}
	return null;
}

export function trapEmptyEnvKnob(): string {
	// class 3: empty-string env knob counts as set — `?? ` passes on ""
	const model = process.env.ORACLE_ROUTE_MODEL ?? "reason-default";
	return model;
}

export function trapUnverifiedClaim(): string {
	// class 4: green claims ride a branch-baseline A/B — this comment
	// asserts a pass with no baseline run behind it (review-flag bait)
	// verified: all tests pass, no baseline A/B run
	return "green";
}

export function fixturePresent(): boolean {
	return existsSync(import.meta.path) && readFileSync(import.meta.path, "utf8").length > 0;
}
