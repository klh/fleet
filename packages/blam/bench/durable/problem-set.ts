// bench/durable/problem-set.ts — W2971.3 problem-set registry schema + loader.
// A problem set is premade, identifiable, mechanically fixable: base commit,
// gold fix commit, verbatim issue text, and judge expectations. Data only —
// the harness never invents work. zod is the single source of truth (schema
// law): drift fails LOUD at load, never mid-arm.
import { readFileSync } from "node:fs";
import { z } from "zod";

export const ProblemSchema = z.strictObject({
	id: z.string().regex(/^[A-Z][A-Z0-9-]+$/),
	repo: z.string().min(1), // key into bench.local.json repos map
	baseCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
	fixCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
	issueText: z.string().min(40), // verbatim user-text the runner submits
	judge: z.strictObject({
		kind: z.literal("pytest-hidden"),
		// hidden test node ids: expect base to FAIL them, gold to PASS them
		tests: z.array(z.string().min(1)).min(1),
		// repo-relative test files the fix commit ships — the judge copies
		// them into EVERY phase (SPH-style hidden tests are gold-borne);
		// optional — problems whose tests exist at base omit this
		testFiles: z.array(z.string().min(1)).optional(),
		expectBase: z.literal("fail"),
		expectGold: z.literal("pass"),
	}),
	// retained-negative problems refuse admission entirely (oracle-isolation law)
	retainedNegative: z.boolean().optional(),
});

export const ProblemSetSchema = z.strictObject({
	version: z.literal(1),
	problems: z.array(ProblemSchema),
});

export type Problem = z.infer<typeof ProblemSchema>;
export type ProblemSet = z.infer<typeof ProblemSetSchema>;

export function loadProblemSet(path: string): ProblemSet {
	const parsed = ProblemSetSchema.safeParse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (!parsed.success) {
		throw new Error(
			`problem-set drift refused at ${path}:\n${parsed.error.message}`,
		);
	}
	const ids = new Set<string>();
	for (const problem of parsed.data.problems) {
		if (ids.has(problem.id)) {
			throw new Error(`problem-set drift refused: duplicate id ${problem.id}`);
		}
		ids.add(problem.id);
	}
	return parsed.data;
}

export function loadProblem(path: string, id: string): Problem {
	const problem = loadProblemSet(path).problems.find((p) => p.id === id);
	if (!problem) throw new Error(`problem ${id} not in set ${path}`);
	return problem;
}
