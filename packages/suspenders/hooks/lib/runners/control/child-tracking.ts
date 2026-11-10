// child-tracking.ts — W2973.2: per-child and per-parent tracking on top of
// the W2973.1 admission ledger. Attribution is copied from the intent, so
// admission stays the single source; every write is idempotent with drift
// refusal — the same (parent, child) ran once, once is truth.
import { z } from "zod";
import { ChildIntentSchema, deriveChildRunId } from "./child-admission.ts";
import type { RunnerActor } from "./rights.ts";
import type { RunnerController } from "./controller.ts";
import type { RunnerStore } from "./store.ts";

const ChildResultStateSchema = z.enum(["done", "failed", "aborted"]);
const ChildTokensSchema = z.strictObject({
	in: z.number().int().min(0),
	out: z.number().int().min(0),
	cached: z.number().int().min(0),
});
const ChildArtifactSchema = z.strictObject({
	path: z.string().min(1).max(500),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	bytes: z.number().int().min(0),
});

export const ChildResultSchema = z.strictObject({
	version: z.literal(1),
	runId: z.uuid(),
	parentRunId: z.uuid(),
	childKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
	state: ChildResultStateSchema,
	at: z.number().int().positive(),
	reason: z.string().min(1).max(2000).optional(),
	tokens: ChildTokensSchema,
	artifacts: z.array(ChildArtifactSchema),
	provider: z.string().min(1).max(120),
	model: z.string().min(1).max(200),
});

export type ChildResult = z.infer<typeof ChildResultSchema>;

const RESULTS_DDL = `CREATE TABLE IF NOT EXISTS runner_child_results (
	parent_run_id TEXT NOT NULL,
	child_key TEXT NOT NULL,
	run_id TEXT NOT NULL,
	result_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (parent_run_id, child_key)
)`;

function ensureResults(store: RunnerStore): void {
	store.run(RESULTS_DDL);
}

export function readResults(
	store: RunnerStore,
	parentRunId: string,
): ChildResult[] {
	ensureResults(store);
	const rows = store.all<{ result_json: string }>(
		`SELECT result_json FROM runner_child_results WHERE parent_run_id = ? ORDER BY created_at, child_key`,
		parentRunId,
	);
	return rows.map((row) =>
		ChildResultSchema.parse(JSON.parse(row.result_json)),
	);
}

export function readIntentKeys(
	store: RunnerStore,
	parentRunId: string,
): string[] {
	return store
		.all<{ child_key: string }>(
			`SELECT child_key FROM runner_child_intents WHERE parent_run_id = ? ORDER BY created_at, child_key`,
			parentRunId,
		)
		.map((row) => row.child_key);
}

export type CompleteInput = {
	parentRunId: string;
	childKey: string;
	state: z.infer<typeof ChildResultStateSchema>;
	at: number;
	tokens: z.infer<typeof ChildTokensSchema>;
	artifacts?: z.infer<typeof ChildArtifactSchema>[];
	reason?: string;
};

function readIntent(
	store: RunnerStore,
	parentRunId: string,
	childKey: string,
): z.infer<typeof ChildIntentSchema> {
	const row = store.get<{ intent_json: string }>(
		"SELECT intent_json FROM runner_child_intents WHERE parent_run_id = ? AND child_key = ?",
		parentRunId,
		childKey,
	);
	if (row === null) {
		throw new Error(
			"runner: no admitted child intent for this (parent, child) — completion rides admission",
		);
	}
	return ChildIntentSchema.parse(JSON.parse(row.intent_json));
}

function buildChildResult(
	store: RunnerStore,
	input: CompleteInput,
): ChildResult {
	const intent = readIntent(store, input.parentRunId, input.childKey);
	return {
		version: 1,
		runId: deriveChildRunId(input.parentRunId, input.childKey),
		parentRunId: input.parentRunId,
		childKey: input.childKey,
		state: input.state,
		at: input.at,
		...(input.reason === undefined ? {} : { reason: input.reason }),
		tokens: input.tokens,
		artifacts: input.artifacts ?? [],
		provider: intent.route.provider,
		model: intent.route.model,
	};
}

export async function completeChildRun(
	store: RunnerStore,
	input: CompleteInput,
): Promise<{ replayed: boolean }> {
	ensureResults(store);
	const result = buildChildResult(store, input);
	const stored = store.get<{ result_json: string }>(
		"SELECT result_json FROM runner_child_results WHERE parent_run_id = ? AND child_key = ?",
		input.parentRunId,
		input.childKey,
	);
	if (stored !== null) {
		const prior = ChildResultSchema.parse(JSON.parse(stored.result_json));
		if (JSON.stringify(prior) !== JSON.stringify(result)) {
			throw new Error(
				"runner: child result drift — the same (parent, child) must replay an identical result",
			);
		}
		return { replayed: true };
	}
	store.run(
		"INSERT INTO runner_child_results (parent_run_id, child_key, run_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
		input.parentRunId,
		input.childKey,
		result.runId,
		JSON.stringify(result),
		input.at,
	);
	return { replayed: false };
}

export async function cancelChildRun(
	deps: {
		store: RunnerStore;
		controller: Pick<RunnerController, "abort">;
		actor: RunnerActor;
	},
	input: { parentRunId: string; childKey: string; at: number; reason?: string },
): Promise<{ replayed: boolean }> {
	const runId = deriveChildRunId(input.parentRunId, input.childKey);
	// The abort is best-effort: the controller refuses the transition when the
	// child never launched or is already stopping — the recorded result, not
	// the abort outcome, is the truth carrier for the cancellation.
	try {
		await deps.controller.abort({ runId, actor: deps.actor });
	} catch {
		// already terminal or never started — the receipt below still records
	}
	return completeChildRun(deps.store, {
		parentRunId: input.parentRunId,
		childKey: input.childKey,
		state: "aborted",
		at: input.at,
		tokens: { in: 0, out: 0, cached: 0 },
		reason: input.reason ?? "cancelled by supervisor",
	});
}

export interface ParentJoin {
	joined: boolean;
	children: string[];
	terminal: string[];
	outstanding: string[];
}

export function parentJoin(
	store: RunnerStore,
	parentRunId: string,
): ParentJoin {
	const children = readIntentKeys(store, parentRunId);
	const done = new Set(readResults(store, parentRunId).map((r) => r.childKey));
	const outstanding = children.filter((key) => !done.has(key));
	return {
		joined: outstanding.length === 0,
		children,
		terminal: children.filter((key) => done.has(key)),
		outstanding,
	};
}

export interface AttributionRow {
	provider: string;
	model: string;
	children: number;
	tokens: {
		in: number;
		out: number;
		cached: number;
	};
}

export function parentAttribution(
	store: RunnerStore,
	parentRunId: string,
): AttributionRow[] {
	const grouped = new Map<string, AttributionRow>();
	for (const result of readResults(store, parentRunId)) {
		const slot = `${result.provider}/${result.model}`;
		const row = grouped.get(slot) ?? {
			provider: result.provider,
			model: result.model,
			children: 0,
			tokens: { in: 0, out: 0, cached: 0 },
		};
		row.children += 1;
		row.tokens.in += result.tokens.in;
		row.tokens.out += result.tokens.out;
		row.tokens.cached += result.tokens.cached;
		grouped.set(slot, row);
	}
	return [...grouped.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([, row]) => row);
}

export interface ParentSpend {
	children: number;
	tokens: {
		in: number;
		out: number;
		cached: number;
	};
}

export function parentSpend(
	store: RunnerStore,
	parentRunId: string,
): ParentSpend {
	const spend = { children: 0, tokens: { in: 0, out: 0, cached: 0 } };
	for (const result of readResults(store, parentRunId)) {
		spend.children += 1;
		spend.tokens.in += result.tokens.in;
		spend.tokens.out += result.tokens.out;
		spend.tokens.cached += result.tokens.cached;
	}
	return spend;
}

export function assertBudget(
	store: RunnerStore,
	input: { parentRunId: string; maxTokens: number },
): { spend: ParentSpend } {
	const spend = parentSpend(store, input.parentRunId);
	const total = spend.tokens.in + spend.tokens.out;
	if (total >= input.maxTokens) {
		throw new Error(
			`runner: parent ${input.parentRunId} has reached the delegated budget (${total} >= ${input.maxTokens} tokens)`,
		);
	}
	return { spend };
}
