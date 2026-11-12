// bench/durable/tier-ladder.ts — W2971.3 escalation ladder (owner-directed
// 2026-11-12): start at the tier with NO token and NO wall-clock limits;
// a solved problem gets tightened (fiddled) downward to find the cheapest
// setting that still solves; a tier that cannot solve after its attempt
// budget escalates (low→medium→high). The ladder is DATA (tier-ladder.json)
// — semantics here, numbers in the file; C505 may refine the numbers
// without touching code.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { attemptCount, type Tier } from "./arm-ledger.ts";

export const TierPlanSchema = z.strictObject({
	tokenBudget: z.number().int().positive().nullable(), // null = unlimited
	wallClockMin: z.number().int().positive().nullable(), // null = leaf maximum (finite but maximal)
	iterationCap: z.number().int().positive().nullable(), // null = runner default
	attemptBudget: z.number().int().positive(), // runs at this tier before escalating
	confirmRuns: z.number().int().positive(), // repeats required to certify a tightened tier
});

export const TierLadderSchema = z.strictObject({
	version: z.literal(1),
	order: z.tuple([z.literal("low"), z.literal("medium"), z.literal("high")]),
	tiers: z.record(z.string(), TierPlanSchema),
	// measured-run history (C505): anchors are DATA, never policy —
	// recorded verbatim so history and proposed search stay separable
	anchors: z.record(z.string(), z.unknown()).optional(),
	// tighten rule: after a solve at tier T, this many consecutive solves
	// at the cheaper tier certify it as the new baseline
});

export type TierPlan = z.infer<typeof TierPlanSchema>;
export type TierLadder = z.infer<typeof TierLadderSchema>;

export function loadTierLadder(path: string): TierLadder {
	const parsed = TierLadderSchema.safeParse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (!parsed.success) {
		throw new Error(`tier-ladder drift refused at ${path}:\n${parsed.error.message}`);
	}
	const { order, tiers } = parsed.data;
	for (const tier of order) {
		if (!tiers[tier]) throw new Error(`tier-ladder drift: missing tier ${tier}`);
	}
	return parsed.data;
}

/** The tier an attempt should run at, given the ledger history. */
export function nextTier(
	ladder: TierLadder,
	ledgerPath: string,
	problemId: string,
): Tier {
	const rows = attemptHistory(ladder, ledgerPath, problemId);
	if (rows.solvedAt) return rows.solvedAt; // certified baseline — keep running there
	for (const tier of ladder.order) {
		if (rows.perTier[tier] < ladder.tiers[tier].attemptBudget) return tier as Tier;
	}
	// every tier exhausted its budget: the problem is capped at the top tier
	return ladder.order[ladder.order.length - 1] as Tier;
}

function attemptHistory(
	ladder: TierLadder,
	ledgerPath: string,
	problemId: string,
): { perTier: Record<string, number>; solvedAt: Tier | null } {
	// readLedger via dynamic import keeps this module leaf-light for tests
	const { readLedger } = require("./arm-ledger.ts") as {
		readLedger: (p: string) => import("./arm-ledger.ts").LedgerRow[];
	};
	const perTier: Record<string, number> = {};
	let solvedAt: Tier | null = null;
	for (const row of readLedger(ledgerPath)) {
		if (row.problemId !== problemId) continue;
		if (row.outcome === "accepted") {
			perTier[row.tier] = (perTier[row.tier] ?? 0) + 1;
			if (!solvedAt) solvedAt = row.tier;
		}
	}
	// escalation: a tier that burned its budget without a solve escalates;
	// the FIRST tier with a solve becomes the baseline (tightening pass
	// re-runs the cheaper tiers confirmRuns times before certifying — v1
	// anchors the baseline at the first solving tier)
	return { perTier, solvedAt };
}
