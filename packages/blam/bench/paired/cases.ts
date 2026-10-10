// packages/blam/bench/paired/cases.ts — the three W612 comparisons as
// data-driven paired cases, one engine per case family. Condense rides
// the REAL blam engine (src/condense — the production caveman dispatch
// tier); consult-contract and steer-delivery are scripted, LLM-optional
// stand-ins in the bench/consult (W447) shape. No model calls, no RNG.
// Spec: bench/paired/scenario.md.
import { condenseTier } from "../../src/condense/tiers.ts";
import { runPolicy, SCENARIOS } from "../consult/harness.ts";
import { COSTS } from "../consult/types.ts";
import type { PairedRep, RepOutcome } from "./types.ts";

// ─── case 1: condense on/off — the real engine, plane-free ──────────────
// Arms: on = the lane reads the production caveman-condensed brief;
// off = the lane reads the full brief. Cost proxy: byte length of the
// text the lane reads (tokenizer-agnostic; scenario.md). Correctness:
// operative spans (paths/flags/commands/hedges) must survive verbatim.
interface CaseBrief {
	id: string;
	brief: string;
	mustSurvive: string[];
}

const BRIEF_FILLER: CaseBrief = {
	id: "filler",
	brief:
		"MISSION: fix the login regression on the settings page.\n\nHi there, could you please start by reproducing the bug on http://suspenders.local/settings and then fix packages/suspenders/hooks/lib/session.ts? Thank you very much!\n\nPlease run bun test --coverage when you are done.",
	mustSurvive: [
		"packages/suspenders/hooks/lib/session.ts",
		"bun test --coverage",
		"http://suspenders.local/settings",
	],
};

const BRIEF_HEDGE: CaseBrief = {
	id: "hedge",
	brief:
		"MISSION: bump the gateway pin.\n\nThe router reads the pin from packages/belt/src/router.ts. Only touch the fallback arm; just bump the pin to 2.1 in packages/belt/src/versions.ts and run bun test packages/belt.",
	mustSurvive: [
		"packages/belt/src/router.ts",
		"packages/belt/src/versions.ts",
		"Only touch the fallback arm",
		"bun test packages/belt",
	],
};

// caveman's meta strip + Jaccard dedupe earn their keep here
const BRIEF_META: CaseBrief = {
	id: "meta",
	brief:
		"MISSION: wire the belt router fallback.\n\nAlthough this prompt contains several items, the highest priority is the fallback path. Please add the retry ladder to packages/belt/src/router.ts and keep the timeout at 2500ms. The prompt was written in a hurry, so double-check the config keys. The prompt was written in a hurry, so double-check the config keys.",
	mustSurvive: ["packages/belt/src/router.ts", "2500ms"],
};

// fenced commands are protected verbatim (grammar L1)
const BRIEF_COMMAND: CaseBrief = {
	id: "command",
	brief:
		"MISSION: deploy the stack to the NAS.\n\nThe hub push looks like:\n\n```bash\nbun deploy/hubctl.ts push nas\nbun deploy/hubctl.ts up nas\n```\n\nThank you in advance — and please mind that the NAS has no SFTP.",
	mustSurvive: ["bun deploy/hubctl.ts push nas", "bun deploy/hubctl.ts up nas"],
};

const BRIEFS: CaseBrief[] = [
	BRIEF_FILLER,
	BRIEF_HEDGE,
	BRIEF_META,
	BRIEF_COMMAND,
];

/** One condense arm-run over the matched brief set. The engine is pure,
 * so reps are identical — the paired protocol's variance term is zero
 * here (scenario.md) and the lift is exact. */
function runCondenseArm(condensed: boolean): RepOutcome {
	let tokens = 0;
	let correct = 0;
	for (const b of BRIEFS) {
		if (condensed) {
			const { text } = condenseTier("caveman", b.brief);
			tokens += text.length;
			if (b.mustSurvive.every((s) => text.includes(s))) correct++;
		} else {
			tokens += b.brief.length;
			correct++; // full brief carries every operative span by construction
		}
	}
	return { correct: correct / BRIEFS.length, tokens, minutes: 0 };
}

// ─── case 2: consult-contract on/off — reuses the W447 consult bench ────
// Arms: off = "current-instructions" (consult only after a second
// unchanged failure, no retrieval-first); on = "trigger" (the toto-gpt
// consultation contract: observable trigger at the decision point,
// retrieval first, bounded question). Reps ride the consult scenario
// matrix as a fixed adversarial schedule.
function consultRepOutcome(
	arm: "current-instructions" | "trigger",
	rep: number,
): { out: RepOutcome; setup: string } {
	const cfg = SCENARIOS[rep % SCENARIOS.length];
	const { total } = runPolicy(arm, cfg);
	return {
		out: {
			correct: total.correctTasks / total.totalTasks,
			tokens: total.tokenCost,
			minutes: total.completionTimeMin + total.blockedTimeMin,
		},
		setup: `${cfg.kbVersion === cfg.codeVersion ? "fresh" : "stale"}-kb/${cfg.delivery}`,
	};
}

// ─── case 3: steer-delivery on/off — W611 lane-inbox model ──────────────
// A lane runs UNITS units; a steering event (revert | cancel) lands after
// `arrival` completed units. on = the W611 world: the gate drain
// delivers the event into the model context at the next save (one
// in-flight unit may complete stale); off = pre-W611: the event reaches
// the operator transcript only, never the lane — the lane finishes
// stale and review pays redo. Costs ride the shared COSTS.

const UNITS = 6;
const DRAIN_TOKENS = 40;

type SteerEvent = { kind: "revert" | "cancel"; arrival: number };

const STEER_SCHEDULE: SteerEvent[] = [
	{ kind: "revert", arrival: 1 },
	{ kind: "revert", arrival: 3 },
	{ kind: "cancel", arrival: 3 },
	{ kind: "revert", arrival: 5 },
];

function runSteerArm(
	delivered: boolean,
	rep: number,
): { out: RepOutcome; setup: string } {
	const { kind, arrival } = STEER_SCHEDULE[rep % STEER_SCHEDULE.length];
	const staleUnits = delivered ? 1 : UNITS - arrival;
	let tokens = arrival * COSTS.investigateTokens;
	let minutes = arrival * COSTS.investigateMin;
	let correct: number;
	if (kind === "revert") {
		// re-run the stale units on the corrected approach
		tokens += staleUnits * COSTS.investigateTokens;
		minutes += staleUnits * COSTS.investigateMin;
		if (!delivered) {
			// redo overhead: review catches the stale approach, lane re-derives
			tokens += COSTS.redoTokens;
			minutes += COSTS.redoMin;
		}
		correct = 1;
	} else {
		// cancel: ground truth is "ship nothing"
		if (delivered) {
			// the lane stops at the drain: one in-flight unit wasted
			// (the drain injection itself is charged once, below)
			tokens += COSTS.investigateTokens;
			minutes += COSTS.investigateMin;
			correct = 1;
		} else {
			// ships the cancelled artifact; review pays the repair
			tokens += (UNITS - arrival) * COSTS.investigateTokens + COSTS.redoTokens;
			minutes += (UNITS - arrival) * COSTS.investigateMin + COSTS.redoMin;
			correct = 0;
		}
	}
	if (delivered) tokens += DRAIN_TOKENS;
	return {
		out: { correct, tokens, minutes },
		setup: `${kind}@u${arrival}`,
	};
}

// ─── the case table ─────────────────────────────────────────────────────
export type CaseName = "condense" | "consult-contract" | "steer-delivery";

export const CASE_NAMES: CaseName[] = [
	"condense",
	"consult-contract",
	"steer-delivery",
];

/** Run both arms for one (case, rep) and return the matched pair. */
export function runPair(caseName: CaseName, rep: number): PairedRep {
	if (caseName === "condense") {
		return {
			rep,
			setup: "brief-set/4",
			on: runCondenseArm(true),
			off: runCondenseArm(false),
		};
	}
	if (caseName === "consult-contract") {
		const on = consultRepOutcome("trigger", rep);
		const off = consultRepOutcome("current-instructions", rep);
		return { rep, setup: on.setup, on: on.out, off: off.out };
	}
	const on = runSteerArm(true, rep);
	const off = runSteerArm(false, rep);
	return { rep, setup: on.setup, off: off.out, on: on.out };
}

/** P2 probe: the production caveman tier keeps every operative span on
 * every case brief, and the tier table genuinely differs (aggressive
 * strips the hedge clause the W287 law protects). Empty = holds. */
export function condenseIntegrityViolations(): string[] {
	const v: string[] = [];
	for (const b of BRIEFS) {
		const { text } = condenseTier("caveman", b.brief);
		for (const s of b.mustSurvive) {
			if (!text.includes(s)) v.push(`condense:${b.id} lost "${s}"`);
		}
	}
	const hedge = BRIEFS.find((b) => b.id === "hedge");
	if (!hedge) return [...v, "condense:hedge brief missing"];
	const agg = condenseTier("aggressive", hedge.brief).text;
	if (!agg.includes("packages/belt/src/versions.ts"))
		v.push("condense:hedge aggressive lost the pin path");
	if (agg.includes("just bump the pin"))
		v.push("condense:hedge aggressive kept hedge");
	return v;
}

/** P4 probe: the drain never costs more (tokens or minutes) than letting
 * the lane finish stale, and never reduces correctness. Empty = holds. */
export function steerIntegrityViolations(): string[] {
	const v: string[] = [];
	for (let rep = 0; rep < STEER_SCHEDULE.length; rep++) {
		const on = runSteerArm(true, rep);
		const off = runSteerArm(false, rep);
		if (on.out.tokens > off.out.tokens)
			v.push(`steer:rep${rep} drain cost tokens`);
		if (on.out.minutes > off.out.minutes)
			v.push(`steer:rep${rep} drain cost minutes`);
		if (on.out.correct < off.out.correct)
			v.push(`steer:rep${rep} drain lost correctness`);
	}
	return v;
}
