// hooks/lib/consult/consult-v2.ts — hub design phase 4: the pure half of
// consult v2. Consult is two channels over ONE record: WS push (primary,
// live — the machine subscriber fans events into per-session logs) and the
// durable inbox (fallback when the recipient does not ack in time).
//
// Delivery class per consult:
//   INTERRUPT — exactly one sid addressee, effective priority high, and the
//     asker is blocked on it. Delivered as a steer mid-turn; the recipient
//     must answer or explicitly defer. Budget (owner correction 2026-10-29):
//     at most one interrupt per recipient per consult.interrupt.min_interval_s
//     (default 180 s) and per sender per sender_min_interval_s. Inside the
//     window a second interrupt QUEUES and coalesces — one steer when the
//     window opens — it is never downgraded to BTW.
//   BTW — everything else (low/normal priority, multi-recipient, fleet
//     broadcast, non-blocking). Surfaced at the next tool boundary as ONE
//     digest line; no ack required.
// Kev may downgrade a priority, never upgrade it.
import type { CoordConfig } from "./consult-config.ts";

export type ConsultPriority = "high" | "normal" | "low";
export type ConsultClass = "interrupt" | "btw";
export type ConsultKind = "ask" | "tell" | "bank";
export type AnsweredBy = "lane" | "knowledge" | "fleet" | "human";

const PRIORITY_RANK: Record<ConsultPriority, number> = {
	low: 0,
	normal: 1,
	high: 2,
};

export function parsePriority(raw: string | null | undefined): ConsultPriority {
	if (raw === "high" || raw === "low" || raw === "normal") return raw;
	if (raw == null || raw === "") return "normal";
	throw new Error(`--priority must be high|normal|low (got ${raw})`);
}

/** Kev's verdict may only lower the asker's priority. */
export function effectivePriority(
	asker: ConsultPriority,
	kev?: ConsultPriority | null,
): ConsultPriority {
	if (!kev) return asker;
	return PRIORITY_RANK[kev] < PRIORITY_RANK[asker] ? kev : asker;
}

/** Route grammar: `<sid>` | `<sid>,<sid>` | `fleet` | `hub:<name>`. */
export type ConsultRoute =
	| { kind: "sid"; sids: string[] }
	| { kind: "fleet" }
	| { kind: "hub"; hub: string };

export function parseRoute(raw: string): ConsultRoute {
	const r = raw.trim();
	if (!r) throw new Error("--to needs <sid>|fleet|hub:<name>");
	if (r === "fleet") return { kind: "fleet" };
	if (r.startsWith("hub:")) {
		const hub = r.slice(4).trim();
		if (!hub) throw new Error("--to hub:<name> needs a hub name");
		return { kind: "hub", hub };
	}
	const sids = [
		...new Set(
			r
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
	return { kind: "sid", sids };
}

export function routeText(r: ConsultRoute): string {
	if (r.kind === "fleet") return "fleet";
	if (r.kind === "hub") return `hub:${r.hub}`;
	return r.sids.join(",");
}

export interface ClassifyInput {
	route: ConsultRoute;
	priority: ConsultPriority;
	kevPriority?: ConsultPriority | null;
	/** false = the asker is not blocked on the answer → always BTW */
	blocking: boolean;
	kind: ConsultKind;
}

export function classify(i: ClassifyInput): ConsultClass {
	if (i.kind !== "ask" || !i.blocking) return "btw"; // tells/banks block nobody
	if (i.route.kind !== "sid" || i.route.sids.length !== 1) return "btw";
	return effectivePriority(i.priority, i.kevPriority) === "high"
		? "interrupt"
		: "btw";
}

export interface InterruptWindow {
	/** last interrupt steered at this recipient (ms), null = never */
	recipientLastAt: number | null;
	/** last interrupt this sender steered at anyone (ms), null = never */
	senderLastAt: number | null;
}

/** When the next interrupt to (recipient, sender) may go out. */
export function interruptDueAt(w: InterruptWindow, cfg: CoordConfig): number {
	const r =
		w.recipientLastAt == null
			? 0
			: w.recipientLastAt + cfg.consult.interrupt.min_interval_s * 1000;
	const s =
		w.senderLastAt == null
			? 0
			: w.senderLastAt + cfg.consult.interrupt.sender_min_interval_s * 1000;
	return Math.max(r, s);
}

/** Escalation chain for an un-acked interrupt: re-steer once → inbox +
 *  notify the asker → the oracle/fleet (--best). */
export const ESCALATION_STEPS = ["re-steer", "inbox", "fleet"] as const;
export type EscalationStep = (typeof ESCALATION_STEPS)[number];

export function nextEscalation(
	done: readonly string[],
	lastAttemptAt: number,
	now: number,
	cfg: CoordConfig,
): EscalationStep | null {
	if (now - lastAttemptAt < cfg.consult.interrupt.ack_timeout_s * 1000)
		return null;
	return ESCALATION_STEPS[done.length] ?? null;
}

const BTW_LINE = /^\s*#\d+\s+\S+\s+consult\.btw(?:\s|$)/;

/** Push-gate boundary digest: every consult.btw line collapses into ONE
 *  line (first) — the rest of the shown lines pass through in order. */
export function btwDigest(lines: string[]): string[] {
	const btw = lines.filter((l) => BTW_LINE.test(l));
	if (!btw.length) return lines;
	const rest = lines.filter((l) => !BTW_LINE.test(l));
	const items = btw.map((l) =>
		l
			.replace(/^\s*#\d+\s+/, "")
			.replace(/\s+consult\.btw\s*/, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
	return [`BTW digest (${btw.length}): ${items.join(" · ")}`, ...rest];
}
