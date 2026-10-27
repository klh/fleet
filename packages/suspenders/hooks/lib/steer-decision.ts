// hooks/lib/steer-decision.ts — W1035: the mid-turn steer kit. Kill+relaunch
// wastes a lane's accumulated context; steer the running lane instead. This
// lib owns the three pure pieces:
//   lanePhase — read the lane log's last stream-json frame into tool/generating/
//               idle/unknown (the mid-tool signal behind the "pending" ack);
//   ackFor    — the response.steer-shaped ack: accepted (queued), pending
//               (lane mid-tool), failed (lane dead);
//   decideSteerOrRedo — the kev (:8912) steer-vs-redo decider. Deterministic
//               overrides FIRST (dead probe / FAILED item = redo, no matter
//               what kev says); kev only breaks the fuzzy cases; kev down →
//               let-ride (no fuzzy verdict without it).
import { statSync } from "node:fs";
import { join } from "node:path";
import { type KevOption, kevTypedDecision } from "./knowledge/kev.ts";
import { transcriptTail } from "./transcript.ts";

export type SteerAckState = "accepted" | "pending" | "failed";
export type LanePhase = "tool" | "generating" | "idle" | "unknown";

/** The lane log is the managed runtime's stream-json stdout relay. */
export const laneLogPath = (root: string, sid: string): string =>
	join(root, `.fleet/lane-${sid}.log`);

export interface LogRead {
	phase: LanePhase;
	ageMs: number | null;
}

/** The lane log decides the phase: bounded tail + mtime, fail-open. */
export function logReadOf(root: string, sid: string): LogRead {
	const log = laneLogPath(root, sid);
	const tail = transcriptTail(log, 8192);
	if (!tail) return { phase: "unknown", ageMs: null };
	let ageMs: number | null = null;
	try {
		ageMs = Date.now() - statSync(log).mtimeMs;
	} catch {}
	return { phase: lanePhase(tail), ageMs };
}

/** W1035 gates: one steer per sid per hour (the W947 dedupe window). */
export const STEER_WINDOW_MS = 3_600_000;

/** The kill-switch filename, relative to the project root's .fleet/. */
export const STEER_PAUSE_FILE = "steer-paused";

/**
 * The last parseable stream-json frame decides the phase — the lane log IS
 * the managed runtime's stdout (native claude --output-format stream-json
 * relayed verbatim). assistant+tool_use = a tool in flight (mid-tool);
 * assistant text / user frames = generating; result = the turn ended. A log
 * with no parseable frames (codex, copilot, empty) reads "unknown" and never
 * claims a phase it cannot see.
 */
export function lanePhase(tail: string): LanePhase {
	for (const line of tail.split("\n").reverse()) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let frame: {
			type?: string;
			message?: { content?: Array<{ type?: string }> };
		};
		try {
			frame = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (frame.type === "assistant")
			return (frame.message?.content ?? []).some((b) => b.type === "tool_use")
				? "tool"
				: "generating";
		if (frame.type === "user" || frame.type === "system") return "generating";
		if (frame.type === "result") return "idle";
	}
	return "unknown";
}

/**
 * The ack mapping: dead/unknown probe = failed (never a fake queue for a
 * lane we cannot prove alive); mid-tool = pending (the input is still queued
 * — the managed runtime interrupts the in-flight tool turn and injects it);
 * otherwise accepted.
 */
export function ackFor(
	verdict: "alive" | "dead" | "unknown",
	phase: LanePhase,
): SteerAckState {
	if (verdict !== "alive") return "failed";
	return phase === "tool" ? "pending" : "accepted";
}

/** The decider's input: graph state joined to lane posture (all nullable —
 *  the doc renders what it has). */
export interface SteerDecisionInput {
	item: {
		id: string;
		title: string;
		state: string;
		description?: string | null;
		attempt?: number | null;
	};
	lane: {
		/** laneVerdict over the registry row — the plane's liveness word. */
		verdict: "alive" | "dead" | "unknown";
		phase: LanePhase;
		/** ms since the lane log last moved; null = unreadable. */
		logAgeMs: number | null;
	};
	spend: {
		fresh: number;
		cached: number;
		out: number;
		agentMs: number;
	};
}

export interface SteerDecision {
	choice: "steer" | "redo" | "let-ride";
	via: "override" | "kev" | "kev-unavailable";
	confidence: number;
	probabilities: Record<string, number>;
	rationale: string;
}

/** The one-paragraph state doc kev reads: item shape, spend vs effort,
 *  posture, the log's recent frame flow. */
export function steerStateDoc(input: SteerDecisionInput): string {
	const { item, lane, spend } = input;
	const minutes = spend.agentMs / 60_000;
	const outPerMin = minutes > 0 ? Math.round(spend.out / minutes) : 0;
	const desc = (item.description ?? "").trim();
	const lines = [
		`Item ${item.id} [${item.state}] — ${item.title}`,
		desc ? `Description: ${desc.slice(0, 400)}` : null,
		`Spend: ${Math.round(spend.fresh / 1000)}k fresh + ${Math.round(spend.cached / 1000)}k cached, ${Math.round(spend.out / 1000)}k out over ${Math.round(minutes)}m agent wall (~${outPerMin} out/min)`,
		`Attempt ${item.attempt ?? 1}; lane probe ${lane.verdict}; log phase ${lane.phase}${lane.logAgeMs == null ? "" : `, log last moved ${Math.round(lane.logAgeMs / 60_000)}m ago`}`,
	];
	return lines.filter((l) => l !== null).join("\n");
}

export const STEER_QUESTION =
	"Steer-or-redo: is this lane making progress on its item? " +
	"steer = inject a targeted mid-turn correction now; " +
	"redo = the turn is stuck or wrong-headed, kill and relaunch from the capsule; " +
	"let-ride = no clear stall, intervening costs more than it fixes.";

const STEER_OPTIONS: KevOption[] = [
	{
		label: "steer",
		tradeoff: "keeps the lane's accumulated context, fixes drift in place",
	},
	{
		label: "redo",
		tradeoff: "loses context but restarts clean from the continuation capsule",
	},
	{
		label: "let-ride",
		tradeoff: "no clear stall; an intervention now is pure risk",
	},
];

/**
 * Deterministic overrides first; kev only breaks the fuzzy cases. kev is
 * null-safe by contract (down/timeout/malformed → null) and null reads as
 * let-ride — an unavailable decider must never redo a live lane.
 */
export async function decideSteerOrRedo(
	input: SteerDecisionInput,
	opts: { timeoutMs?: number } = {},
): Promise<SteerDecision> {
	if (input.lane.verdict === "dead")
		return {
			choice: "redo",
			via: "override",
			confidence: 1,
			probabilities: { steer: 0, redo: 1, "let-ride": 0 },
			rationale:
				"lane probe is dead — nothing to steer; redo is the honest path",
		};
	if (input.item.state === "FAILED")
		return {
			choice: "redo",
			via: "override",
			confidence: 1,
			probabilities: { steer: 0, redo: 1, "let-ride": 0 },
			rationale: "item state FAILED — the lane already failed once; redo",
		};
	const d = await kevTypedDecision({
		state: steerStateDoc(input),
		question: STEER_QUESTION,
		options: STEER_OPTIONS,
		timeoutMs: opts.timeoutMs,
	});
	if (!d)
		return {
			choice: "let-ride",
			via: "kev-unavailable",
			confidence: 0,
			probabilities: {},
			rationale:
				"kev (:8912) unavailable — no fuzzy verdict without it; let the lane ride",
		};
	return {
		choice: d.choice === "steer" || d.choice === "redo" ? d.choice : "let-ride",
		via: "kev",
		confidence: d.confidence,
		probabilities: d.probabilities,
		rationale: `kev ${d.model}: ${Object.entries(d.probabilities)
			.sort((a, b) => b[1] - a[1])
			.map(([label, p]) => `${label} ${Math.round(p * 100)}%`)
			.join(", ")}`,
	};
}
