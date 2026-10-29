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
	payloadCoverage,
} from "../scripts/lib/source-closure.ts";
import { CLOSURE_ENTRIES, SOURCE_PATHS } from "../scripts/sync-harness.ts";

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

// The install-time tripwire (sync-harness.ts) refuses to ship when the
// payload drifts from the graph; this repeats the same walk in CI so drift
// fails in bun test too, naming the uncovered file.
describe("payloadCoverage repo drift guard (W661)", () => {
	test("SOURCE_PATHS covers the real import closure", async () => {
		const repoRoot = resolve(import.meta.dir, "../../..");
		const report = await payloadCoverage({
			repoRoot,
			entries: CLOSURE_ENTRIES,
			payload: SOURCE_PATHS,
		});
		expect(report.missing).toEqual([]);
		expect(report.outside).toEqual([]);
	});
});
