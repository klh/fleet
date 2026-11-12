import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { hostProcess } from "../../../deploy/host/process.ts";
import {
	type AddedWorkspaceDependency,
	missingImports,
	missingImportsExplained,
	type Proof,
	type ProofRunnerGroup,
} from "./coverage-proof.ts";

export type CoverageRunInput = {
	cwd: string;
	outputDir: string;
	timeoutMs: number;
	groups: ProofRunnerGroup[];
	unsupported: string[];
	addedProd: string[];
	testFiles: string[];
	addedWorkspaceDeps: AddedWorkspaceDependency[];
	purePort: boolean;
};
type ReportError = { message?: string; value?: string; stack?: string };
type ReportResult = { error?: ReportError; errors?: ReportError[] };
type ReportSuite = {
	suites?: ReportSuite[];
	specs?: {
		file: string;
		tests: {
			status: "expected" | "unexpected" | "skipped" | "flaky";
			results?: ReportResult[];
		}[];
	}[];
};
const ReportErrorSchema = z.object({
	message: z.string().optional(),
	value: z.string().optional(),
	stack: z.string().optional(),
});
const ReportResultSchema = z.object({
	error: ReportErrorSchema.optional(),
	errors: z.array(ReportErrorSchema).optional(),
});
const ReportSuiteSchema: z.ZodType<ReportSuite> = z.lazy(() =>
	z.object({
		suites: z.array(ReportSuiteSchema).optional(),
		specs: z
			.array(
				z.object({
					file: z.string(),
					tests: z.array(
						z.object({
							status: z.enum(["expected", "unexpected", "skipped", "flaky"]),
							results: z.array(ReportResultSchema).optional(),
						}),
					),
				}),
			)
			.optional(),
	}),
);
const CountSchema = z.number().int().nonnegative();
const PlaywrightProofReportSchema = z.object({
	config: z.object({ rootDir: z.string() }),
	suites: z.array(ReportSuiteSchema),
	errors: z.array(ReportErrorSchema),
	stats: z.object({
		expected: CountSchema,
		unexpected: CountSchema,
		skipped: CountSchema,
		flaky: CountSchema,
	}),
});
const canonical = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path).replace(/^\/private(?=\/(?:tmp|var)\/)/, "");
	}
};
const selector = (path: string): string =>
	path.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
function reportTests(suites: ReportSuite[]): {
	file: string;
	status: "expected" | "unexpected" | "skipped" | "flaky";
	errors: ReportError[];
}[] {
	return suites.flatMap((suite) => [
		...(suite.specs ?? []).flatMap((spec) =>
			spec.tests.map((test) => ({
				file: spec.file,
				status: test.status,
				errors: (test.results ?? []).flatMap((result) => [
					...(result.error ? [result.error] : []),
					...(result.errors ?? []),
				]),
			})),
		),
		...reportTests(suite.suites ?? []),
	]);
}
function importErrors(text: string): string {
	return text
		.split(/\r?\n/)
		.map((raw) => {
			const line = stripVTControlCharacters(raw)
				.trim()
				.replace(/^(?:ResolveMessage|Error): /, "");
			const resolved = line.match(
				/^Cannot find (package|module) ['"]([^'"]+)['"] imported from (.+)$/,
			);
			if (resolved)
				return [
					"error: Cannot find ",
					resolved[1],
					" '",
					resolved[2],
					"' from '",
					resolved[3],
					"'",
				].join("");
			return line.replace(
				/^Cannot find (package|module) /,
				"error: Cannot find $1 ",
			);
		})
		.join("\n");
}

/** Execute selected specs; omitted/zero/skipped/unstable results remain unknown.
 * A production change is proved only by a test failure or an explained
 * diff-added module failure. The caller separately fingerprints the workspace.
 * Only TEST process groups are hard-bounded here; synchronous Git preparation
 * and finalization are not. The caller subtracts elapsed preparation time. */
export async function runCoverageGroups(
	input: CoverageRunInput,
	deps: { run?: typeof hostProcess } = {},
): Promise<Proof> {
	const deadline = performance.now() + input.timeoutMs;
	const run = deps.run ?? hostProcess;
	let passed = 0,
		failed = 0,
		skipped = 0;
	const details: string[] = [];
	const partial: string[] = [];
	if (input.unsupported.length)
		partial.push(`unsupported specs: ${input.unsupported.join(", ")}`);
	const artifactRelative = relative(
		resolve(input.cwd),
		resolve(input.outputDir),
	);
	if (!artifactRelative.startsWith("..") && !artifactRelative.startsWith("/"))
		return {
			status: "error",
			detail: "proof output must be outside the fingerprinted workspace",
		};
	try {
		for (const [index, group] of input.groups.entries()) {
			if (!group.files.length) throw new Error("empty proof selection");
			const remaining = Math.floor(deadline - performance.now());
			if (remaining <= 0) throw new Error("proof deadline exceeded");
			const argv =
				group.runner === "bun"
					? [
							process.execPath,
							"--no-install",
							"test",
							...group.files.map((file) => resolve(input.cwd, file)),
						]
					: [
							process.execPath,
							"--no-install",
							join(input.cwd, "node_modules/@playwright/test/cli.js"),
							"test",
							"--config",
							group.config,
							"--workers=1",
							"--retries=0",
							"--max-failures=0",
							"--reporter=json",
							"--output",
							join(input.outputDir, String(index)),
							...group.files.map(
								(file) => `${selector(resolve(input.cwd, file))}$`,
							),
						];
			const result = await run(argv, {
				cwd: input.cwd,
				timeoutMs: remaining,
				maxBytes: 8 * 1024 * 1024,
			});
			if (performance.now() >= deadline || result.signal)
				throw new Error("proof deadline or signal");
			if (group.runner === "bun") {
				const output =
					new TextDecoder().decode(result.stdout) +
					"\n" +
					new TextDecoder().decode(result.stderr);
				const counts = (word: string) =>
					Number(
						[...output.matchAll(new RegExp(`(\\d+) ${word}\\b`, "g"))].at(
							-1,
						)?.[1] ?? -1,
					);
				const p = counts("pass"),
					f = counts("fail"),
					s = Math.max(0, counts("skip"));
				if (
					missingImports(output).length &&
					!missingImportsExplained(
						output,
						input.addedProd,
						input.testFiles,
						input.addedWorkspaceDeps,
						input.cwd,
					)
				)
					throw new Error("scratch module resolution failed");
				if (
					p < 0 ||
					f < 0 ||
					(result.code !== 0 && f === 0) ||
					(result.code === 0 && f > 0)
				)
					throw new Error("invalid Bun proof summary or exit");
				if (p + f === 0) partial.push("Bun collected no executed tests");
				passed += p;
				failed += f;
				skipped += s + Math.max(0, counts("todo"));
				details.push(`bun failed=${f} passed=${p}`);
				continue;
			}
			const report = PlaywrightProofReportSchema.parse(
				JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
				),
			);
			const tests = reportTests(report.suites);
			const runtimeImports = tests
				.flatMap((test) =>
					test.errors.map((error) =>
						importErrors(
							[error.message, error.value, error.stack]
								.filter((part) => part !== undefined)
								.join("\n"),
						),
					),
				)
				.filter((error) => /Cannot find (package|module)/.test(error));
			if (
				runtimeImports.some(
					(error) =>
						!missingImports(error).length ||
						!missingImportsExplained(
							error,
							input.addedProd,
							input.testFiles,
							input.addedWorkspaceDeps,
							input.cwd,
						),
				)
			)
				throw new Error("Playwright runtime module resolution failed");
			const statuses = ["expected", "unexpected", "skipped", "flaky"] as const;
			if (
				statuses.some(
					(status) =>
						report.stats[status] !==
						tests.filter((test) => test.status === status).length,
				)
			)
				throw new Error(
					"Playwright summary and collected test counts disagree",
				);
			const observed = new Set(
				tests.map((test) =>
					canonical(resolve(report.config.rootDir, test.file)),
				),
			);
			const selected = new Set(
				group.files.map((file) => canonical(resolve(input.cwd, file))),
			);
			for (const file of observed)
				if (!selected.has(file))
					partial.push(`unexpected collected spec: ${file}`);
			const errors = report.errors.map((error) =>
				importErrors(error.message ?? error.value ?? ""),
			);
			if (errors.length) {
				if (
					result.code === 0 ||
					errors.some(
						(error) =>
							!missingImports(error).length ||
							!missingImportsExplained(
								error,
								input.addedProd,
								input.testFiles,
								input.addedWorkspaceDeps,
								input.cwd,
							),
					)
				)
					throw new Error("Playwright collection or module resolution failed");
				passed += report.stats.expected;
				failed += report.stats.unexpected + errors.length;
				skipped += report.stats.skipped;
				if (report.stats.flaky) partial.push("Playwright flaky result");
				details.push("playwright collection requires diff-added module(s)");
				continue;
			}
			for (const file of group.files)
				if (!observed.has(canonical(resolve(input.cwd, file))))
					partial.push(`uncollected selected spec: ${file}`);
			const { expected: p, unexpected: f, skipped: s, flaky } = report.stats;
			if (p + f === 0) partial.push("Playwright collected no executed tests");
			if (flaky) partial.push("Playwright flaky result");
			if (
				(result.code !== 0 && f === 0 && p + f > 0) ||
				(result.code === 0 && f > 0)
			)
				throw new Error("Playwright exit disagrees with test result");
			passed += p;
			failed += f;
			skipped += s;
			details.push(`playwright ${group.config} failed=${f} passed=${p}`);
		}
	} catch {
		return {
			status: "error",
			detail:
				"reverse proof runner, deadline, transport or report failed (bounded); " +
				details.join("; "),
			failed,
			passed,
		};
	}
	if (performance.now() >= deadline)
		return {
			status: "error",
			detail: "reverse test-process budget exceeded",
			failed,
			passed,
		};
	if (skipped) partial.push(`skipped tests=${skipped}`);
	if (!input.groups.length) partial.push("no supported executable test specs");
	if (partial.length)
		return {
			status: "unknown",
			detail: `${partial.join("; ")}; ${details.join("; ")}`,
			failed,
			passed,
		};
	return failed > 0
		? {
				status: "proved",
				detail:
					"new test/collection failures without the change; " +
					details.join("; "),
				failed,
				passed,
			}
		: {
				status: "no-coverage",
				detail:
					(input.purePort
						? "all selected tests pass without the change (pure test port — advisory); "
						: "all selected tests pass without the change; ") +
					details.join("; "),
				failed: 0,
				passed,
				purePort: input.purePort,
			};
}
