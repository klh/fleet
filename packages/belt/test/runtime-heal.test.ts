// W790 — runtime-heal: the belt installer's flat copy leaves
// checkout-relative imports in the runtime home; the healer copies the dep
// closure, rewrites what maps to existing runtime modules, and the probe
// fails the install loudly on anything left unresolvable.
import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
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
		writeFileSync(
			join(prefix, "escalate.ts"),
			'import { trace } from "../../telemetry/src/http-trace.ts";\n',
		);
		writeFileSync(join(prefix, "http-trace.ts"), "export const trace = 1;\n");
		mkdirSync(join(prefix, "gov"), { recursive: true });
		writeFileSync(join(prefix, "gov", "keys.ts"), "export const y = 2;\n");
		const done = healImports(prefix);
		const out = readText(join(prefix, "hubs.ts"));
		expect(out).toContain('from "./hub-remote.ts"');
		expect(out).toContain('from "./gov/keys.ts"');
		expect(readText(join(prefix, "escalate.ts"))).toContain(
			'from "./http-trace.ts"',
		);
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

test("healImports points the flat remotes copy at the bundled mDNS package", () => {
	const prefix = mkprefix();
	try {
		writeFileSync(
			join(prefix, "remotes.ts"),
			'import Bonjour from "bonjour-service";\nexport { Bonjour };\n',
		);
		writeFileSync(
			join(prefix, "bonjour-service.bundle.js"),
			"export default class Bonjour {}\n",
		);
		expect(healImports(prefix)).toContain(
			"remotes.ts: bonjour-service -> runtime bundle",
		);
		expect(readText(join(prefix, "remotes.ts"))).toContain(
			'from "./bonjour-service.bundle.js"',
		);
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
});

test("healImports never rewrites a wrapper to import itself", () => {
	const prefix = mkprefix();
	try {
		const src =
			'export { modelBudgetGb } from "../../local-llm/memory-policy.ts";\n';
		writeFileSync(join(prefix, "memory-policy.ts"), src);
		expect(healImports(prefix)).toEqual([]);
		expect(readText(join(prefix, "memory-policy.ts"))).toBe(src);
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
});

test("copyDeps refreshes stale release deps and leaves missing sources alone", () => {
	const root = mkprefix();
	const prefix = mkprefix();
	try {
		const depDir = join(root, "packages", "suspenders", "deploy");
		mkdirSync(depDir, { recursive: true });
		writeFileSync(join(depDir, "hub-remote.ts"), "export const h = 1;\n");
		writeFileSync(join(prefix, "hub-remote.ts"), "original\n");
		expect(copyDeps(root, prefix)).toEqual(["hub-remote.ts"]);
		expect(readText(join(prefix, "hub-remote.ts"))).toBe(
			"export const h = 1;\n",
		);
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

// W1471: model-store imports host-guard + servicemon from @klh/kernel; the
// flat home has no node_modules, so copy + heal must land the kernel faces
// flat, and the probe must fail any package spec left unhealed.
test("kernel package imports heal to flat copies; unhealed ones fail the probe", () => {
	const root = mkprefix();
	const prefix = mkprefix();
	const hg = "@klh/kernel/src/kernel.host-guard.module.ts";
	const sm = "@klh/kernel/src/kernel.servicemon.module.ts";
	try {
		const kernelDir = join(root, "packages", "kernel", "src");
		mkdirSync(kernelDir, { recursive: true });
		writeFileSync(
			join(kernelDir, "kernel.servicemon.module.ts"),
			"export {};\n",
		);
		const src = `import { a } from "${hg}";\nimport { b } from "${sm}";\n`;
		writeFileSync(join(prefix, "model-store.ts"), src);
		expect(probeClosure(prefix, ["model-store.ts"]).length).toBe(2);
		expect(copyDeps(root, prefix)).toEqual(["kernel.servicemon.module.ts"]);
		healImports(prefix);
		const out = readText(join(prefix, "model-store.ts"));
		expect(out).toContain('from "./kernel.servicemon.module.ts"');
		// no host-guard source shipped → its spec stays and the probe says so
		expect(probeClosure(prefix, ["model-store.ts"])).toEqual([
			`unhealed package import in model-store.ts: ${hg}`,
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(prefix, { recursive: true, force: true });
	}
});

// W1471: the REAL model-store closure — bin/*.ts flat-copied the way the
// installer lays the runtime home — must copy + heal + probe clean.
test("real model-store closure resolves clean in a flat runtime home", () => {
	const repoRoot = join(import.meta.dir, "..", "..", "..");
	const bin = join(repoRoot, "packages", "belt", "bin");
	const prefix = mkprefix();
	try {
		for (const f of readdirSync(bin).filter((n) => n.endsWith(".ts")))
			writeFileSync(join(prefix, f), readFileSync(join(bin, f)));
		copyDeps(repoRoot, prefix);
		healImports(prefix);
		expect(probeClosure(prefix, ["model-store.ts"])).toEqual([]);
	} finally {
		rmSync(prefix, { recursive: true, force: true });
	}
});

function readText(p: string): string {
	return readFileSync(p, "utf8");
}
