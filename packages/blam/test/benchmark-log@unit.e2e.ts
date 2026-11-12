import { scratchWorld } from "@klh/test-kit";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	summarize,
	validate,
	renderSummary,
	BenchmarkLogSchema,
	benchmarkLog,
	renderNode,
} from "../tools/benchmark-log.ts";

test("canonical summary prominently retains successful 9461 recipes without a cross-task winner", async () => {
	const log = BenchmarkLogSchema.parse(
		Bun.JSON5.parse(
			await Bun.file(
				new URL("../../../benchmarks/benchmarks.json5", import.meta.url),
			).text(),
		),
	);
	const rendered = renderSummary(validate(log.tree));
	expect(rendered).toContain("6/6");
	expect(rendered).toContain("280.83");
	expect(rendered).toContain("9461");
	expect(rendered).toContain("unproven across tasks");
});
const run = (id: string, outcome = "pass", runType = "attempt") => ({
	kind: "run",
	id,
	title: id,
	runType,
	outcome,
	arm: "fixture",
	task: "fixture",
	independent: true,
	continues: null,
	producer: null,
	protocolSha256: null,
	metrics: {
		wallSeconds: null,
		wallBasis: null,
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		totalTokens: null,
		modelRequests: null,
		toolCalls: null,
	},
	quality: {
		accepted: null,
		targetsPassed: null,
		targetsTotal: null,
		regressionsPassed: null,
		regressionsTotal: null,
	},
	evidence: [],
	notes: [],
});
const group = (children: unknown[], coverage = "complete") => ({
	kind: "group",
	id: "root",
	title: "Root",
	document: "node.md",
	coverage,
	winner: null,
	notes: [],
	evidence: [],
	children,
});
const finding = (overrides: Record<string, unknown> = {}) => ({
	id: "finding",
	task: "fixture-task",
	recipe: "Observed recipe",
	scope: "single-task",
	sourceKind: "archived-treatment-summary",
	assessment: "best-observed-on-task",
	sample: "Archived sample",
	attempts: 6,
	graded: 6,
	accepted: 6,
	targets: { passed: 3, total: 3 },
	regressions: { passed: 59, total: 59 },
	qualityBasis: "Checks apply to accepted patches.",
	wallSeconds: [],
	medianAcceptedWallSeconds: 301.91,
	secondsPerAccepted: 280.83,
	wallBasis: "End-to-end; includes failures.",
	positiveUsage: true,
	servedModelLedgerJoined: true,
	auditBasis: "Accepted rows audited.",
	evidence: [
		{
			label: "Immutable archive",
			href: "source.txt",
			sha256: "a".repeat(64),
			availability: "committed",
		},
	],
	caveats: ["Adaptive single-task observation; no cross-task winner."],
	...overrides,
});
test("successful recipes remain visible even when no best-observed finding exists", () => {
	const child = {
		...group([]),
		id: "child",
		treatmentFindings: [
			finding({ assessment: "successful-recipe", secondsPerAccepted: null }),
		],
	};
	const rendered = renderSummary(
		validate({ ...group([child]), document: "root.md" }),
	);
	expect(rendered).toContain("Observed recipe");
	expect(rendered).toContain("6/6");
	expect(rendered).toContain("unproven across tasks");
});

test("archived treatment aggregates neither add executions nor promote a winner", () => {
	const tree = validate({
		...group([run("pass"), run("fail", "fail")]),
		treatmentFindings: [finding({ attempts: 110, graded: 108, accepted: 59 })],
	});
	expect(summarize(tree)).toMatchObject({
		totalRuns: 2,
		totalFailures: 1,
		attempts: 2,
	});
	expect(tree.winner).toBeNull();
	expect(renderNode(tree)).toContain("59/110 (108 graded)");
	expect(renderNode(tree)).toContain("They add no runs or confirmations");
});
test("treatment findings refuse unsupported scope, missing provenance and inconsistent counts", () => {
	for (const overrides of [
		{ accepted: 7 },
		{ accepted: 0 },
		{ secondsPerAccepted: null },
		{ positiveUsage: false },
		{ servedModelLedgerJoined: null },
		{ graded: 7 },
		{ scope: "cross-task" },
		{ assessment: "cross-task-winner" },
		{ evidence: [] },
		{ wallBasis: "" },
		{ targets: { passed: 4, total: 3 } },
	])
		expect(() =>
			validate({ ...group([]), treatmentFindings: [finding(overrides)] }),
		).toThrow();
	expect(() =>
		validate({ ...group([]), treatmentFindings: [finding(), finding()] }),
	).toThrow("Duplicate");
});
test("new treatment evidence participates in the actual committed-source hash check", async () => {
	const world = scratchWorld();
	try {
		await writeFile(
			join(world.home, "source.txt"),
			"unchanged archived source",
		);
		await writeFile(
			join(world.home, "benchmarks.json5"),
			JSON.stringify({
				schemaVersion: 1,
				updated: "2026-11-12",
				migration: [],
				tree: { ...group([]), treatmentFindings: [finding()] },
			}),
		);
		await expect(benchmarkLog("render", world.home)).rejects.toThrow(
			"Committed evidence hash mismatch",
		);
	} finally {
		world.clean();
	}
});

test("counts derive from leaves and keep fresh attempts distinct from judge replays", () => {
	const tree = validate(
		group([
			run("a", "fail"),
			{
				...run("replay", "expected-negative", "judge-replay"),
				independent: false,
				producer: "a",
			},
		]),
	);
	expect(summarize(tree)).toMatchObject({
		totalRuns: 2,
		totalFailures: 1,
		loggedRuns: 2,
		attempts: 1,
		judgeReplays: 1,
		knownFailures: 1,
	});
});
test("unknown outcomes and unindexed history never become measured zero", () => {
	expect(summarize(validate(group([run("unknown", "unknown")])))).toMatchObject(
		{ totalRuns: 1, totalFailures: null, unknownOutcomes: 1 },
	);
	expect(summarize(validate(group([], "unindexed")))).toMatchObject({
		totalRuns: null,
		totalFailures: null,
	});
	expect(
		summarize(
			validate(
				group([
					{
						...run("old-replay", "pass", "judge-replay"),
						independent: false,
						producer: null,
					},
				]),
			),
		),
	).toMatchObject({ attempts: 0, judgeReplays: 1 });
});
test("duplicate IDs, dangling replay producers, extra fields and unsupported winners refuse", () => {
	for (const tree of [
		group([run("a"), run("a")]),
		group([{ ...run("r", "pass", "judge-replay"), producer: "missing" }]),
		{ ...group([]), imaginaryRuns: 10 },
		{
			...group([]),
			winner: { arm: "invented", runs: ["missing"], assessment: "none" },
		},
	])
		expect(() => validate(tree)).toThrow();
});
test("summary is only the top-level link/winner/count table and does not paste history", () => {
	const tree = validate({
		...group([
			{
				...group([run("a")]),
				id: "child",
				title: "Child",
				notes: ["historical details"],
			},
		]),
		id: "root",
		document: "root.md",
	});
	const rendered = renderSummary(tree);
	expect(rendered).toContain("[Child](node.md)");
	expect(rendered).not.toContain("historical details");
	expect(rendered).toContain("| 1 | 0 |");
});
