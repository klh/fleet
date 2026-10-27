// select-models.ts — W1030.3 vertical slice: ONE real selection case —
// stated task requirements → compatible models through the shared
// ModelCapabilityRecord contract (W1030.1) with the W1030.7 freshness gate.
// A stated requirement is must-grade: only a FRESH fact can satisfy it —
// unknown or expired = incompatible (the contract's own conservative law:
// never-measured is not fast, unknown is not compatible). Unstated
// requirements never exclude. Ranking is fact-driven only: locality
// preference, then cheaper priced input cost. Quality/speed scoring
// ABSTAINS honestly: measured route performance is W1030.2's missing API —
// when it lands it plugs in here; no benchmark is fabricated (parent law).
// Zero LLM, zero network: pure functions over registry facts.
//
//	Roles: selectModels() = pure selector · main() = CLI over the real
//	snapshot (bun bin/select-models.ts --tools --min-context 32000 ...)
import {
	currentCapability,
	defaultCapabilitySnapshotPath,
	readCapabilitySnapshot,
	type CapabilityRegistry,
	type ModelCapabilityRecord,
} from "./model-capabilities.ts";
import { scoreComplexity, type ComplexityScore } from "./router-core.ts";

// ─── requirements (stated = must-grade) ───
export type Locality = "local" | "remote";

export interface TaskRequirements {
	tools?: boolean; // model must expose tool calling
	structuredOutput?: boolean; // model must expose structured output
	minContextTokens?: number; // context window at least this many tokens
	inputModalities?: string[]; // every listed input modality required
	/** must-grade cost ceiling on input price (USD/1M tokens). Verifiable
	 *  prices only: "free"/"local-unpriced" satisfy trivially; "priced"
	 *  compares the number; "included-unreported"/"unknown" cannot verify
	 *  a ceiling and are excluded, never assumed compliant. */
	maxInputUsdPerMillion?: number;
	/** prefer-grade locality: matching records rank first, others stay as
	 *  fallbacks. Absent = no placement preference. */
	locality?: Locality;
	/** Classified by the PRESERVED Belt router classifier (router-core.ts)
	 *  when task text is given — reported verbatim, never a fabricated
	 *  model mapping on top of it. */
	complexityText?: string;
	/** Freshness gate (caller policy, W1030.7 contract). */
	maxAgeMs: number;
}

export interface ModelChoice {
	provider: string;
	modelId: string;
	locality: "local" | "remote";
	/** input price the ranking saw (USD/1M); null = unpriced/local. */
	inputUsdPerMillion: number | null;
	/** one honest sentence naming the facts that decided it. */
	reason: string;
}

export interface SelectionResult {
	complexity: ComplexityScore | null; // echo of the preserved classifier
	selected: ModelChoice[]; // ranked: [0] = the choice, rest = fallbacks
	seen: number; // records the selector read
	why: string; // one line: what decided (or refused) the selection
}

// ─── must-grade compatibility (fresh facts only) ───
const satisfiesTools = (
	record: ModelCapabilityRecord,
	req: TaskRequirements,
): boolean => req.tools !== true || record.tools.value === true;

const satisfiesStructuredOutput = (
	record: ModelCapabilityRecord,
	req: TaskRequirements,
): boolean =>
	req.structuredOutput !== true || record.structuredOutput.value === true;

const satisfiesContext = (
	record: ModelCapabilityRecord,
	req: TaskRequirements,
): boolean =>
	req.minContextTokens === undefined ||
	(record.contextTokens.value !== null &&
		record.contextTokens.value >= req.minContextTokens);

const satisfiesModalities = (
	record: ModelCapabilityRecord,
	req: TaskRequirements,
): boolean =>
	req.inputModalities === undefined ||
	(record.inputModalities.value !== null &&
		req.inputModalities.every((m) =>
			record.inputModalities.value?.includes(m),
		));

const satisfiesCost = (
	record: ModelCapabilityRecord,
	req: TaskRequirements,
): boolean => {
	if (req.maxInputUsdPerMillion === undefined) return true;
	const price = record.cost.value;
	if (price === null) return false; // cannot verify a ceiling → not compatible
	if (price.status === "free" || price.status === "local-unpriced") return true;
	if (price.status !== "priced") return false; // unreported/unknown: never assumed
	return (
		price.inputUsdPerMillion !== null &&
		price.inputUsdPerMillion <= req.maxInputUsdPerMillion
	);
};

const COMPAT_CHECKS = [
	satisfiesTools,
	satisfiesStructuredOutput,
	satisfiesContext,
	satisfiesModalities,
	satisfiesCost,
];

// ─── ranking: locality preference, then cheaper priced input cost ───
const inputPrice = (c: ModelChoice): number | null => c.inputUsdPerMillion;

const compareChoices = (a: ModelChoice, b: ModelChoice): number => {
	const priceA = inputPrice(a);
	const priceB = inputPrice(b);
	// priced records rank by ascending input cost; unpriced sort after
	if (priceA !== null && priceB !== null && priceA !== priceB)
		return priceA - priceB;
	if ((priceA === null) !== (priceB === null)) return priceA === null ? 1 : -1;
	return `${a.provider}/${a.modelId}`.localeCompare(
		`${b.provider}/${b.modelId}`,
	);
};

const rankChoices = (
	compatible: ModelChoice[],
	locality: Locality | undefined,
): ModelChoice[] =>
	[...compatible].sort((a, b) => {
		if (locality && a.locality !== b.locality)
			return a.locality === locality ? -1 : 1;
		return compareChoices(a, b);
	});

// ─── the selector ───
export function selectModels(
	req: TaskRequirements,
	registry: CapabilityRegistry,
	now = Date.now(),
): SelectionResult {
	const complexity = req.complexityText
		? scoreComplexity(req.complexityText)
		: null;
	const compatible: ModelChoice[] = [];
	for (const raw of registry.all()) {
		// W1030.7 freshness gate first: expired facts read as unknown, and an
		// unknown fact cannot satisfy a stated must.
		const record = currentCapability(raw, req.maxAgeMs, now);
		if (
			COMPAT_CHECKS.every((check) => check(record, req)) &&
			record.locality.value !== null // placement must be known to be selectable
		)
			compatible.push({
				provider: record.provider,
				modelId: record.modelId,
				locality: record.locality.value,
				inputUsdPerMillion:
					record.cost.value?.status === "priced"
						? record.cost.value.inputUsdPerMillion
						: null,
				reason: reasonFor(record, req, now),
			});
	}
	const selected = rankChoices(compatible, req.locality);
	const why =
		selected.length === 0
			? noFitWhy(req)
			: `${String(selected.length)} compatible record(s); head ${selected[0].provider}/${selected[0].modelId} — ${selected[0].reason}`;
	return { complexity, selected, seen: registry.all().length, why };
}

// ─── reasons ───
const ageOf = (observedAt: string | null, now: number): number | null => {
	const ms = observedAt === null ? Number.NaN : Date.parse(observedAt);
	return Number.isFinite(ms) ? now - ms : null;
};

const ageText = (ms: number): string =>
	ms < 60_000
		? "just now"
		: ms < 3_600_000
			? `${String(Math.round(ms / 60_000))}m ago`
			: `${String(Math.round(ms / 3_600_000))}h ago`;

const MODALITY_JOIN = ", ";

function reasonFor(
	record: ModelCapabilityRecord,
	_req: TaskRequirements,
	now: number,
): string {
	const parts: string[] = [];
	const age = ageOf(record.locality.observedAt, now);
	const source = record.locality.source ?? "unknown source";
	parts.push(
		`${record.locality.value} via ${source}${age === null ? "" : `, observed ${ageText(age)}`}`,
	);
	if (record.contextTokens.value !== null)
		parts.push(`${String(record.contextTokens.value)} ctx`);
	if (record.tools.value === true) parts.push("tools");
	if (record.structuredOutput.value === true) parts.push("structured_output");
	const price = record.cost.value;
	if (price?.status === "priced" && price.inputUsdPerMillion !== null)
		parts.push(`$${String(price.inputUsdPerMillion)}/1M in`);
	if (price?.status === "free") parts.push("free");
	return parts.join("; ");
}

// ─── honest refusals (the negative face) ───
const noFitWhy = (req: TaskRequirements): string => {
	const stated: string[] = [];
	if (req.tools === true) stated.push("tools");
	if (req.structuredOutput === true) stated.push("structured_output");
	if (req.minContextTokens !== undefined)
		stated.push(`context >= ${String(req.minContextTokens)}`);
	if (req.inputModalities !== undefined)
		stated.push(`input: ${req.inputModalities.join(MODALITY_JOIN)}`);
	if (req.maxInputUsdPerMillion !== undefined)
		stated.push(`input price <= $${String(req.maxInputUsdPerMillion)}/1M`);
	return `no record satisfies the stated requirements (${stated.join(", ") || "locality known"}) — refusing rather than substituting`;
};

// ─── CLI over the real snapshot (the vertical slice's live face) ───
const numArg = (argv: string[], flag: string): number | undefined => {
	const i = argv.indexOf(flag);
	if (i < 0) return undefined;
	const v = argv[i + 1];
	return v === undefined ? undefined : Number(v);
};

const boolArg = (argv: string[], flag: string): boolean => argv.includes(flag);

const listArg = (argv: string[], flag: string): string[] | undefined => {
	const i = argv.indexOf(flag);
	if (i < 0) return undefined; // -1 + 1 = 0 would eat argv[0] as a value
	const v = argv[i + 1];
	return v === undefined ? undefined : v.split(",");
};

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (boolArg(argv, "--help") || argv.length === 0) {
		console.log(
			"select-models — requirement-gated model selection over the capability snapshot\n\n" +
				"  bun bin/select-models.ts [--tools] [--structured-output]\n" +
				"    [--min-context N] [--max-cost-usd N] [--input-modality a,b]\n" +
				'    [--locality local|remote] [--complexity-text "..."]\n' +
				"    [--max-age-hours N (default 24)] [--json]\n\n" +
				"Reads the shared capability snapshot (defaultCapabilitySnapshotPath).",
		);
		process.exit(0);
	}
	const req: TaskRequirements = {
		tools: boolArg(argv, "--tools") || undefined,
		structuredOutput: boolArg(argv, "--structured-output") || undefined,
		minContextTokens: numArg(argv, "--min-context"),
		inputModalities: listArg(argv, "--input-modality"),
		maxInputUsdPerMillion: numArg(argv, "--max-cost-usd"),
		locality: argv.includes("--locality")
			? (argv[argv.indexOf("--locality") + 1] as "local" | "remote")
			: undefined,
		complexityText: argv.includes("--complexity-text")
			? argv[argv.indexOf("--complexity-text") + 1]
			: undefined,
		maxAgeMs: (numArg(argv, "--max-age-hours") ?? 24) * 3_600_000,
	};
	const snapshotPath = defaultCapabilitySnapshotPath();
	const loaded = await readCapabilitySnapshot(snapshotPath);
	if (loaded.state !== "available") {
		console.error(
			`select-models: capability snapshot ${loaded.state} at ${snapshotPath} — run the W1030.1 collector first`,
		);
		process.exit(1);
	}
	const result = selectModels(req, loaded.registry);
	if (boolArg(argv, "--json")) {
		console.log(JSON.stringify({ ...result, snapshotPath }, null, "\t"));
	} else {
		console.log(`why: ${result.why}`);
		for (const [i, c] of result.selected.slice(0, 10).entries())
			console.log(
				`${String(i).padStart(2)}. ${c.provider}/${c.modelId} [${c.locality}] — ${c.reason}`,
			);
	}
	process.exit(0);
}
