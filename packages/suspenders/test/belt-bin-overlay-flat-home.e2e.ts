// test/belt-bin-overlay-flat-home.test.ts — W778: the flat-home refresh must
// treat real cross-package kit code as REAL (not a re-export shim) and flatten
// its externals: hub-remote/stack-config ride along as sibling basenames,
// specifiers rewritten `../x` → `./x`, bun build proves resolution.
import { expect, test } from "./pw";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	flatExternals,
	isPureReexportShim,
	refreshFlatHome,
	verifyFlatHome,
} from "../scripts/belt-bin-overlay.ts";

const dir = join(tmpdir(), `w778-flat-home-${Date.now().toString(36)}`);

// A belt/bin-like kit: entry → real member with cross-package imports, a
// pure re-export shim, and node-only externals.
const root = join(dir, "bin");
function fixture(): void {
	// externals live OUTSIDE the kit root — ../lib and ../out from bin/
	mkdirSync(root, { recursive: true });
	mkdirSync(join(dir, "lib"), { recursive: true });
	mkdirSync(join(dir, "out", "real"), { recursive: true });
	writeFileSync(
		join(root, "entry.ts"),
		[
			'import { hub } from "./hub.ts";',
			'import { inside } from "./inside.ts";',
			'import { real } from "./shim.ts";',
			'import { cfg } from "../lib/x.ts";',
			'const operatorConfig = "./routing-policy.yaml";',
			"console.log(hub(), inside, real, cfg());",
		].join("\n"),
	);
	writeFileSync(join(root, "routing-policy.yaml"), "operator: owned\n");
	writeFileSync(join(root, "inside.ts"), 'export const inside = "inside";\n');
	writeFileSync(
		join(root, "external-only.ts"),
		'export const externalOnly = "external";\n',
	);
	writeFileSync(
		join(root, "hub.ts"),
		[
			"// real member (the W778 regression: NOT a shim)",
			'import type { T } from "../lib/types.ts";',
			'import { cfg } from "../lib/x.ts";',
			"export function hub(t?: T): string {",
			'\treturn "hub:" + cfg();',
			"}",
		].join("\n"),
	);
	writeFileSync(
		join(dir, "lib", "x.ts"),
		'import { inside } from "../bin/inside.ts";\nimport { externalOnly } from "../bin/external-only.ts";\nexport const cfg = () => inside + externalOnly;\n',
	);
	writeFileSync(
		join(dir, "lib", "types.ts"),
		"export interface T { a: number }\n",
	);
	writeFileSync(
		join(root, "shim.ts"),
		'export { real } from "../out/real/real.ts";\n',
	);
	writeFileSync(
		join(dir, "out", "real", "real.ts"),
		'export const real = (): string => "real";\n',
	);
}

test.describe("W778 flat externals", () => {
	test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("real cross-package code is not classified as a shim", () => {
		expect(
			isPureReexportShim(
				[
					'import { composeUpArgv } from "../../suspenders/deploy/hub-remote.ts";',
					"export function hubTargets(): string[] {",
					'\treturn ["a"];',
					"}",
				].join("\n"),
			),
		).toBe(false);
		expect(
			isPureReexportShim('export { real } from "../out/real/real.ts";\n'),
		).toBe(true);
	});

	test("flatExternals maps cross-package deps by basename", async () => {
		fixture();
		const ext = await flatExternals(join(root, "entry.ts"));
		expect(ext.size).toBe(3); // x.ts, types.ts, out/real/real.ts
		expect(ext.get(join(dir, "lib", "x.ts"))).toBe("x.ts");
	});

	test("flatExternals fails closed on a basename collision", async () => {
		const c = join(dir, "collision");
		mkdirSync(join(c, "bin"), { recursive: true });
		mkdirSync(join(c, "o1"), { recursive: true });
		mkdirSync(join(c, "o2"), { recursive: true });
		writeFileSync(
			join(c, "bin", "e.ts"),
			'import "../o1/x.ts";\nimport "../o2/x.ts";\n',
		);
		writeFileSync(join(c, "o1", "x.ts"), "export const a = 1;\n");
		writeFileSync(join(c, "o2", "x.ts"), "export const b = 2;\n");
		await expect(flatExternals(join(c, "bin", "e.ts"))).rejects.toThrow(
			"collision",
		);
	});

	test("refreshFlatHome heals members+externals and bun build resolves", async () => {
		fixture();
		const runtime = join(dir, "home");
		mkdirSync(runtime, { recursive: true });
		// stale home: the pre-W778 wreck (dependency content over a real member)
		writeFileSync(join(runtime, "hub.ts"), "export const junk = 1;\n");
		writeFileSync(join(runtime, "entry.ts"), "export const junk = 2;\n");
		const rep = await refreshFlatHome(runtime, join(root, "entry.ts"));
		expect(rep.healed.length).toBeGreaterThanOrEqual(5);
		const hub = readFileSync(join(runtime, "hub.ts"), "utf8");
		expect(hub).toContain("export function hub");
		expect(hub).toContain('from "./x.ts"');
		expect(hub).toContain('from "./types.ts"');
		expect(readFileSync(join(runtime, "x.ts"), "utf8")).toContain("cfg");
		expect(readFileSync(join(runtime, "x.ts"), "utf8")).toContain(
			'from "./inside.ts"',
		);
		expect(readFileSync(join(runtime, "x.ts"), "utf8")).toContain(
			'from "./external-only.ts"',
		);
		expect(readFileSync(join(runtime, "external-only.ts"), "utf8")).toContain(
			"externalOnly",
		);
		expect(rep.healed).not.toContain("routing-policy.yaml");
		expect(readFileSync(join(runtime, "types.ts"), "utf8")).toContain("T");
		expect(readFileSync(join(runtime, "real.ts"), "utf8")).toContain("real");
		await verifyFlatHome(runtime, "entry.ts");
		// idempotent: a second run heals nothing
		const rep2 = await refreshFlatHome(runtime, join(root, "entry.ts"));
		expect(rep2.healed.length).toBe(0);
	});
});
