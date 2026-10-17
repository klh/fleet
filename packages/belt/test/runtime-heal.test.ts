// W790 — runtime-heal: the belt installer's flat copy leaves
// checkout-relative imports in the runtime home; the healer copies the dep
// closure, rewrites what maps to existing runtime modules, and the probe
// fails the install loudly on anything left unresolvable.
import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDeps, healImports, probeClosure } from "../bin/runtime-heal.ts";

function mkprefix(): string {
	return mkdtempSync(join(tmpdir(), "runtime-heal-"));
}

test("healImports rewrites mapped cross-package imports to runtime-local", () => {
	const prefix = mkprefix();
	try {
		writeFileSync(
			join(prefix, "hubs.ts"),
			`import { x } from "../../suspenders/deploy/hub-remote.ts";\nimport { y } from "../../buckle/src/gov/keys.ts";\nexport const h = x + y;\n`,
		);
		writeFileSync(join(prefix, "hub-remote.ts"), "export const x = 1;\n");
		mkdirSync(join(prefix, "gov"), { recursive: true });
		writeFileSync(join(prefix, "gov", "keys.ts"), "export const y = 2;\n");
		const done = healImports(prefix);
		const out = readText(join(prefix, "hubs.ts"));
		expect(out).toContain('from "./hub-remote.ts"');
		expect(out).toContain('from "./gov/keys.ts"');
		expect(done.some((d) => d.startsWith("hubs.ts:"))).toBe(true);
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
});

test("healImports leaves specs whose target is absent in the runtime home", () => {
	const prefix = mkprefix();
	try {
		const src = `import { z } from "../../nope/deep/file.ts";\nexport const a = z;\n`;
		writeFileSync(join(prefix, "model-store.ts"), src);
		expect(healImports(prefix)).toEqual([]);
		expect(readText(join(prefix, "model-store.ts"))).toBe(src);
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
});

test("copyDeps copies missing deps and never clobbers existing files", () => {
	const root = mkprefix();
	const prefix = mkprefix();
	try {
		const depDir = join(root, "packages", "suspenders", "deploy");
		mkdirSync(depDir, { recursive: true });
		writeFileSync(join(depDir, "hub-remote.ts"), "export const h = 1;\n");
		writeFileSync(join(prefix, "hub-remote.ts"), "original\n");
		expect(copyDeps(root, prefix)).toEqual([]);
		expect(readText(join(prefix, "hub-remote.ts"))).toBe("original\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(prefix, { recursive: true, force: true });
	}
});

test("probeClosure walks clean closures and flags missing/unhealed modules", () => {
	const prefix = mkprefix();
	try {
		writeFileSync(
			join(prefix, "a.ts"),
			`import { b } from "./b.ts";\nexport const a = b;\n`,
		);
		writeFileSync(join(prefix, "b.ts"), "export const b = 1;\n");
		expect(probeClosure(prefix, ["a.ts"])).toEqual([]);

		writeFileSync(
			join(prefix, "broken.ts"),
			`import { g } from "./ghost.ts";\nexport const br = g;\n`,
		);
		const errs = probeClosure(prefix, ["broken.ts"]);
		expect(errs.some((e) => e.includes("ghost.ts"))).toBe(true);

		writeFileSync(
			join(prefix, "checkout.ts"),
			`import { q } from "../../suspenders/deploy/hub-remote.ts";\nexport const c = q;\n`,
		);
		const errs2 = probeClosure(prefix, ["checkout.ts"]);
		expect(errs2.some((e) => e.includes("unhealed checkout import"))).toBe(
			true,
		);
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
});

function readText(p: string): string {
	return readFileSync(p, "utf8");
}
