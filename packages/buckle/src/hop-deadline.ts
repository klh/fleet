// src/hop-deadline.ts — W1118.1: the W1086 shared hop contract rides every
// Buckle ladder attempt (Buckle→Belt, Buckle→hub Buckle, Buckle→LiteLLM).
// Inbound admission refuses expired/malformed/empty-budget/repeated-rung as
// typed traced failures; the contract deadline CLAMPS the local walk
// deadline (an absolute deadline never extends the local budget, only
// tightens it). Outbound: each fleet leg emits the child contract — the
// budget counts down per attempt, the path appends the SENDER's own rung
// (derived from the URL the caller addressed this hop by + the wire model),
// and a retry of the same rung stays the same rung (no false repeat). An
// immediate A→B→A cycle therefore repeats A's rung in the path and refuses
// 400 at A's own admission. encode-null = typed refusal (no contract-less
// bypass). Correlation and budget semantics only — never authz.
import {
	HOP_CONTRACT_HEADER,
	childHopContract,
	encodeHopContract,
	parseHopContract,
	type HopContractParse,
} from "../../telemetry/src/hop-contract.ts";
import type { Deployment } from "./upstreams.ts";

/** The admitted (or rooted) contract as it threads the walk. `path` is the
 *  visited rung ids in traversal order; `ownRung` is THIS hop's id derived
 *  from its ingress URL + wire model — the rung appended outbound. */
export interface HopContract {
	/** Absolute epoch-ms — never re-based at a child hop. */
	deadlineMs: number;
	budget: number;
	path: string[];
	/** This hop's own rung id (sender-side append). */
	ownRung: string;
}

/** A typed hop-contract refusal: status + machine code + human why, mapped
 *  onto deny() at the proxy seam. */
export interface HopContractDenial {
	status: 400 | 429 | 504;
	code: string;
	why: string;
}

export type HopContractAdmission =
	| { ok: true; contract: HopContract | null }
	| { ok: false; denial: HopContractDenial };

/** A child contract that cannot encode refuses the leg (never a
 *  contract-less bypass). Unreachable for admitted contracts by the grammar
 *  (budget ∈ [0,99], path ≤64, 13-digit deadline) — kept typed so the
 *  router classification is honest if an invariant ever breaks. */
export class HopContractRefusal extends Error {
	constructor(ownRung: string) {
		super(`hop contract unencodable at rung ${ownRung}`);
	}
}

/** The typed denial for a parsed verdict: null when the contract admits. */
function denialOf(
	parsed: HopContractParse,
	ownRung: string,
): HopContractDenial | null {
	if (parsed.status === "invalid")
		return {
			status: 400,
			code: "hop_contract_invalid",
			why: "malformed hop contract",
		};
	if (parsed.status === "expired")
		return {
			status: 504,
			code: "hop_contract_expired",
			why: `hop contract deadline ${String(parsed.deadlineMs)} already passed`,
		};
	if (parsed.budget <= 0)
		return {
			status: 429,
			code: "hop_contract_budget_exhausted",
			why: "hop contract attempt budget exhausted",
		};
	if (parsed.path.includes(ownRung))
		return {
			status: 400,
			code: "hop_contract_repeated_rung",
			why: "hop contract already visited this rung (routing cycle)",
		};
	return null;
}

/** Parse a hop contract from a raw header value. An ABSENT header admits
 *  with a null contract (a fresh fleet entry — the caller roots one); any
 *  PRESENT but failed verdict refuses typed. The repeated-rung check tests
 *  the receiver's own rung against the visited path: a retry of the same
 *  rung never re-appends (the path carries the sender chain, not this
 *  receiver), so an immediate cycle is the only repeat. */
export function admitHopContract(
	value: string | null | undefined,
	now: number,
	ownRung: string,
): HopContractAdmission {
	if (value === null || value === undefined || value === "")
		return { ok: true, contract: null };
	const parsed = parseHopContract(value, now);
	const denial = denialOf(parsed, ownRung);
	if (denial !== null) return { ok: false, denial };
	return {
		ok: true,
		contract: {
			deadlineMs: parsed.status === "ok" ? parsed.deadlineMs : 0,
			budget: parsed.status === "ok" ? parsed.budget : 0,
			path: parsed.status === "ok" ? parsed.path : [],
			ownRung,
		},
	};
}

/** The contract this hop roots for a fresh fleet entry (no inbound header):
 *  the local walk budget in attempts and the local walk deadline in ms —
 *  the child chain is bounded by exactly what this hop would have spent
 *  anyway. The deadline is clamped to `now` as a floor (never negative). */
export function hopContractRoot(
	now: number,
	walkDeadlineMs: number,
	rootBudget: number,
): HopContract {
	return {
		deadlineMs: Math.max(now, walkDeadlineMs),
		budget: Math.max(0, Math.floor(rootBudget)),
		path: [],
		ownRung: "",
	};
}

/** Which legs carry the contract: fleet-internal peers (belt / hub buckle,
 *  the W706 buckle mark) and the declared LiteLLM engine. External provider
 *  egress stays contract-less (the header never crosses to a provider). */
export function isContractHop(dep: Deployment): boolean {
	return dep.buckle === true || dep.adapter_config?.proxy_kind === "litellm";
}

/** The outbound child-contract header value for one attempt, or null when
 *  unencodable (the caller refuses the leg — never sends contract-less). */
export function childHopHeaderValue(contract: HopContract): string | null {
	const rung = contract.ownRung;
	if (!/^[0-9a-f]{16}$/.test(rung)) return null;
	return encodeHopContract(
		childHopContract(
			{
				deadlineMs: contract.deadlineMs,
				budget: contract.budget,
				path: contract.path,
			},
			rung,
		),
	);
}

export { HOP_CONTRACT_HEADER };
