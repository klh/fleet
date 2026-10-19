// hooks/lib/done-broadcast.ts — W822.1: the work CLI's done handler (not
// lane discipline) broadcasts a condensed completion summary on the coord
// bus. The note is caveman-condensed (blam tier) from --summary + the item
// description + the landed sha; kev (:8912 SystemOne, ~free local 4B) scores
// it {actionable-now, interesting, noise} and the label rides the broadcast
// payload so inbox lines carry it — live sessions react-or-absorb, and the
// W822 pulse digest batches interesting/noise. Fail-open everywhere: kev
// down or malformed → "interesting", any failure → no broadcast, DONE never
// blocks or errors. Hub deploys (KLH_HUB_NAME set) emit nothing — coord is
// machine-local.
import type { GovernorStore } from "./govdb.ts";
import { broadcastNote } from "./broadcast-core.ts";
import { kevTypedDecision } from "./knowledge/kev.ts";

export const KEV_LABELS = ["actionable-now", "interesting", "noise"] as const;
export type KevLabel = (typeof KEV_LABELS)[number];

// the done path is latency-bound: a warm local kev answers in well under a
// second and a down one fails in ms — the ceiling only binds a cold model
const KEV_DONE_TIMEOUT_MS = 3_000;
// token law: the note is a headline for an inbox, not a report (the W822
// pulse digest reads the events, not prose)
const NOTE_MAX_CHARS = 280;

/** done note: title + short sha, then the caveman-condensed summary +
 *  description. Lazy blam import — an unresolvable workspace link must never
 *  break `work done`; the fallback is the raw one-line note. */
export async function condenseDoneNote(o: {
	title: string;
	summary?: string | null;
	description?: string | null;
	sha?: string | null;
}): Promise<string> {
	const head = `done: ${o.title.trim()}${o.sha ? ` @${o.sha.slice(0, 8)}` : ""}`;
	const body = [o.summary?.trim(), o.description?.trim()]
		.filter(Boolean)
		.join(" — ");
	let note = body ? `${head} — ${body}` : head;
	try {
		const { condenseTier } = await import("@klh/blam/src/condense/tiers.ts");
		note = condenseTier("caveman", note).text;
	} catch {
		// blam unresolvable from this install — the raw note stays
	}
	const oneLine = note.replace(/\s+/g, " ").trim();
	return oneLine.length > NOTE_MAX_CHARS
		? `${oneLine.slice(0, NOTE_MAX_CHARS - 1)}…`
		: oneLine;
}

/** kev SystemOne pass: which label, or fail-open "interesting". Never
 *  throws; never blocks longer than the kev-cold ceiling. */
export async function kevRelevance(text: string): Promise<KevLabel> {
	const d = await kevTypedDecision({
		state: text,
		question:
			"A work item just landed DONE and was broadcast to live fleet lanes. Classify the broadcast.",
		options: [
			{
				label: "actionable-now",
				tradeoff:
					"a live lane should act or verify now (own surface touched, merge or decision pending)",
			},
			{
				label: "interesting",
				tradeoff: "context worth absorbing, no action needed",
			},
			{ label: "noise", tradeoff: "routine landing, ignore" },
		],
		timeoutMs: KEV_DONE_TIMEOUT_MS,
	});
	if (!d) return "interesting"; // kev down / malformed — fail-open
	return (KEV_LABELS as readonly string[]).includes(d.choice)
		? (d.choice as KevLabel)
		: "interesting";
}

export interface DoneBroadcastResult {
	id: string;
	label: KevLabel;
	targets: number;
	note: string;
	deduped?: boolean;
}

/** Total function: the done handler's broadcast. Returns null instead of
 *  throwing — a broadcast failure must never fail `work done`. */
export async function emitDoneBroadcast(
	store: GovernorStore,
	o: {
		id: string;
		title: string;
		sha?: string | null;
		summary?: string | null;
		description?: string | null;
		source?: string;
		now?: number;
	},
): Promise<DoneBroadcastResult | null> {
	try {
		// hub deploys emit nothing — coord is machine-local by construction
		if (process.env.KLH_HUB_NAME) return null;
		// test/operator kill switch (pin in fixture env, W670)
		if (process.env.SUSPENDERS_DONE_BROADCAST === "0") return null;
		const note = await condenseDoneNote(o);
		const label = await kevRelevance(note);
		const sent = broadcastNote(
			store,
			note,
			o.source ?? "work-done",
			o.now ?? Date.now(),
			{ kev: label },
		);
		return {
			id: sent.id,
			label,
			targets: sent.targets,
			note,
			deduped: sent.deduped,
		};
	} catch {
		return null;
	}
}
