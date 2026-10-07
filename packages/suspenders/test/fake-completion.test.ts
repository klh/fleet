import { expect, test } from "bun:test";
import {
	scanCompletionDiff,
	type FakeCompletionHit,
} from "../hooks/lib/fake-completion.ts";

// Marker text is assembled in these tests too: the closing diff of the lane
// that lands this scanner is itself scanned by the gate it ships.

const assemble = (...parts: string[]): string => parts.join("");

const diffFor = (added: string[], path = "src/product.ts"): string =>
	[
		`diff --git a/${path} b/${path}`,
		"index 1111111..2222222 100644",
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -0,0 +1,${added.length} @@`,
		...added.map((text) => `+${text}`),
		"",
	].join("\n");

test("added gated-test lines are flagged with new-side line numbers", () => {
	const diff = diffFor([
		"export const ok = 1;",
		assemble("it", ".skip(", '"later", () => {});'),
		"export const fine = 2;",
	]);
	const hits = scanCompletionDiff(diff);
	expect(hits).toHaveLength(1);
	expect(hits[0]?.path).toBe("src/product.ts");
	expect(hits[0]?.line).toBe(2);
	expect(hits[0]?.marker).toBe("skip-gate");
});

test("every marker family is caught", () => {
	const hits = scanCompletionDiff(
		diffFor(
			[
				assemble("describe", ".only(", '"edge"'),
				assemble("test", ".todo(", '"later"'),
				assemble("x", "it(", '"legacy"'),
				assemble("// ", "TO", "DO", ": wire the parser"),
				assemble('throw new Error("', "not ", "implemented", '");'),
			],
			"src/stub.ts",
		),
	);
	expect(hits.map((hit) => hit.marker)).toEqual([
		"skip-gate",
		"skip-gate",
		"x-gate",
		"stub-note",
		"placeholder-throw",
	]);
});

test("removed and context lines never flag", () => {
	const diff = [
		"diff --git a/src/x.ts b/src/x.ts",
		"--- a/src/x.ts",
		"+++ b/src/x.ts",
		"@@ -2,2 +2,2 @@",
		assemble("-// ", "TO", "DO", ": retired with the old code"),
		" context stays unflagged",
		"+export const replacement = 1;",
		"",
	].join("\n");
	expect(scanCompletionDiff(diff)).toHaveLength(0);
});

test("deleted files and no-newline marks do not break numbering", () => {
	const diff = [
		"diff --git a/src/gone.ts b/src/gone.ts",
		"deleted file mode 100644",
		"--- a/src/gone.ts",
		"+++ /dev/null",
		"@@ -1 +0,0 @@",
		"-export const gone = 1;",
		"diff --git a/src/keep.ts b/src/keep.ts",
		"--- a/src/keep.ts",
		"+++ b/src/keep.ts",
		"@@ -1,2 +1,3 @@",
		"+export const first = 1;",
		"\\No newline at end of file",
		"+export const second = 2;",
		"",
	].join("\n");
	const hits: FakeCompletionHit[] = scanCompletionDiff(diff);
	expect(hits).toHaveLength(0);
});

test("multi-file diffs attribute hits to the right path and line", () => {
	const diff = [
		diffFor(["export const a = 1;"], "src/one.ts"),
		diffFor(
			["export const b = 2;", assemble("it", ".only(", '"hot"')],
			"src/two.ts",
		),
	].join("\n");
	const hits = scanCompletionDiff(diff);
	expect(hits).toHaveLength(1);
	expect(hits[0]?.path).toBe("src/two.ts");
	expect(hits[0]?.line).toBe(2);
});
