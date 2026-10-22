// tests/skills-catalog.test.ts — W1144: the skills-catalog law guard.
// (1) every catalog SKILL.md carries a trigger-style description and a
// Gotchas section (the audit contract — regression-proof after W1144);
// (2) the `review` skill names the fleet-documented review-trap classes and
// the seeded fixture documents the same trap classes. This is a documentation
// contract test, not an execution of an agent or evidence of review quality.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SKILLS = join(ROOT, "skills");

function skillText(name: string): string {
	return readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
}

describe("skills catalog", () => {
	test("every SKILL.md has a trigger-style description and Gotchas", () => {
		const dirs = readdirSync(SKILLS, { withFileTypes: true })
			.filter(
				(e) => e.isDirectory() && existsSync(join(SKILLS, e.name, "SKILL.md")),
			)
			.map((e) => e.name);
		expect(dirs.length).toBeGreaterThanOrEqual(12);
		for (const name of dirs) {
			const txt = skillText(name);
			const desc = txt.match(/^description:\s*(.*)$/m)?.[1] ?? "";
			expect(desc.trim(), `${name}: description present`).not.toBe("");
			expect(
				/use when|not for|fire before|read-only/i.test(desc),
				`${name}: trigger-style description`,
			).toBe(true);
			expect(/^##\s+Gotchas/im.test(txt), `${name}: Gotchas section`).toBe(
				true,
			);
		}
	});
});

describe("review-skill documentation contract", () => {
	const review = skillText("review");
	const seed = readFileSync(
		join(ROOT, "tests/fixtures/review-eval/seed.ts"),
		"utf8",
	);

	const traps: [string, RegExp, RegExp][] = [
		[
			"pipe-to-tail eats exit code",
			/pipe-to-tail|tail's exit/i,
			/bun test \| tail/,
		],
		[
			"bun:sqlite get() null vs undefined",
			/get\(\).*null|null vs undefined|!== undefined/i,
			/\.get\(\) !== undefined/,
		],
		[
			"empty-string env knob counts as set",
			/empty-string env|counts as set/i,
			/process\.env\.[A-Z_]+ \?\? "/,
		],
		["claim only with branch-baseline A/B", /A\/B|baseline/i, /baseline/i],
	];

	for (const [label, skillMarker, fixtureMarker] of traps) {
		test(`trap named in skill + planted in fixture: ${label}`, () => {
			expect(skillMarker.test(review), `review skill names: ${label}`).toBe(
				true,
			);
			expect(fixtureMarker.test(seed), `fixture plants: ${label}`).toBe(true);
		});
	}

	test("review skill mandates the machine-parseable verdict line", () => {
		expect(/VERDICT:\s*(PASS|FAIL)/.test(review)).toBe(true);
	});
});
