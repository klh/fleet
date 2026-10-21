// W1086 hop contract: one bounded wire header (x-klh-hop-contract) that
// carries a request's absolute deadline, remaining attempt budget and the
// visited rung path across Fleet hops — so a Belt→Buckle→Belt→Buckle return
// leg keeps the ORIGINAL deadline/budget/trace, never re-roots. Correlation
// and budget semantics only: this is not authz, not a credential, and never
// carries request text. Amendment W1118: deadline is 13-digit strict; a
// deadline already in the past parses as EXPIRED (the caller answers 504
// immediately — no min() clamp on the past).
import { createHash } from "node:crypto";

export const HOP_CONTRACT_HEADER = "x-klh-hop-contract";

const HEADER =
	/^v=1;deadline=(\d{13});budget=(\d{1,2});path=([0-9a-f]{16}(?:,[0-9a-f]{16}){0,63})?$/;
const MAX_HEADER_LENGTH = 512;
const MAX_PATH_RUNGS = 64;

/** The parsed contract: `expired` is a distinct verdict — an absolute
 *  deadline in the past is answered 504 at the receiving hop, never
 *  clamped forward. */
export type HopContractParse =
	| {
			status: "ok";
			deadlineMs: number;
			budget: number;
			/** Visited rung ids in traversal order (empty when absent). */
			path: string[];
	  }
	| { status: "expired"; deadlineMs: number }
	| { status: "invalid" };

/** Encode a contract value; rejects out-of-band fields rather than
 *  emitting them (prefer-header precedent). */
export function encodeHopContract(c: {
	deadlineMs: number;
	budget: number;
	path?: string[];
}): string | null {
	if (
		!Number.isSafeInteger(c.deadlineMs) ||
		c.deadlineMs < 0 ||
		c.deadlineMs > 9_999_999_999_999
	)
		return null;
	if (!Number.isSafeInteger(c.budget) || c.budget < 0 || c.budget > 99)
		return null;
	const path = c.path ?? [];
	if (path.length > MAX_PATH_RUNGS) return null;
	for (const rung of path) if (!/^[0-9a-f]{16}$/.test(rung)) return null;
	const value = `v=1;deadline=${c.deadlineMs};budget=${c.budget};path=${path.join(",")}`;
	return value.length <= MAX_HEADER_LENGTH && HEADER.test(value) ? value : null;
}

/** Strict parse of an untrusted inbound header: every field clamped by the
 *  grammar, anything else (wrong version, bad shapes, >512 chars) rejected
 *  WHOLE — a partial contract never rides on. */
export function parseHopContract(
	value: string | null | undefined,
	now: number,
): HopContractParse {
	if (!value || value.length > MAX_HEADER_LENGTH) return { status: "invalid" };
	const m = HEADER.exec(value);
	if (!m) return { status: "invalid" };
	const deadlineMs = Number(m[1]);
	if (deadlineMs < now) return { status: "expired", deadlineMs };
	return {
		status: "ok",
		deadlineMs,
		budget: Number(m[2]),
		path: m[3] ? m[3].split(",") : [],
	};
}

/** The rung id BOTH sides derive for one route leg: sha256 of the candIdOf
 *  shape (`host:port:model`, port defaulted by protocol), first 16 hex.
 *  Attempt ordinals are NOT part of the id — a retry of the same rung is
 *  the same rung, so the visited check cannot be re-admitted by retries. */
export function rungIdOf(host: string, port: number, model: string): string {
	return createHash("sha256")
		.update(`${host}:${port}:${model}`)
		.digest("hex")
		.slice(0, 16);
}

/** Build the outbound contract for one child hop: the deadline passes
 *  through untouched (absolute — never re-based), the budget counts DOWN
 *  by the rung being consumed (floored at 0 — the header can never mint
 *  budget), and the current rung appends to the path when not already
 *  present. `ownBudget` is the receiver's policy ceiling: a client-supplied
 *  budget can never EXTEND a Buckle budget — the caller applies
 *  min(parsed.budget, ownBudget) when admitting. */
export function childHopContract(
	parsed: Extract<HopContractParse, { status: "ok" }>,
	currentRungId: string,
): { deadlineMs: number; budget: number; path: string[] } {
	const path = parsed.path.includes(currentRungId)
		? parsed.path
		: [...parsed.path, currentRungId];
	return {
		deadlineMs: parsed.deadlineMs,
		budget: Math.max(0, parsed.budget - 1),
		path,
	};
}
