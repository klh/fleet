// A bounded, content-free request trace for Board orchestration. The trace id
// follows W3C Trace Context's 16-byte form; only service/model metadata is
// stored here, never goals, prompts, model output, credentials, or file refs.
import { db } from "./context.ts";
import { projectIdentity, projectRootOf } from "../lib/govdb/govdb.ts";

export interface OrchTraceStep {
	traceId: string;
	at: number;
	phase: string;
	service: string;
	status: "ok" | "error";
	model?: string;
	endpoint?: string;
	ms?: number;
	inputTokens?: number;
	outputTokens?: number;
}

const keyOf = (project: string): string =>
	projectIdentity(projectRootOf(project));
export const newOrchTraceId = (): string =>
	crypto.randomUUID().replaceAll("-", "");

/** A child span for an outbound model call; no baggage or user content. */
export const orchTraceparent = (traceId: string): string =>
	`00-${traceId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`;

export function recordOrchStep(project: string, step: OrchTraceStep): void {
	try {
		const key = keyOf(project);
		const seq = (
			db
				.query(
					"SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM orchestrate_traces WHERE trace_id = ?",
				)
				.get(step.traceId) as { next: number }
		).next;
		if (seq > 32) return;
		db.query(
			"INSERT INTO orchestrate_traces (trace_id,seq,project,at,phase,service,status,model,endpoint,duration_ms,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			step.traceId,
			seq,
			key,
			step.at,
			step.phase,
			step.service,
			step.status,
			step.model ?? null,
			step.endpoint ?? null,
			step.ms ?? null,
			step.inputTokens ?? null,
			step.outputTokens ?? null,
		);
	} catch (error) {
		// Tracing must not stop registration when a hub store is upgrading.
		console.error(
			`orchestrate trace unavailable: ${String(error).slice(0, 160)}`,
		);
	}
}

export function linkedOrchWork(
	project: string,
	traceId: string,
): string | null {
	try {
		const row = db
			.query(
				"SELECT work_id FROM orchestrate_traces WHERE trace_id = ? AND project = ? AND work_id IS NOT NULL LIMIT 1",
			)
			.get(traceId, keyOf(project)) as { work_id: string } | null;
		return row?.work_id ?? null;
	} catch {
		return null;
	}
}

export function linkOrchWork(
	project: string,
	traceId: string,
	workId: string,
): void {
	try {
		db.query(
			"UPDATE orchestrate_traces SET work_id = ? WHERE trace_id = ? AND project = ? AND work_id IS NULL",
		).run(workId, traceId, keyOf(project));
	} catch (error) {
		console.error(
			`orchestrate trace link unavailable: ${String(error).slice(0, 160)}`,
		);
	}
}

/** A child inherits its plan parent's creation trace. */
export function traceForWork(
	project: string,
	workId: string,
	parentId: string | null,
): OrchTraceStep[] {
	try {
		return db
			.query(
				"SELECT trace_id AS traceId,at,phase,service,status,model,endpoint,duration_ms AS ms,input_tokens AS inputTokens,output_tokens AS outputTokens FROM orchestrate_traces WHERE project = ? AND work_id IN (?, ?) ORDER BY at,seq LIMIT 64",
			)
			.all(project, workId, parentId ?? workId) as OrchTraceStep[];
	} catch {
		return [];
	}
}
