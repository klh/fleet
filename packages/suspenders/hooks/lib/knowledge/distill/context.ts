// distill/context.ts — what every job unit receives. One context per run;
// units never hold state between calls beyond what they wrote to the db.
import type { Database } from "bun:sqlite";
import type { DistillClients } from "./clients.ts";
import type { DistillConfig } from "./config.ts";
import type { Picked } from "./visits.ts";
import type { DistillSink } from "./sink.ts";
import type { VectorIndex } from "./vectors.ts";

export interface JobContext {
	db: Database;
	cfg: DistillConfig;
	clients: DistillClients;
	sink: DistillSink;
	/** read-only decant.db handle; null = the source is skipped */
	decant: Database | null;
	vectors: VectorIndex;
	now: () => number;
	/** LLM token spend gate: throws BudgetExhausted when the day is spent */
	spend: {
		check(): void;
		add(tokens: number): void;
	};
}

export interface UnitResult {
	outcome: string;
	tokens?: number;
}

export type Unit = (ctx: JobContext, node: Picked) => Promise<UnitResult>;

/** Optional batch hook (e.g. one batched embeddings call per batch). */
export type Prepare = (ctx: JobContext, batch: Picked[]) => Promise<void>;

export class BudgetExhausted extends Error {}
