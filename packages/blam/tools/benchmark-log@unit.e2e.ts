import { expect, test } from "@playwright/test";
import { summarize, validate, renderSummary } from "./benchmark-log.ts";
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
