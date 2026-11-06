// W2803: confidence-gated second-opinion leg (hybrid judge cascade).
// The reviewer contract ends with `CONFIDENCE: <0-1>` beside the verdict;
// a verdict without a parseable confidence is ERROR (fail-closed). A PASS
// inside the uncertainty band re-runs on the next-stronger routing-policy
// tier: agree = PASS, disagree = ERROR. FAIL never downgrades.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { wireModelAudit } from "./wire-model-check.ts";

export const SecondOpinionBandSchema = z
	.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
	.refine(([lo, hi]) => lo <= hi, "band low must be <= high");
export type SecondOpinionBand = z.infer<typeof SecondOpinionBandSchema>;
export const DEFAULT_SECOND_OPINION_BAND: SecondOpinionBand = [0.3, 0.9];

/** Routing-policy tiers, weakest first (the `classes` block keys). */
export const POLICY_TIER_ORDER = ["spark", "standard", "frontier"] as const;

const RoutingClassesSchema = z
	.object({ classes: z.record(z.string(), z.array(z.string())) })
	.loose();

/** The LAST `CONFIDENCE: n` line wins (models restate headers). */
export const confidenceOf = (reply: string | null): number | undefined => {
	if (!reply) return undefined;
	const hit = [...reply.matchAll(/CONFIDENCE:\s*([0-9]*\.?[0-9]+)/g)].at(-1);
	if (!hit) return undefined;
	const n = Number(hit[1]);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
};

export const inBand = (conf: number, [lo, hi]: SecondOpinionBand): boolean =>
	conf >= lo && conf <= hi;

export type CascadeStep =
	| { kind: "final"; verdict: "PASS" | "FAIL" | "ERROR"; reason?: string }
	| { kind: "second-opinion"; model: string };

/** Decide what the first leg's verdict means. */
export function firstLegDecision(o: {
	verdict: "PASS" | "FAIL" | "ERROR";
	confidence: number | undefined;
	band: SecondOpinionBand;
	strongerModel: string | undefined;
}): CascadeStep {
	if (o.verdict === "ERROR") return { kind: "final", verdict: "ERROR" };
	if (o.confidence === undefined)
		return {
			kind: "final",
			verdict: "ERROR",
			reason: "verdict without parseable CONFIDENCE line",
		};
	if (o.verdict === "FAIL") return { kind: "final", verdict: "FAIL" };
	if (!inBand(o.confidence, o.band)) return { kind: "final", verdict: "PASS" };
	if (!o.strongerModel)
		return {
			kind: "final",
			verdict: "ERROR",
			reason: `PASS confidence ${o.confidence} in band, no stronger tier`,
		};
	return { kind: "second-opinion", model: o.strongerModel };
}

/** Combine first PASS with the second leg; only agreement banks PASS. */
export function secondLegDecision(o: {
	verdict: "PASS" | "FAIL" | "ERROR";
	confidence: number | undefined;
	wireMismatch: boolean;
}): { verdict: "PASS" | "ERROR"; reason?: string } {
	if (o.wireMismatch)
		return { verdict: "ERROR", reason: "second-opinion wire mismatch" };
	if (o.confidence === undefined)
		return { verdict: "ERROR", reason: "second-opinion without CONFIDENCE" };
	if (o.verdict !== "PASS")
		return {
			verdict: "ERROR",
			reason: `second-opinion disagreed (${o.verdict})`,
		};
	return { verdict: "PASS" };
}

/** The first model of the next tier above the one holding `model`. */
export function strongerTierModel(
	model: string,
	classes: Record<string, string[]>,
	order: readonly string[] = POLICY_TIER_ORDER,
): string | undefined {
	const at = order.findIndex((tier) => classes[tier]?.includes(model));
	if (at < 0) return undefined;
	for (const tier of order.slice(at + 1)) {
		const pick = classes[tier]?.[0];
		if (pick) return pick;
	}
	return undefined;
}

export function loadPolicyClasses(
	path = process.env.BUCKLE_POLICY ??
		join(homedir(), ".claude/local-llm/routing-policy.json"),
): Record<string, string[]> {
	if (!existsSync(path)) return {};
	const parsed = RoutingClassesSchema.safeParse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (!parsed.success) {
		console.error(`review-confidence: ${z.prettifyError(parsed.error)}`);
		return {};
	}
	return parsed.data.classes;
}

export interface SecondOpinionResult {
	verdict: "PASS" | "FAIL" | "ERROR";
	confidence?: number;
	second?: { model: string; text: string; wire?: string; confidence?: number };
	reason?: string;
}

const verdictOf = (text: string): "PASS" | "FAIL" | "ERROR" => {
	const line = [...text.matchAll(/VERDICT: (PASS|FAIL[^\n]*)/g)].at(-1)?.[1];
	if (!line) return "ERROR";
	return line.startsWith("PASS") ? "PASS" : "FAIL";
};

interface SecondOpinionInput {
	verdict: "PASS" | "FAIL" | "ERROR";
	reply: string | null;
	model: string | undefined;
	request: (model: string) => Promise<string>;
	servedWire: () => string | undefined;
	band?: SecondOpinionBand;
	classes?: Record<string, string[]>;
}

/** Runs the cascade: first-leg gate, then the stronger-tier second leg.
 *  Wire identity: requested==served (W2792.1); unknown served = mismatch. */
export async function secondOpinion(
	o: SecondOpinionInput,
): Promise<SecondOpinionResult> {
	const confidence = confidenceOf(o.reply);
	const strongerModel =
		o.verdict === "PASS" && o.model
			? strongerTierModel(o.model, o.classes ?? loadPolicyClasses())
			: undefined;
	const step = firstLegDecision({
		verdict: o.verdict,
		confidence,
		band: o.band ?? DEFAULT_SECOND_OPINION_BAND,
		strongerModel,
	});
	if (step.kind === "final") return { ...step, confidence };
	let text: string;
	try {
		text = await o.request(step.model);
	} catch (error) {
		const reason = `second-opinion leg failed: ${String(error).slice(0, 160)}`;
		return { verdict: "ERROR", confidence, reason };
	}
	const wire = o.servedWire();
	const secondConf = confidenceOf(text);
	const decided = secondLegDecision({
		verdict: verdictOf(text),
		confidence: secondConf,
		wireMismatch: wireModelAudit(step.model, wire)?.match !== "match",
	});
	const second = { model: step.model, text, wire, confidence: secondConf };
	return { ...decided, confidence, second };
}
