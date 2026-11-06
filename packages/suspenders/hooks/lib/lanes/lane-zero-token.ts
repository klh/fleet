// hooks/lib/lanes/lane-zero-token.ts — W2786: the zero-token proof behind
// the dead-claim fast retire. "Nothing to lose" must be PROVEN, never
// assumed: a dead lane whose attribution shows zero banked tokens releases
// without the conservative recovery-reserved flow, but an unknown ledger is
// NOT zero. Fail-soft doctrine: any unreadable source reads unknown → the
// caller keeps the conservative path.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
	ATTRIBUTION_LOOKBACK_MS,
	itemAttribution,
	resolveBuckleDb,
} from "./lane-spend.ts";
import { probeClaim } from "./reclaim-liveness.ts";
import type { LaneRef } from "./lane-liveness.ts";
import type { GovernorStore } from "../govdb/govdb.ts";

export type ZeroTokenVerdict = {
	/** true ONLY when every source positively shows no spend */
	zero: boolean;
	/** which proof produced the verdict */
	why: string;
	/** W2793: true ONLY when the ledger positively shows spend — the rung
	 *  served real work (the breaker's proven-healthy signal) */
	banked?: boolean;
};

/** Is the item's attribution provably empty? Ledger > backfill > self-report
 *  (the W1070 ladder, same as itemAttribution): all three must be POSITIVELY
 *  absent-or-zero — a missing ledger (null) reads unknown, never zero. */
export function zeroTokenProof(
	db: Database,
	project: string,
	item: string,
	nowMs = Date.now(),
	ledger: string | null = resolveBuckleDb(),
): ZeroTokenVerdict {
	// itemAttribution fails SOFT on an unreadable ledger (all-zero spend), so
	// the ledger's existence is checked HERE: a path that does not open is
	// unknown, never proof of zero.
	if (ledger === null || !existsSync(ledger))
		return { zero: false, why: "no readable ledger — unknown, never zero" };
	let a: {
		fresh: number;
		cached: number;
		out: number;
		requests: number;
	} | null = null;
	try {
		a = itemAttribution(db, project, nowMs, ledger).get(item) ?? null;
	} catch {
		a = null;
	}
	if (!a) return { zero: false, why: "attribution lookup failed — unknown" };
	if (a.fresh + a.cached + a.out + a.requests > 0)
		return {
			zero: false,
			banked: true,
			why: `banked tokens (fresh ${a.fresh}, out ${a.out})`,
		};
	return { zero: true, why: "ledger + backfill + self-report all empty" };
}

/** W2786 fast-retire gate: dead lane liveness AND provably-zero attribution.
 *  Every term reuses the surfaces the conservative path already trusts —
 *  probeClaim for liveness, zeroTokenProof for spend. */
export function fastRetireEligible(
	db: Database,
	store: GovernorStore,
	project: string,
	claim: { id: string; owner: string; revision: number; lane?: LaneRef },
	nowMs = Date.now(),
	ledger: string | null = resolveBuckleDb(),
): ZeroTokenVerdict {
	const probe = probeClaim(store, project, {
		id: claim.id,
		owner: claim.owner,
		revision: claim.revision,
		lane: claim.lane,
		now: nowMs,
	});
	if (probe.verdict !== "dead")
		return {
			zero: false,
			why: `liveness ${probe.verdict} — not provably dead`,
		};
	return zeroTokenProof(db, project, claim.id, nowMs, ledger);
}

export { ATTRIBUTION_LOOKBACK_MS };
