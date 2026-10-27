// test/package-contract.test.ts — W1303.1.1: P1 package-contract conformance
// scoped to @klh/buckle (check-versions/check-deps/check-pack equivalents):
// exact pins, exports/files/bin resolve on disk, and src/bin imports stay
// inside the declared dependency closure. The @klh/telemetry relative
// reach-ins ride the W1249 ratchet baseline (tests/fleet.import-law.guard.test.ts)
// and are out of scope here.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PKG = join(import.meta.dir, "..");
type Manifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	exports: Record<string, string>;
	files: string[];
	bin: Record<string, string>;
	engines: Record<string, string>;
};
const manifest = JSON.parse(
	readFileSync(join(PKG, "package.json"), "utf8"),
) as Manifest;

/** Every .ts file under a dir, recursively. */
const walk = (dir: string): string[] => {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (p.endsWith(".ts")) out.push(p);
	}
	return out;
};

/** Import specifiers: static `from "..."` plus dynamic `import("...")`. */
const specifiers = (file: string): string[] => {
	const text = readFileSync(file, "utf8");
	const specs: string[] = [];
	for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) specs.push(m[1]);
	for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g))
		specs.push(m[1]);
	return specs;
};

const sourceDirs = () => [...walk(join(PKG, "src")), ...walk(join(PKG, "bin"))];

describe("package contract (W1303.1.1)", () => {
	test("contract fields present: exports/files/bin/engines", () => {
		expect(Object.keys(manifest.exports).length).toBeGreaterThan(0);
		expect(manifest.files.length).toBeGreaterThan(0);
		expect(Object.keys(manifest.bin).length).toBeGreaterThan(0);
		expect(manifest.engines.bun).toBeTruthy();
	});

	test("every dependency spec is an exact MAJOR.MINOR.PATCH pin", () => {
		const deps = { ...manifest.dependencies, ...manifest.devDependencies };
		expect(Object.keys(deps).length).toBeGreaterThan(0);
		for (const [name, spec] of Object.entries(deps)) {
			expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
			if (name.startsWith("@klh/")) {
				const sib = join(PKG, "..", name.slice(5), "package.json");
				expect(existsSync(sib)).toBe(true);
				expect(spec).toBe(
					JSON.parse(readFileSync(sib, "utf8")).version as string,
				);
			}
		}
	});

	test("exports entries resolve to existing files", () => {
		for (const target of Object.values(manifest.exports)) {
			// pattern exports ("./src/*") resolve when their base dir exists
			expect(existsSync(join(PKG, target.replace(/\*$/, "")))).toBe(true);
		}
	});

	test("files allowlist ships the runtime-read package confs", () => {
		for (const conf of [
			"upstreams.json",
			"routing-policy.json",
			"repo-policy.json",
		]) {
			expect(manifest.files).toContain(conf);
			expect(existsSync(join(PKG, conf))).toBe(true);
		}
	});

	test("bin target exists", () => {
		for (const target of Object.values(manifest.bin)) {
			expect(existsSync(join(PKG, target))).toBe(true);
		}
	});

	test("no undeclared npm import in src/bin (check-deps scope)", () => {
		const declared = new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
		]);
		for (const f of sourceDirs()) {
			for (const s of specifiers(f)) {
				if (/^[./]/.test(s)) continue; // relative — W1249 ratchet owns these
				if (/^(node|bun|ws):/.test(s) || s === "bun") continue; // builtins
				const pkg = s.startsWith("@")
					? s.split("/").slice(0, 2).join("/")
					: s.split("/")[0];
				expect(declared.has(pkg)).toBe(true);
			}
		}
	});

	test("no unused declared dependency (check-deps scope)", () => {
		const declared = {
			...manifest.dependencies,
			...manifest.devDependencies,
		};
		const used = new Set<string>();
		for (const f of [...sourceDirs(), ...walk(join(PKG, "test"))]) {
			for (const s of specifiers(f)) {
				const pkg = s.startsWith("@")
					? s.split("/").slice(0, 2).join("/")
					: s.split("/")[0];
				used.add(pkg);
			}
		}
		for (const name of Object.keys(declared)) {
			if (name.startsWith("@types/")) continue; // ambient types, never imported
			expect(used.has(name)).toBe(true);
		}
	});
});
