// tests/helpers/check-deps-fixture.ts — W1303.1.7: the synthetic-fleet
// builder for tests/check-deps.e2e.ts. Lives in a helper MODULE (the
// buckle sweep-G corpus pattern — ./mock.ts, ./deps.ts) because a spec
// file with module- or describe-scoped declarations breaks the
// playwright transform here ("Parser skipped input between top-level
// statements", 3–5 opaque AggregateError build errors per declaration);
// specs keep only imports + test registrations.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Repo root (this module lives at tests/helpers/) — for CLI-parity runs. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** File writer rooted at the fixture tree. */
export type FixtureWriter = (rel: string, body: string) => void;

/** Minimal synthetic fleet: one clean package + caller-added defect rows.
 *  OS tmpdir — outside any checkout, so git never resolves upward into a
 *  worktree (the git-fixture-inside-worktree trap). */
export const makeFleetFixture = (
	build: (w: FixtureWriter) => void,
): string => {
	const root = mkdtempSync(join(tmpdir(), "check-deps-"));
	const w: FixtureWriter = (rel, body) => {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, body);
	};
	w("packages/belt/package.json", JSON.stringify({ name: "@klh/belt" }));
	w("packages/belt/src/ok.ts", `import { join } from "node:path";\n`);
	build(w);
	return root;
};

/** rmSync wrapper so the spec reads as fixture teardown, not fs plumbing. */
export const dropFixture = (root: string): void =>
	rmSync(root, { recursive: true, force: true });
