#!/usr/bin/env bun
// port-sweep-g-slice6.ts — W1294.9.6 mechanical port transform: rename each
// family *.test.ts to *.e2e.ts, swap the bun:test import for @playwright/test
// (describe -> test.describe), and wrap the whole file body in one
// test.describe("@unit"|"@api") block. Mechanical ONLY — assertion drift is
// fixed by anchored Edits afterwards, never here. Header comment `test/x.test.ts`
// mentions ride along renamed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "test");
// tag @api when the file stands up a server (Bun.serve / startServer import)
const API = new Set([
	"federation-board-page",
	"federation-pull",
	"federation-report",
	"federation-work",
	"store-port",
	"store-port-consumers",
	"launch-intent-cli",
]);
const FILES = [
	"store-port-consumers",
	"store-port",
	"store-read-retry",
	"store-sql-error",
	"store-tx",
	"store-txn-retry",
	"launch-backoff",
	"launch-context",
	"launch-fencing",
	"launch-intent-cli",
	"launch-janitor",
	"launch-parent",
	"federation-board-page",
	"federation-peers",
	"federation-pull",
	"federation-report",
	"federation-work",
];

for (const name of FILES) {
	const from = join(DIR, `${name}.test.ts`);
	const to = join(DIR, `${name}.e2e.ts`);
	let src = readFileSync(from, "utf8");

	// 1) import swap: bun:test -> @playwright/test. describe drops from the
	// import (bare describe isn't exported; the wrapper supplies test.describe)
	// and hooks ride the test object: afterAll -> test.afterAll etc, matching
	// the sweep-A convention.
	const HOOKS = new Set(["beforeAll", "afterAll", "beforeEach", "afterEach"]);
	const names = src.match(/import \{([^}]+)\} from "bun:test";/);
	if (!names) throw new Error(`${name}: no bun:test import`);
	const wanted = names[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((n) => n !== "describe" && !HOOKS.has(n))
		.sort((a, b) => a.localeCompare(b));
	const importLine = `import { ${wanted.join(", ")} } from "@playwright/test";`;
	src = src.replace(/import \{[^}]+\} from "bun:test";/, importLine);

	// 2) wrap the body (everything after the import block) in one tagged
	// describe. Hook calls (beforeAll/afterAll/afterEach) inside the wrapper
	// are file-scoped in playwright — same semantics as bun's top level.
	const lastImportEnd = (() => {
		let i = 0;
		for (const m of src.matchAll(/^import[\s\S]*?from ".*?";$/gm))
			if (m.index !== undefined) i = m.index + m[0].length;
		return i;
	})();
	const head = src.slice(0, lastImportEnd);
	let body = src.slice(lastImportEnd);
	// playwright exports no bare describe() — every top-level suite call
	// rides the imported test object once wrapped; same for hooks
	body = body.replace(/^describe\(/gm, "test.describe(");
	body = body.replace(
		/^(beforeAll|afterAll|beforeEach|afterEach)\(/gm,
		"test.$1(",
	);
	// indented hook calls inside nested describes — \b guards identifiers;
	// these names never appear as property calls (x.beforeAll) in the corpus
	body = body.replace(
		/(?:^|\n)(\s*)(beforeAll|afterAll|beforeEach|afterEach)\(/g,
		(_match, ws: string, hook: string) => `\n${ws}test.${hook}(`,
	);
	// header comment still names the old file — carry the new name forward
	body = body.replace(
		new RegExp(`test/${name}\\.test\\.ts`),
		`test/${name}.e2e.ts`,
	);
	const tag = API.has(name) ? "@api" : "@unit";
	// one tab deeper for the wrapped body
	const indented = body
		.split("\n")
		.map((l) => (l.length ? `\t${l}` : l))
		.join("\n");
	src = `${head}\n\ntest.describe("${tag}", () => {${indented}});\n`;
	writeFileSync(to, src);
	console.log(`ported ${name}.e2e.ts (${tag})`);
}
console.log(`done: ${FILES.length} files`);
