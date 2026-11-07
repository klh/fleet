#!/usr/bin/env bun
// port-sweep-g-slice5.ts — W1294.9.5 mechanical port transform (slice-6's
// script adapted to the slice-4 staged-rename shape): the files are ALREADY
// `git mv`-renamed to <name>@<tag>.e2e.ts; this pass swaps the bun:test import for
// @playwright/test, and prefixes the lifecycle hooks + bare describe calls
// with `test.`. No wrapper describe — the tag rides the filename (slice-4
// convention, keeps the W833 rename credit 1:1). Mechanical ONLY —
// assertion drift is fixed by anchored Edits afterwards, never here.
// Header comment `test/x.test.ts` mentions ride along renamed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "test");
// tag @api when the file stands up an HTTP server of its own
const API = new Set([
	"session-policy",
	"session-enroll",
	"session-start-identity",
	"usage-demo-api",
]);
const FILES = [
	"session-end-async",
	"session-enroll",
	"session-heartbeat",
	"session-policy",
	"session-rename",
	"session-start-context",
	"session-start-identity",
	"session-start-supervisor",
	"session-start-worker",
	"usage-api",
	"usage-demo",
	"usage-demo-api",
	"usage-harvest",
	"usage-migration",
	"usage-page",
	"usage-provenance",
	"usage-seed",
];

for (const name of FILES) {
	const to = join(DIR, `${name}@${API.has(name) ? "api" : "unit"}.e2e.ts`);
	let src = readFileSync(to, "utf8");

	// 1) import swap: bun:test -> @playwright/test. `describe` drops (bare
	// describe isn't exported; calls become test.describe) and hooks ride
	// the test object: afterAll -> test.afterAll etc.
	const HOOKS = new Set(["beforeAll", "afterAll", "beforeEach", "afterEach"]);
	const names = src.match(/import \{([^}]+)\} from "bun:test";/);
	if (!names) throw new Error(`${name}: no bun:test import`);
	const wanted = names[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.filter(
			(n) => n !== "describe" && !HOOKS.has(n) && n !== "setDefaultTimeout",
		)
		.sort((a, b) => a.localeCompare(b));
	const importLine = `import { ${wanted.join(", ")} } from "@playwright/test";`;
	src = src.replace(/import \{[^}]+\} from "bun:test";/, importLine);

	// 1b) setDefaultTimeout(N) -> playwright default is 60s (central
	// playwright.base.ts); the 30s spawn-heavy floors are redundant. Drop
	// the call and the comment line that explains it.
	src = src.replace(/^\n?setDefaultTimeout\([0-9_]+\);.*\n/gm, "");

	// 2) bare describe( -> test.describe( ; hooks -> test.-prefixed.
	// \b guards identifiers; these names never appear as property calls
	// (x.beforeAll) in the corpus.
	src = src.replace(/(^|[^.\w])describe\(/g, "$1test.describe(");
	src = src.replace(
		/(^|[^.\w])(beforeAll|afterAll|beforeEach|afterEach)\(/g,
		"$1test.$2(",
	);

	// 3) header comment still names the old file — carry the new name over
	src = src.replace(
		new RegExp(`test/${name}\\.test\\.ts`, "g"),
		`test/${name}.e2e.ts`,
	);

	writeFileSync(to, src);
	console.log(
		`ported ${name} -> ${to.split("/").pop()} (${API.has(name) ? "@api" : "@unit"})`,
	);
}
console.log(`done: ${FILES.length} files`);
