// test/source-closure.test.ts — W1256.1 unit coverage for the sync-harness
// payload closure (lib/source-closure.ts): the walker proves the declared
// payload covers the real import graph (the W661 class closes with a loud
// install-time refusal instead of a dark runtime).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	coveredByPayload,
	payloadClosure,
	payloadCoverage,
} from "../scripts/lib/source-closure.ts";
import { CLOSURE_ENTRIES, sourcePaths } from "../scripts/sync-harness.ts";

// OS tmpdir — a fixture inside the checkout would let the walk leak beyond
// the fixture (fixture-isolation lesson).
const root = mkdtempSync(join(tmpdir(), "w1256-closure-"));

function file(rel: string, body: string): string {
	const path = join(root, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
	return rel;
}

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("coveredByPayload", () => {
	test("exact path, dir membership, and outside are distinct", () => {
		const payload = ["packages/a/src", "packages/a/package.json"];
		expect(coveredByPayload("packages/a/src/lib.ts", payload)).toBe(true);
		expect(coveredByPayload("packages/a/package.json", payload)).toBe(true);
		expect(coveredByPayload("packages/a/srcx/lib.ts", payload)).toBe(false);
		expect(coveredByPayload("packages/b/src/lib.ts", payload)).toBe(false);
	});
});

describe("payloadCoverage coverage walk", () => {
	const payload = ["pkg/face.ts", "pkg/lib.ts"];

	test("a closed payload passes with the full walk recorded", async () => {
		file("pkg/face.ts", `import { x } from "./lib.ts";\nexport const f = x;\n`);
		file("pkg/lib.ts", "export const x = 1;\n");
		const report = await payloadCoverage({
			repoRoot: root,
			entries: ["pkg/face.ts"],
			payload,
		});
		expect(report.missing).toEqual([]);
		expect(report.outside).toEqual([]);
		expect(report.visited.sort()).toEqual(["pkg/face.ts", "pkg/lib.ts"]);
	});

	test("an uncovered import names the file (the W661 tripwire)", async () => {
		file("pkg/face.ts", `import "./lib.ts";\nimport "../outside/y.ts";\n`);
		file("pkg/lib.ts", "export const x = 1;\n");
		file("outside/y.ts", "export const y = 2;\n");
		const report = await payloadCoverage({
			repoRoot: root,
			entries: ["pkg/face.ts"],
			payload,
		});
		expect(report.outside).toEqual(["outside/y.ts"]);
		expect(report.visited).toContain("outside/y.ts");
	});
});

describe("payloadCoverage walk modes", () => {
	test("dynamic import() is walked like a static import", async () => {
		file("pkg/face.ts", `await import("./dyn.ts");\n`);
		file("pkg/dyn.ts", "export {};\n");
		const report = await payloadCoverage({
			repoRoot: root,
			entries: ["pkg/face.ts"],
			payload: ["pkg/face.ts", "pkg/lib.ts", "pkg/dyn.ts"],
		});
		expect(report.outside).toEqual([]);
		expect(report.visited).toContain("pkg/dyn.ts");
	});

	test("a missing declared entry is reported, dangling imports are not", async () => {
		file("pkg/face.ts", `import "./gone.ts";\nexport {};\n`);
		const report = await payloadCoverage({
			repoRoot: root,
			entries: ["pkg/face.ts", "pkg/vanished.ts"],
			payload: ["pkg/face.ts"],
		});
		expect(report.missing).toEqual(["pkg/vanished.ts"]);
		expect(report.visited).toEqual(["pkg/face.ts"]);
	});
});

// W1466 fixture repo: a face and its lib dir (a sibling module, a test
// module, a folded asset), a @klh package-name import with a query, URL and
// import.meta.dir assets, a package-root anchor, and files nothing reaches.
const CLOSURE_FIXTURE: Record<string, string> = {
	"packages/app/bin/face.ts": `import { a } from "../lib/a.ts";\nexport const face = a;\n`,
	"packages/app/lib/a.ts": [
		`import { b } from "@klh/dep/src/b.ts?raw";`,
		`import { resolve } from "node:path";`,
		`export const rules = resolve(import.meta.dir, "..", "rules");`,
		`export const anchor = resolve(import.meta.dir, "../..");`,
		`export const data = new URL("./data.json", import.meta.url);`,
		"export const a = b;\n",
	].join("\n"),
	"packages/app/lib/data.json": "{}\n",
	"packages/app/lib/sibling.ts": `export { c } from "../../tool/c.ts";\n`,
	"packages/app/lib/a.test.ts": `import "../../stray/s.ts";\n`,
	"packages/app/rules/r.md": "# rules\n",
	"packages/app/package.json": "{}\n",
	"packages/dep/src/b.ts": `export const policy = new URL(\n\t"../policy.json",\n\timport.meta.url,\n);\nexport const b = 1;\n`,
	"packages/dep/policy.json": "{}\n",
	"packages/dep/package.json": "{}\n",
	"packages/dep/docs/unreached.md": "# unreached\n",
	"packages/tool/c.ts": "export const c = 3;\n",
	"packages/stray/s.ts": "export {};\n",
	"hooks/pre-commit": "// fixture hook\n",
};

describe("payloadClosure computes the ship list (W1466)", () => {
	test("units, assets, manifests and missing faces come from the walk", async () => {
		const tracked = Object.entries(CLOSURE_FIXTURE).map(([rel, body]) =>
			file(rel, body),
		);
		const report = await payloadClosure({
			repoRoot: root,
			faces: ["packages/app/bin/face.ts", "hooks", "packages/gone.ts"],
			tracked,
		});
		expect(report.missing).toEqual(["packages/gone.ts"]);
		// lib ships whole (sibling.ts reaches tool/c.ts at the fixed point),
		// data.json folds into it, the anchor and every unreached file stay
		// out, and only tracked manifests ride along.
		expect(report.paths).toEqual([
			"hooks",
			"packages/app/bin",
			"packages/app/lib",
			"packages/app/package.json",
			"packages/app/rules",
			"packages/dep/package.json",
			"packages/dep/policy.json",
			"packages/dep/src",
			"packages/tool/c.ts",
		]);
		// test modules are never walked; whole-tree faces walk every file
		expect(report.visited).toContain("hooks/pre-commit");
		expect(report.visited).not.toContain("packages/app/lib/a.test.ts");
		expect(report.visited).not.toContain("packages/stray/s.ts");
	});
});

// W1466: sync-harness ships the computed closure (sourcePaths); CI re-walks
// the real repo so the coverage walker agrees with it and the runtime
// assets no import names (rules dir, gate policies, hook stubs) ride along.
describe("payloadCoverage repo drift guard (W661)", () => {
	test("the computed payload covers the real import closure", async () => {
		const repoRoot = resolve(import.meta.dir, "../../..");
		const payload = await sourcePaths(repoRoot);
		const report = await payloadCoverage({
			repoRoot,
			entries: CLOSURE_ENTRIES,
			payload,
		});
		expect(report.missing).toEqual([]);
		expect(report.outside).toEqual([]);
		const essentials = [
			".githooks",
			"packages/suspenders/agent-rules",
			"packages/buckle/upstreams.json",
			"packages/buckle/routing-policy.json",
			"packages/buckle/repo-policy.json",
			"packages/telemetry/src",
			"packages/blam/src",
			"packages/local-llm/registry.ts",
		];
		expect(essentials.filter((p) => !coveredByPayload(p, payload))).toEqual([]);
	});
});
