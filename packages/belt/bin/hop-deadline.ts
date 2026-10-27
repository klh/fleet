// hop-deadline.ts — W1117: belt's consume-side of the shared W1086 hop
// contract. Belt CLAMPS its own local budget to an inherited absolute
// deadline; it never re-roots a fresh timer at this hop (owner law:
// Buckle→Belt→Buckle return keeps the ORIGINAL deadline). Absent/invalid
// headers keep the safe bounded default — a client can never EXTEND belt's
// budget by withholding or forging a contract.
import {
	HOP_CONTRACT_HEADER,
	parseHopContract,
	type HopContractParse,
} from "../../telemetry/src/hop-contract.ts";

/** Local budgets (Buckle-parity): whole-exchange cap for non-stream
 *  exchanges, stream-total for SSE bodies. */
export const ROUTER_EXCHANGE_MS = 120_000;
export const ROUTER_STREAM_TOTAL_MS = 900_000;

export type InheritedDeadline = {
	/** The effective absolute deadline for this hop. */
	deadlineMs: number;
	/** Where the deadline came from (routing-note provenance). */
	source: "hop-contract" | "local-default";
	/** The parsed contract when present (budget/path for the ladder). */
	contract?: Extract<HopContractParse, { status: "ok" }>;
};

/** Consume the inbound x-klh-hop-contract (or fall back to the local
 *  default). An expired contract is a verdict, not a clamp: the caller
 *  answers 504 immediately — a deadline in the past is never re-based
 *  forward. */
export function inheritDeadline(
	headerValue: string | null | undefined,
	stream: boolean,
	now = Date.now(),
	/** The receiver's policy ceiling — a caller with its own bounded default
	 *  (e.g. MCP's BELT_MCP_REQUEST_MS) passes it here; the clamp is min(). */
	localDefaultMs = stream ? ROUTER_STREAM_TOTAL_MS : ROUTER_EXCHANGE_MS,
): InheritedDeadline | "expired" {
	const parsed = parseHopContract(headerValue, now);
	if (parsed.status === "expired") return "expired";
	if (parsed.status !== "ok")
		return { deadlineMs: now + localDefaultMs, source: "local-default" };
	return {
		deadlineMs: Math.min(now + localDefaultMs, parsed.deadlineMs),
		source: "hop-contract",
		contract: parsed,
	};
}

export { HOP_CONTRACT_HEADER };
