import { z } from "zod";
const CountSchema = z.number().int().nonnegative().nullable();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
export const EvidenceSchema = z.strictObject({
	label: z.string().min(1),
	href: z.string().min(1),
	sha256: HashSchema.nullable(),
	availability: z.enum(["committed", "external", "native-event"]),
});
export const MetricsSchema = z.strictObject({
	wallSeconds: z.number().nonnegative().nullable(),
	wallBasis: z.string().nullable(),
	inputTokens: CountSchema,
	outputTokens: CountSchema,
	cacheReadTokens: CountSchema,
	totalTokens: CountSchema,
	modelRequests: CountSchema,
	toolCalls: CountSchema,
});
export const QualitySchema = z.strictObject({
	accepted: z.boolean().nullable(),
	targetsPassed: CountSchema,
	targetsTotal: CountSchema,
	regressionsPassed: CountSchema,
	regressionsTotal: CountSchema,
});
export const RunSchema = z.strictObject({
	kind: z.literal("run"),
	id: IdSchema,
	title: z.string().min(1),
	runType: z.enum([
		"attempt",
		"continuation",
		"judge-replay",
		"control",
		"probe",
	]),
	outcome: z.enum([
		"pass",
		"fail",
		"incomplete",
		"unknown",
		"expected-negative",
	]),
	arm: z.string().min(1),
	task: z.string().min(1),
	independent: z.boolean(),
	continues: IdSchema.nullable(),
	producer: IdSchema.nullable(),
	protocolSha256: HashSchema.nullable(),
	metrics: MetricsSchema,
	quality: QualitySchema,
	evidence: z.array(EvidenceSchema),
	notes: z.array(z.string()),
});
export type Run = z.infer<typeof RunSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Group = {
	kind: "group";
	id: string;
	title: string;
	document: string;
	coverage: "complete" | "partial" | "unindexed";
	winner: { arm: string; runs: string[]; assessment: string } | null;
	notes: string[];
	evidence: Evidence[];
	children: Entry[];
};
export type Entry = Run | Group;
export const GroupSchema: z.ZodType<Group> = z.strictObject({
	kind: z.literal("group"),
	id: IdSchema,
	title: z.string().min(1),
	document: z.string().regex(/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.md$/),
	coverage: z.enum(["complete", "partial", "unindexed"]),
	winner: z
		.strictObject({
			arm: z.string().min(1),
			runs: z.array(IdSchema).min(2),
			assessment: z.string().min(1),
		})
		.nullable(),
	notes: z.array(z.string()),
	evidence: z.array(EvidenceSchema),
	children: z.array(z.lazy(() => z.union([RunSchema, GroupSchema]))),
});
export const BenchmarkLogSchema = z.strictObject({
	schemaVersion: z.literal(1),
	updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	migration: z.array(z.string()),
	tree: GroupSchema,
});

export const runs = (entry: Entry): Run[] =>
	entry.kind === "run" ? [entry] : entry.children.flatMap(runs);
export function validate(input: unknown): Group {
	const tree = GroupSchema.parse(input),
		ids = new Set<string>(),
		documents = new Set<string>();
	const all = runs(tree),
		byId = new Map(all.map((run) => [run.id, run]));
	const walk = (entry: Entry) => {
		if (ids.has(entry.id)) throw Error(`Duplicate benchmark id: ${entry.id}`);
		ids.add(entry.id);
		if (entry.kind === "run") {
			if (
				entry.runType === "judge-replay" &&
				(entry.independent ||
					(entry.producer !== null &&
						(entry.producer === entry.id || !byId.has(entry.producer))))
			)
				throw Error(
					`Judge replay has an invalid producer or independent-attempt claim: ${entry.id}`,
				);
			if (
				entry.runType === "continuation" &&
				(!entry.continues || !byId.has(entry.continues) || entry.independent)
			)
				throw Error(
					`Continuation must reference its prior attempt: ${entry.id}`,
				);
			for (const [passed, total] of [
				[entry.quality.targetsPassed, entry.quality.targetsTotal],
				[entry.quality.regressionsPassed, entry.quality.regressionsTotal],
			])
				if (passed !== null && total !== null && passed > total)
					throw Error(`Invalid quality counts: ${entry.id}`);
			return;
		}
		if (documents.has(entry.document))
			throw Error(`Duplicate node document: ${entry.document}`);
		documents.add(entry.document);
		if (entry.winner) {
			const evidence = entry.winner.runs.map((id) => byId.get(id));
			const protocol = evidence[0]?.protocolSha256;
			const descendants = new Set(runs(entry).map((run) => run.id));
			if (
				new Set(entry.winner.runs).size !== entry.winner.runs.length ||
				entry.winner.runs.some((id) => !descendants.has(id))
			)
				throw Error(`Winner borrows or duplicates evidence: ${entry.id}`);
			if (
				!protocol ||
				evidence.some(
					(run) =>
						run?.runType !== "attempt" ||
						!run.independent ||
						run.outcome !== "pass" ||
						run.quality.accepted !== true ||
						run.protocolSha256 !== protocol,
				) ||
				new Set(evidence.map((run) => run?.arm)).size < 2 ||
				!evidence.some((run) => run?.arm === entry.winner?.arm)
			)
				throw Error(`Winner lacks matched quality evidence: ${entry.id}`);
			const eligible = runs(entry).filter(
				(run) =>
					run.runType === "attempt" &&
					run.independent &&
					run.protocolSha256 === protocol,
			);
			if (eligible.some((run) => !entry.winner?.runs.includes(run.id)))
				throw Error(`Winner omits matched attempts: ${entry.id}`);
		}
		entry.children.forEach(walk);
	};
	walk(tree);
	return tree;
}
export function summarize(entry: Entry) {
	const leaves = runs(entry),
		groups: Group[] = [];
	const visit = (node: Entry) => {
		if (node.kind === "group") {
			groups.push(node);
			node.children.forEach(visit);
		}
	};
	visit(entry);
	const complete = groups.every((group) => group.coverage === "complete"),
		unknownOutcomes = leaves.filter((run) =>
			["incomplete", "unknown"].includes(run.outcome),
		).length;
	const knownFailures = leaves.filter((run) => run.outcome === "fail").length;
	return {
		totalRuns: complete ? leaves.length : null,
		totalFailures: complete && !unknownOutcomes ? knownFailures : null,
		loggedRuns: leaves.length,
		knownFailures,
		unknownOutcomes,
		attempts: leaves.filter(
			(run) => run.runType === "attempt" && run.independent,
		).length,
		continuations: leaves.filter((run) => run.runType === "continuation")
			.length,
		judgeReplays: leaves.filter((run) => run.runType === "judge-replay").length,
	};
}
const cell = (value: string | number | null) =>
	value === null
		? "unknown"
		: String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const count = (total: number | null, known: number, label: string) =>
	total === null
		? known
			? `unknown (${known} ${label})`
			: "unknown"
		: String(total);
const link = (from: string, target: string) =>
	/^https:\/\//.test(target)
		? target
		: "../".repeat(from.split("/").length - 1) + target;
export function renderSummary(tree: Group) {
	const rows = tree.children.map((entry) => {
		if (entry.kind !== "group")
			throw Error("Top-level benchmark entries must be nodes");
		const stats = summarize(entry);
		return `| [${cell(entry.title)}](${entry.document}) | ${cell(entry.winner?.arm ?? null)} | ${count(stats.totalRuns, stats.loggedRuns, "logged")} | ${count(stats.totalFailures, stats.knownFailures, "known")} |`;
	});
	return [
		"| Benchmark | Winner | Total runs | Total failures |",
		"| --- | --- | ---: | ---: |",
		...rows,
		"",
	].join("\n");
}
export function renderNode(node: Group) {
	const stats = summarize(node),
		lines = [
			`# ${node.title}`,
			"",
			...node.notes.flatMap((note) => [note, ""]),
			`Logged runs: ${stats.loggedRuns}; independent attempts: ${stats.attempts}; continuations: ${stats.continuations}; judge replays: ${stats.judgeReplays}; known failures: ${stats.knownFailures}; unknown/incomplete outcomes: ${stats.unknownOutcomes}.`,
			"",
			`Winner: ${node.winner?.arm ?? "unknown; no qualified matched winner claimed"}.`,
			"",
		];
	for (const evidence of node.evidence)
		lines.push(
			`[${evidence.label}](${link(node.document, evidence.href)})${evidence.sha256 ? ` — SHA-256 \`${evidence.sha256}\`` : ""} (${evidence.availability}).`,
			"",
		);
	for (const entry of node.children) {
		if (entry.kind === "group") {
			const s = summarize(entry);
			lines.push(
				`- [${entry.title}](${link(node.document, entry.document)}): ${count(s.totalRuns, s.loggedRuns, "logged")} runs; ${count(s.totalFailures, s.knownFailures, "known")} failures.`,
				"",
			);
			continue;
		}
		const m = entry.metrics,
			q = entry.quality;
		lines.push(
			`## ${entry.id}`,
			"",
			`${cell(entry.title)} — **${entry.outcome}**; ${entry.runType}; arm \`${cell(entry.arm)}\`.`,
			"",
			`Wall: ${cell(m.wallSeconds)} s (${cell(m.wallBasis)}); tokens: ${cell(m.totalTokens)}; model requests: ${cell(m.modelRequests)}; tool calls: ${cell(m.toolCalls)}. Targets: ${cell(q.targetsPassed)}/${cell(q.targetsTotal)}; regressions: ${cell(q.regressionsPassed)}/${cell(q.regressionsTotal)}.`,
			"",
		);
		if (entry.producer || entry.continues)
			lines.push(
				`Related run: \`${entry.producer ?? entry.continues}\`; this is not another independent reliability attempt.`,
				"",
			);
		for (const note of entry.notes) lines.push(note, "");
		for (const evidence of entry.evidence)
			lines.push(
				`[${evidence.label}](${link(node.document, evidence.href)})${evidence.sha256 ? ` — SHA-256 \`${evidence.sha256}\`` : ""} (${evidence.availability}).`,
				"",
			);
	}
	return lines.join("\n");
}

export async function benchmarkLog(
	mode: "check" | "render",
	directory: string,
) {
	const fs = await import("node:fs/promises"),
		path = await import("node:path");
	const root = await fs.realpath(directory),
		bytes = await fs.readFile(path.join(root, "benchmarks.json5"));
	if (bytes.length > 4 * 1024 * 1024)
		throw Error("Benchmark log exceeds 4 MiB");
	const log = BenchmarkLogSchema.parse(Bun.JSON5.parse(bytes.toString("utf8"))),
		tree = validate(log.tree);
	const references = (node: Entry): Evidence[] => [
		...node.evidence,
		...(node.kind === "group" ? node.children.flatMap(references) : []),
	];
	const { createHash } = await import("node:crypto");
	for (const evidence of references(tree)) {
		if (evidence.href.startsWith("https://")) {
			const url = new URL(evidence.href);
			if (url.username || url.password || url.search)
				throw Error("Credential-bearing/ambiguous evidence URL refused");
			continue;
		}
		const name = evidence.href.split("#")[0];
		if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/.test(name))
			throw Error("Unsafe benchmark evidence path");
		const actual = await fs.realpath(path.join(root, name));
		if (!actual.startsWith(`${root}/`))
			throw Error("Benchmark evidence escaped root");
		if (
			evidence.availability === "committed" &&
			evidence.sha256 &&
			createHash("sha256")
				.update(await fs.readFile(actual))
				.digest("hex") !== evidence.sha256
		)
			throw Error(`Committed evidence hash mismatch: ${name}`);
	}
	const outputs = new Map<string, string>([
		["benchmark.md", renderSummary(tree)],
	]);
	const walk = (node: Group) => {
		for (const child of node.children)
			if (child.kind === "group") {
				outputs.set(child.document, renderNode(child));
				walk(child);
			}
	};
	walk(tree);
	for (const [name, text] of outputs) {
		const target = path.join(root, name);
		if (mode === "render")
			await fs.mkdir(path.dirname(target), { recursive: true });
		const parent = await fs.realpath(path.dirname(target));
		if (parent !== root && !parent.startsWith(`${root}/`))
			throw Error("Benchmark output escaped root");
		const existing = await fs.lstat(target).catch(() => undefined);
		if (existing && !existing.isFile())
			throw Error("Benchmark output is not a regular file");
		if (mode === "render") await fs.writeFile(target, text);
		else if ((await fs.readFile(target, "utf8")) !== text)
			throw Error(`Benchmark Markdown out of sync: ${name}`);
	}
	return summarize(tree);
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode !== "check" && mode !== "render")
		throw Error("Usage: benchmark-log.ts check|render [benchmark-directory]");
	const { fileURLToPath } = await import("node:url");
	console.log(
		JSON.stringify(
			await benchmarkLog(
				mode,
				process.argv[3] ??
					fileURLToPath(new URL("../../../benchmarks/", import.meta.url)),
			),
		),
	);
}
