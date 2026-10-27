// test/test-import-integrity.test.ts — W1803: guard against dangling relative
// imports in this package's test files. A merge can drop a referenced module
// while its importer survives (the install-llm-steps/gateway-config scare —
// the hits there are string literals for a runtime-generated file, not
// imports); this makes the "no test module dangles" end-state mechanical.
// Bun.Transpiler.scanImports parses the AST, so import-shaped strings inside
// fixture payloads (e.g. w1302-merge-dangling.test.ts) never register.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const testDir = new URL(".", import.meta.url).pathname;
const files = readdirSync(testDir).filter(
	(f) => f.endsWith(".test.ts") || f.endsWith(".e2e.ts"),
);

const transpiler = new Bun.Transpiler({ loader: "ts" });

function resolves(source: string, fromFile: string): boolean {
	if (!source.startsWith(".")) return true; // bare/package imports ride node_modules
	const base = source.endsWith(".ts") ? source : `${source}.ts`;
	const dir = join(testDir, fromFile, "..");
	const asFile = join(dir, base);
	if (existsSync(asFile) && statSync(asFile).isFile()) return true;
	const asIndex = join(dir, source, "index.ts");
	return existsSync(asIndex) && statSync(asIndex).isFile();
}

describe("W1803 test-import integrity", () => {
	test("no test file carries a dangling relative import", () => {
		const dangling: string[] = [];
		for (const f of files) {
			const code = readFileSync(join(testDir, f), "utf8");
			for (const imp of transpiler.scanImports(code)) {
				if (!resolves(imp.path, f)) dangling.push(`${f}: ${imp.path}`);
			}
		}
		expect(dangling).toEqual([]);
	});
});
