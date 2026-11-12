import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { scanCompletionDiff } from "./fake-completion.ts";

const assemble = (...parts: string[]) => parts.join("");
const missing = assemble("not ", "implemented");
const receipt =
	"seeds/examples/supervisor-consumption-digest-receipts/2026-11-12-canonical-start/canonical-tool-red.log";
const heading = "Running 1 test using 1 worker";
const diagnostic = `    Error: Captured behavior is ${missing}`;
const excerpt = `    > 30 | throw Error("${missing}");`;
const diffFor = (lines: string[], path = receipt) =>
	[
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
		"",
	].join("\n");

// Exact captured Flock5c test output, reconstructed without source-marker literals.
const historical =
	'\nRunning 1 test using 1 worker\n\n  \u2718  1 [integration] \u203a tests/integration/supervisor-digest-tool.e2e.ts:7:1 \u203a immutable producer exports compute filesystem seed and image-bound executable policy digests (244ms)\n\n\n  1) [integration] \u203a tests/integration/supervisor-digest-tool.e2e.ts:7:1 \u203a immutable producer exports compute filesystem seed and image-bound executable policy digests \n\n    Error: Canonical producer tooling is <missing-behavior>\n\n       at integration/supervisor-digest-tool.fixture.ts:30\n\n      28 |\n      29 | export async function prepareCanonicalTool(_tooling: Awaited<ReturnType<typeof prepareTooling>>, _fleetRepo: string) {\n    > 30 | \tthrow Error("Canonical producer tooling is <missing-behavior>");\n         | \t      ^\n      31 | }\n      32 |\n        at prepareCanonicalTool (<flock-worktree>/tests/integration/supervisor-digest-tool.fixture.ts:30:8)\n        at <flock-worktree>/tests/integration/supervisor-digest-tool.e2e.ts:13:22\n\n    Error Context: test-results/supervisor-digest-tool.e2e-8e776-d-executable-policy-digests-integration/error-context.md\n\n  1 failed\n    [integration] \u203a tests/integration/supervisor-digest-tool.e2e.ts:7:1 \u203a immutable producer exports compute filesystem seed and image-bound executable policy digests \n'.replaceAll(
		"<missing-behavior>",
		missing,
	);
test("real historical receipt lines 9 and 15 are captured test data @unit", () => {
	expect(createHash("sha256").update(historical).digest("hex")).toBe(
		"3a62b8f6596ee4cd97b6805c4fc409472e66129993fde24e1476810632320551",
	);
	expect(scanCompletionDiff(diffFor(historical.split("\n")))).toEqual([]);
});
test("Bun diagnostic and numbered frame are captured only after its test heading @unit", () => {
	expect(
		scanCompletionDiff(
			diffFor(["bun test v1.4.4 (aabbccdd)", diagnostic, excerpt]),
		),
	).toEqual([]);
});

for (const item of [
	{
		name: "ordinary log",
		path: "logs/result.log",
		lines: [heading, diagnostic],
	},
	{
		name: "real source in receipt directory",
		path: "receipts/runtime.ts",
		lines: [heading, diagnostic],
	},
	{
		name: "log-looking source suffix",
		path: "receipts/runtime.log.ts",
		lines: [heading, diagnostic],
	},
	{
		name: "lookalike directory",
		path: "receipts-backup/result.log",
		lines: [heading, diagnostic],
	},
	{
		name: "absolute path",
		path: "/tmp/receipts/result.log",
		lines: [heading, diagnostic],
	},
	{
		name: "parent path",
		path: "../receipts/result.log",
		lines: [heading, diagnostic],
	},
	{
		name: "traversal after receipt directory",
		path: "receipts/../runtime.log",
		lines: [heading, diagnostic],
	},
	{ name: "missing heading", path: receipt, lines: [diagnostic] },
	{
		name: "malformed heading",
		path: receipt,
		lines: ["Running 1 tests using 1 workers", diagnostic],
	},
	{
		name: "quoted heading",
		path: receipt,
		lines: [JSON.stringify(heading), diagnostic],
	},
	{ name: "late heading", path: receipt, lines: [diagnostic, heading] },
	{
		name: "raw throw",
		path: receipt,
		lines: [heading, `throw Error("${missing}");`],
	},
	{
		name: "indented raw throw",
		path: receipt,
		lines: [heading, `    throw Error("${missing}");`],
	},
	{
		name: "executable error label",
		path: receipt,
		lines: [heading, `Error: throw Error("${missing}");`],
	},
	{
		name: "ordinary message",
		path: receipt,
		lines: [heading, `info: ${missing}`],
	},
	{
		name: "malformed code frame",
		path: receipt,
		lines: [heading, `> | ${missing}`],
	},
	{
		name: "line zero is not a source frame",
		path: receipt,
		lines: [heading, `0 | ${missing}`],
	},
])
	test(`retains refusal for ${item.name} @unit`, () => {
		expect(
			scanCompletionDiff(diffFor(item.lines, item.path)).map(
				(hit) => hit.marker,
			),
		).toEqual(["placeholder-throw"]);
	});

test("one file's transcript heading cannot qualify the next receipt @unit", () => {
	expect(
		scanCompletionDiff(
			diffFor([heading]) + diffFor([diagnostic], "receipts/other.log"),
		),
	).toMatchObject([
		{ path: "receipts/other.log", line: 1, marker: "placeholder-throw" },
	]);
});
for (const prefix of [" ", "-"])
	test(`non-added heading ${JSON.stringify(prefix)} does not qualify capture @unit`, () => {
		const diff = [
			`+++ b/${receipt}`,
			"@@ -1 +1,2 @@",
			`${prefix}${heading}`,
			`+${diagnostic}`,
			"",
		].join("\n");
		expect(scanCompletionDiff(diff)).toHaveLength(1);
	});
for (const [text, marker] of [
	...["skip", "only", "todo"].map((kind) => [
		`Error: test.${kind}("later")`,
		"skip-gate",
	]),
	[assemble("Error: x", 'it("later")'), "x-gate"],
	[assemble("Error: TO", "DO: finish"), "stub-note"],
	[assemble("> 30 | FIX", "ME: finish"), "stub-note"],
])
	test(`captured output still rejects ${marker} ${text} @unit`, () => {
		expect(
			scanCompletionDiff(diffFor([heading, text ?? ""])).map(
				(hit) => hit.marker,
			),
		).toEqual([marker]);
	});
test("plain receipt directory and terminal-colored test heading remain captured data @unit", () => {
	expect(
		scanCompletionDiff(
			diffFor(
				[`\u001b[1m${heading}\u001b[0m`, diagnostic, excerpt],
				"receipts/test.log",
			),
		),
	).toEqual([]);
});

test("a comment-wrapped heading cannot bless executable numbered syntax @unit", () => {
	const code = `30 | (()=>{throw Error("${missing}")})()`;
	expect(scanCompletionDiff(diffFor(["/*", heading, "*/", code]))).toHaveLength(
		1,
	);
});
test("a context-only first-line wrapper cannot bless later added transcript content @unit", () => {
	const diff = [
		`+++ b/${receipt}`,
		"@@ -1,2 +1,4 @@",
		" /*",
		`+${heading}`,
		" */",
		`+${excerpt}`,
		"",
	].join("\n");
	expect(scanCompletionDiff(diff)).toHaveLength(1);
});
