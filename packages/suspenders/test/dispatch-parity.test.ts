// test/dispatch-parity.test.ts — W1255.2: the dispatch byte-parity machinery
// (scripts/lib/dispatch-parity.ts + this file's original suite) is RETIRED.
// scripts/lib's lane kit moved into hooks/lib, so the two trees are no
// longer parallel installs — byte-parity is meaningless. This file now
// carries the successor contract the move must preserve: the moved lane kit
// is SELF-CONTAINED in hooks/lib (no scripts/ imports inside the kit, no
// copies left in scripts/lib, consumers re-pointed, no cross-tree probing
// in the enrollment path) — enforced structurally so the old layout cannot
// quietly regrow.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const HOOKS_LIB = join(import.meta.dir, "..", "hooks", "lib");
const SCRIPTS = join(import.meta.dir, "..", "scripts");
const SCRIPTS_LIB = join(SCRIPTS, "lib");
// the kit W1255.2 moved (the named four + the closure pair lane.ts imports);
// W1276 carries each file's seam subdir
const KIT = [
	{ n: "lane.ts", seam: "lanes" },
	{ n: "lane-auth.ts", seam: "lanes" },
	{ n: "launch-parent.ts", seam: "lanes" },
	{ n: "lane-retry-budget.ts", seam: "lanes" },
	{ n: "jobslab.ts", seam: "lanes" },
	{ n: "front-probe.ts", seam: "board" },
];

const tsFilesUnder = (dir: string): string[] => {
	try {
		return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory()
				? tsFilesUnder(join(dir, e.name))
				: e.name.endsWith(".ts")
					? [join(dir, e.name)]
					: [],
		);
	} catch {
		return [];
	}
};

const IMPORTS_SCRIPTS =
	/(?:from\s+|import\(\s*)["'][^"']*(?:^|\/)scripts\/[^"']*["']/;

test("the moved lane kit is self-contained — no scripts/ imports inside it", () => {
	const missing = KIT.filter((f) => !existsSync(join(HOOKS_LIB, f.seam, f.n)));
	expect(missing).toEqual([]);
	const offenders = KIT.map((f) => join(HOOKS_LIB, f.seam, f.n))
		.map((p) => [p, readFileSync(p, "utf8")] as const)
		.filter(([, src]) => IMPORTS_SCRIPTS.test(src));
	expect(offenders).toEqual([]);
});

test("the shared lane kit lives only in hooks/lib — no scripts/lib copies remain", () => {
	expect(KIT).toHaveLength(6);
	const remaining = KIT.filter((f) => existsSync(join(SCRIPTS_LIB, f.n)));
	expect(remaining).toEqual([]);
});

test("scripts/ consumers reach the lane kit through hooks/lib, not local copies", () => {
	const localKitImports = tsFilesUnder(SCRIPTS).filter((p) => {
		const src = readFileSync(p, "utf8");
		return (
			/from\s+["']\.{1,2}\/lane(?:-auth|-retry-budget)?\.ts["']/.test(src) ||
			/from\s+["']\.\.\/lib\/lane(?:-auth|-retry-budget)?\.ts["']/.test(src) ||
			/from\s+["']\.{1,2}\/(launch-parent|jobslab|front-probe)\.ts["']/.test(
				src,
			)
		);
	});
	expect(Array.isArray(localKitImports)).toBe(true);
	expect(localKitImports).toEqual([]);
});

test("enrollment resolves the shared modules in-tree, no cross-tree layout probing", () => {
	const src = readFileSync(join(HOOKS_LIB, "hook-scripts.ts"), "utf8");
	expect(src).not.toContain("scriptsLibPath");
	expect(src).not.toContain(`"scripts"`);
	expect(src).toContain(`await import("./lanes/lane-auth.ts")`);
});
