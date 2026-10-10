// W422.16 drift guard: one canonical doc per package.
// AGENTS.md holds the truth (lane protocol + package law); CLAUDE.md must be
// the one-line @AGENTS.md stub. Real content in a CLAUDE.md, a CLAUDE.md
// without an AGENTS.md sibling, or a stub pointing at a stub = drift = fail.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const STUB = "@AGENTS.md";

test("root: AGENTS.md is the canonical law, CLAUDE.md is the stub", () => {
	const law = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
	expect(law.length).toBeGreaterThan(200); // a stub must never point at a stub
	expect(readFileSync(join(ROOT, "CLAUDE.md"), "utf8").trim()).toBe(STUB);
});

test("every package: CLAUDE.md is the @AGENTS.md stub and AGENTS.md carries the truth", () => {
	for (const pkg of readdirSync(join(ROOT, "packages")).sort()) {
		const cl = join(ROOT, "packages", pkg, "CLAUDE.md");
		if (!existsSync(cl)) continue; // docs-less packages (local-llm) are fine
		const ag = join(ROOT, "packages", pkg, "AGENTS.md");
		expect(
			existsSync(ag),
			`${pkg}: CLAUDE.md without an AGENTS.md sibling`,
		).toBe(true);
		const law = readFileSync(ag, "utf8");
		expect(
			law.length,
			`${pkg}: AGENTS.md must carry content, not point at a stub`,
		).toBeGreaterThan(200);
		expect(
			readFileSync(cl, "utf8").trim(),
			`${pkg}: CLAUDE.md must be the stub`,
		).toBe(STUB);
	}
});
