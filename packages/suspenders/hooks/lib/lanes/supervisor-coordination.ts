// hooks/lib/lanes/supervisor-coordination.ts — W977.1: the bounded supervisor
// coordination trigger and its WS consult contract. A supervisor at a
// decision point (claims, shared work, capacity) fires a bounded peer round
// through `coord coordinate`: one OPEN round per (asker, topic) — repeats
// REPLAY it (singleflight) — per-asker rate-capped, fanned to at most
// maxPeers live peers, deadline-stamped like every consult. The topic rides
// the durable question text (`coordinate/<topic>: <note>`) so consumers
// (singleflight, /api/outbox, the W977.2 benchmark scorer) parse it without
// a schema change. Kev rides OUTBOUND only: with --classify the trigger
// asks the typed-decision specialist ask-vs-skip via `coord coordinate
// --classify`; unavailable → the local bounds decide (degrade open).
// Inbound consults are answered via consult-reply and never fire a round
// reflexively.
import type { Database } from "bun:sqlite";
import { kevTypedDecision } from "../knowledge/kev.ts";

export const COORD_TOPICS = ["work", "claims", "capacity"] as const;
export type CoordTopic = (typeof COORD_TOPICS)[number];

export interface CoordBounds {
	maxPeers: number;
	rateWindowMs: number;
	rateMax: number;
}

// env knobs, not code (config-over-code; routes-consult idiom)
export const coordBounds = (): CoordBounds => ({
	maxPeers: Number(process.env.SUSPENDERS_COORD_MAX_PEERS ?? 2) || 2,
	rateWindowMs:
		Number(process.env.SUSPENDERS_COORD_RATE_WINDOW_MS ?? 60_000) || 60_000,
	rateMax: Number(process.env.SUSPENDERS_COORD_RATE_MAX ?? 3) || 3,
});

// ─── wire format ───
// The topic prefix is the contract's discriminator; the colon+space after the
// topic keeps the note verbatim-parsable (`coordinate/capacity: 2 ready 0
// lanes` → topic "capacity", note "2 ready 0 lanes").
export const TOPIC_PREFIX = "coordinate/";

export const questionFor = (topic: CoordTopic, note: string): string =>
	`${TOPIC_PREFIX}${topic}: ${note}`;

export function topicOf(question: string): CoordTopic | null {
	if (!question.startsWith(TOPIC_PREFIX)) return null;
	const t = (question.slice(TOPIC_PREFIX.length).split(":", 1)[0] ?? "").trim();
	return (COORD_TOPICS as readonly string[]).includes(t)
		? (t as CoordTopic)
		: null;
}

export interface Peer {
	sid: string;
	hb: number;
	role: string | null;
}

// ─── peer selection ───
// Live peers = RUNNING sessions of the project, asker excluded, external
// connectors excluded (this is the LOCAL supervisor plane — W931's HTTP
// ingress carries externals), paused lanes excluded (the facts pause row is
// the pause source of truth). Most-recently-active first.
export function livePeers(
	db: Database,
	project: string,
	as: string,
	maxPeers: number,
): Peer[] {
	try {
		const rows = db
			.query(
				"SELECT sid, hb, role FROM sessions WHERE project = ? AND state = 'RUNNING' AND sid != ? AND (role IS NULL OR role != 'external') ORDER BY hb DESC",
			)
			.all(project, as) as Peer[];
		const paused = new Set(
			(
				db
					.query(
						"SELECT key FROM facts WHERE key LIKE 'lane.%.state' AND value IN ('PAUSED','WAIT_RATE','WAIT_DED')",
					)
					.all() as { key: string }[]
			).map((r) => r.key.slice(5, -6)),
		);
		return rows.filter((r) => !paused.has(r.sid)).slice(0, maxPeers);
	} catch {
		return []; // no graph tables (tests, fresh installs) — nobody to ask
	}
}

// ─── asker state snapshot ───
// The payload carries the asker's claim/READY state so a peer answers
// without re-deriving it (share state BY REFERENCE, never retelling).
export interface AskerSnapshot {
	claims: string[];
	ready: number;
}

export function askerSnapshot(
	db: Database,
	project: string,
	as: string,
): AskerSnapshot {
	try {
		const claims = (
			db
				.query(
					"SELECT id FROM work_items WHERE project = ? AND owner_sid = ? AND state IN ('CLAIMED','RUNNING') ORDER BY updated_at DESC",
				)
				.all(project, as) as { id: string }[]
		).map((r) => r.id);
		const ready = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM work_items WHERE project = ? AND state = 'READY'",
				)
				.get(project) as { n: number }
		).n;
		return { claims, ready };
	} catch {
		return { claims: [], ready: 0 }; // no graph tables — empty snapshot
	}
}

// ─── singleflight + rate cap ───
// One OPEN round per (asker, topic): a repeat ask REPLAYS the open consult —
// joiners get one round, per the federation contract's herd control.
export function openRound(
	db: Database,
	project: string,
	as: string,
	topic: CoordTopic,
): { id: number } | null {
	try {
		const r = db
			.query(
				"SELECT id FROM consults WHERE project = ? AND asker_sid = ? AND state = 'OPEN' AND question LIKE ? ORDER BY id DESC LIMIT 1",
			)
			.get(project, as, `${TOPIC_PREFIX}${topic}: %`) as { id: number } | null;
		return r ?? null;
	} catch {
		return null;
	}
}

export function roundsInWindow(
	db: Database,
	project: string,
	as: string,
	windowMs: number,
): number {
	try {
		return (
			db
				.query(
					"SELECT COUNT(DISTINCT question) AS n FROM consults WHERE project = ? AND asker_sid = ? AND question LIKE 'coordinate/%' AND created_at > ?",
				)
				.get(project, as, Date.now() - windowMs) as { n: number }
		).n;
	} catch {
		return 0;
	}
}

// ─── the outbound Kev gate ───
// --classify asks the typed-decision specialist ONCE (ask-vs-skip). Every
// failure degrades open: the local bounds are the binding contract.
export async function coordinationGate(input: {
	topic: CoordTopic;
	note: string;
	snapshot: AskerSnapshot;
	classify: boolean;
	timeoutMs?: number;
}): Promise<{ fired: boolean; via: "kev" | "bounds" | "kev-skip" }> {
	if (!input.classify) return { fired: true, via: "bounds" };
	const d = await kevTypedDecision({
		state: `topic=${input.topic} claims=${input.snapshot.claims.length} ready=${input.snapshot.ready} note=${input.note}`,
		question:
			"Should this supervisor fire a peer coordination round now, or is the ask premature/noise?",
		options: [
			{
				label: "ask",
				tradeoff:
					"peers plausibly hold matching work, capacity or claims; a bounded round is worth the interrupt",
			},
			{
				label: "skip",
				tradeoff:
					"premature or noisy ask; answer from local facts and skip the round",
			},
		],
		timeoutMs: input.timeoutMs ?? 5_000,
	});
	if (!d) return { fired: true, via: "bounds" };
	return {
		fired: d.choice !== "skip",
		via: d.choice === "skip" ? "kev-skip" : "kev",
		model: d.model,
	};
}
