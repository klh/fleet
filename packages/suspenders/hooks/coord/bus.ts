// hooks/coord/bus.ts — bus lifecycle: emit/broadcast + the ONE event-read
// core (readEvents/advanceCursor/formatEventLine) behind poll/wait/inbox,
// + lane state, pause/resume (W157 command modules).
// W652.2 consolidation: subscribe is THE event-read face (live WS push,
// W303); wait is its long-poll fallback (and the no-store subscribe path);
// poll is the one-shot manual read; inbox is the directed catch-up read.
// All four share one row-renderer and one cursor helper.
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.
import { statSync } from "node:fs";
import { hostname } from "node:os";
import { resolveStoreHttpBase } from "../lib/govdb.ts";
import { signalClaudeDirectEvent } from "../lib/claude-wake.ts";
import {
	codexThreadForSession,
	deliverSubscribedCodexEvent,
} from "../lib/codex-direct-delivery.ts";
import { steerCodexDirectEvent } from "../lib/codex-steer.ts";
import {
	type LaneRef,
	laneProcessIdentity,
	laneVerdict,
} from "../lib/lane-liveness.ts";
import { loadLaneRegistry } from "../lib/lane-registry.ts";
import {
	forwardDirectEvent,
	foreignLaneMatch,
	sidResolvesLocally,
	type ForeignLaneHit,
} from "../lib/event-relay.ts";
import { localHubLabel } from "../lib/federation-work.ts";
import { advanceCursor, fetchEventsPaged } from "./event-scan.ts";
import { emitStoredEvent, type EventPublication } from "./event-publish.ts";
import {
	type Ev,
	amber,
	arg,
	cyan,
	db,
	die,
	dim,
	green,
	projectIdentity,
	red,
} from "./shared.ts";

export const LIVE_HEARTBEAT_WINDOW_MS = 30 * 60_000;
// Mirrors govdb.ts's sweepStaleSessions liveTranscript window: a transcript
// (or lane log, for non-Claude dialects) written this recently means the
// process is genuinely still running.
const TRANSCRIPT_LIVE_WINDOW_MS = 15 * 60_000;

export interface LivenessRow {
	hb: number;
	parent_sid: string | null;
	role: string | null;
	transcript_path: string | null;
}

// isLiveSession: the ONE "is this RUNNING row actually still alive" check,
// shared by broadcast/targets/message so the three never disagree.
export function isLiveSession(row: LivenessRow, now = Date.now()): boolean {
	if (row.hb > now - LIVE_HEARTBEAT_WINDOW_MS) return true;
	if (row.parent_sid !== null) return false;
	if (row.transcript_path) {
		try {
			return (
				statSync(row.transcript_path).mtimeMs > now - TRANSCRIPT_LIVE_WINDOW_MS
			);
		} catch {
			// transcript missing/unreadable — fall through to the role check
		}
	}
	return row.role === "coordinator";
}

export function subscriberSessionAlive(sid: string, now = Date.now()): boolean {
	const row = db
		.query(
			"SELECT state, hb, transcript_path, project FROM sessions WHERE sid = ?",
		)
		.get(sid) as
		| {
				state: string;
				hb: number;
				transcript_path: string | null;
				project: string;
		  }
		| undefined;
	if (row?.state !== "RUNNING") return false;
	// A managed native conversation remains addressable while checkpointed
	// and idle. Its exact registered harness identity, never this subscriber
	// or a stale transcript, owns that lifetime.
	try {
		const lane = loadLaneRegistry<LaneRef>(row.project).find(
			(lane) => lane.sid === sid,
		);
		if (lane && laneProcessIdentity(lane) === true) return true;
	} catch {
		// Unknown registry/process identity cannot extend the freshness lease.
	}
	if (row.transcript_path) {
		try {
			if (
				statSync(row.transcript_path).mtimeMs >
				now - TRANSCRIPT_LIVE_WINDOW_MS
			)
				return true;
		} catch {
			// A missing path does not override a fresh registered heartbeat.
		}
	}
	return row.hb > now - LIVE_HEARTBEAT_WINDOW_MS;
}

export function emitEvent(opts: EventPublication): number {
	return emitStoredEvent(db, projectIdentity(), opts);
}

/** A directed event remains actionable even after WS/poll cursors advance. */
export function queueDirectedReceipt(eventId: number, sid: string): void {
	db.query(
		"INSERT INTO direct_message_receipts (event_id, sid, queued_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
	).run(eventId, sid, Date.now());
}

export function broadcastNote(
	note: string,
	source: string,
	now = Date.now(),
): { id: string; targets: number; deduped?: boolean } {
	// W470: note-dedupe — the same note re-broadcast within 24h returns the
	// earlier broadcast id instead of minting a new one (W438 C7: one note
	// re-minted again and again). SessionStart injection already covers late
	// joiners; a re-broadcast adds nothing but undrainable inbox rows.
	const prior = (
		db
			.query(
				"SELECT payload FROM events WHERE kind = 'BROADCAST' AND ts >= ? ORDER BY id DESC",
			)
			.all(now - 24 * 3_600_000) as { payload: string | null }[]
	).find((r) => {
		try {
			return JSON.parse(r.payload ?? "{}").note === note;
		} catch {
			return false;
		}
	});
	if (prior) {
		const priorId = (JSON.parse(prior.payload ?? "{}") as { id?: string }).id;
		if (priorId) return { id: priorId, targets: 0, deduped: true };
	}
	const bid = `b${now}`;
	const targets = (
		db
			.query(
				"SELECT sid, hb, parent_sid, role, transcript_path FROM sessions WHERE state = 'RUNNING'",
			)
			.all() as (LivenessRow & { sid: string })[]
	).filter((row) => isLiveSession(row, now));
	const ins = db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'BROADCAST', NULL, ?, ?)",
	);
	for (const target of targets)
		ins.run(now, source, JSON.stringify({ id: bid, note }), target.sid);
	const upsert = db.query(
		"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
	);
	upsert.run(`broadcast.${bid}`, note, now);
	upsert.run(
		"broadcast.latest",
		JSON.stringify({ id: bid, ts: now, note }),
		now,
	);
	return { id: bid, targets: targets.length };
}

export async function cmdEmit(rest: string[]): Promise<void> {
	const kind = rest[0];
	if (!kind)
		die(
			'usage: emit <kind> [--to sid] [--scope s] [--sha x] [--note "..."] [--field=value ...] [--as sid]',
		);
	const scope = arg("--scope");
	const sha = arg("--sha");
	const note = arg("--note");
	const source = arg("--as") ?? "unknown";
	const to = arg("--to");
	// arbitrary --key=value passthrough: the event IS the completion report
	// (e.g. --gate=pass --artifact=stale) — one source of truth, no retelling
	const extra: Record<string, string> = {};
	for (const t of rest.slice(1)) {
		const m = /^--([\w-]+)=(.+)$/.exec(t);
		if (m && !["scope", "sha", "note", "as", "to"].includes(m[1]))
			extra[m[1]] = m[2];
	}
	const id = emitEvent({ kind, scope, sha, note, source, to, extra });
	console.log(
		`${green("✓")} ${dim(`event queued #${id} → ${to ? `@${to.slice(0, 8)}` : "bus"}`)}`,
	);
}

export async function cmdBroadcast(_rest: string[]): Promise<void> {
	// fleet-wide rules notice: live lanes receive it in their inbox on the
	// next poll; future sessions get it injected once at SessionStart
	// (facts broadcast.latest + broadcast.seen.<sid> watermark)
	const note = arg("--note");
	if (!note) die('usage: broadcast --note "..." [--as sid]');
	const source = arg("--as") ?? "owner";
	const sent = broadcastNote(note, source);
	console.log(
		sent.deduped
			? `${green("✓")} broadcast ${sent.id} already live (deduped, 24h window) — no new inbox rows`
			: `${green("✓")} broadcast ${sent.id} → ${sent.targets} live session(s) (inbox; they poll) — everyone else gets it at SessionStart`,
	);
}

// ─── the ONE event read (W652.2) ────────────────────────────────────────────
// subscribe rides the store's WS push (store-server.ts mirrors this exact
// filter); wait/poll/inbox read the table through here — one query, one
// read-filter contract: a consumer sees broadcasts + anything directed
// at it; cursor advancement is event-scan.advanceCursor (examined-advance)
export function readEvents(opts: {
	as?: string | null; // consumer sid: sees broadcasts + anything directed at it
	since: number; // cursor value — rows with id > since
	scope?: string | null;
	kinds?: string[];
	directedOnly?: boolean; // inbox mode: only rows addressed to `as`
}): Ev[] {
	let rows = opts.directedOnly
		? (db
				.query(
					"SELECT e.id, e.ts, e.source, e.kind, e.scope, e.payload FROM events e WHERE e.target = ? AND e.id > ? AND NOT EXISTS (SELECT 1 FROM direct_message_receipts r WHERE r.event_id = e.id AND r.sid = ? AND r.state = 'ACCEPTED') ORDER BY e.id",
				)
				.all(opts.as, opts.since, opts.as) as Ev[])
		: opts.as
			? (db
					.query(
						"SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND (target IS NULL OR target = ?) ORDER BY id",
					)
					.all(opts.since, opts.as) as Ev[])
			: (db
					.query(
						"SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND target IS NULL ORDER BY id",
					)
					.all(opts.since) as Ev[]);
	const scope = opts.scope;
	if (scope)
		rows = rows.filter(
			(r) =>
				r.scope &&
				(r.scope === scope ||
					scopeCovers(r.scope, scope) ||
					scopeCovers(scope, r.scope)),
		);
	const kinds = opts.kinds;
	if (kinds?.length) rows = rows.filter((r) => kinds.includes(r.kind));
	return rows;
}

// age glyph for the catch-up reads (poll, events); live faces (wait,
// subscribe) print rows as they arrive and need none
export function ageOf(ms: number): string {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3_600) return `${Math.floor(s / 60)}m`;
	if (s < 86_400) return `${Math.floor(s / 3_600)}h`;
	return `${Math.floor(s / 86_400)}d`;
}

export async function cmdPoll(_rest: string[]): Promise<void> {
	const as = arg("--as");
	const scope = arg("--scope");
	const kinds = arg("--kinds")?.split(",").filter(Boolean) ?? [];
	const limit = Number(arg("--limit") ?? 50);
	const cur = as
		? (db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null)
		: null;
	const since = cur?.event_id ?? 0;
	// keyset pages past the cursor (W644): per-row scope/kinds filtering, stop
	// at limit; the cursor advances to the last row EXAMINED below — a
	// rejected row can never match again, and nothing unexamined is skipped.
	// A consumer with --as sees broadcasts + anything directed at it.
	const { shown: rows, examined } = fetchEventsPaged({
		since,
		as,
		scope,
		kinds,
		limit,
	});
	for (const r of rows) {
		const { sha, note, ...restP } = r.payload
			? (JSON.parse(r.payload) as Record<string, string>)
			: {};
		const ago = Math.max(0, Math.round((Date.now() - r.ts) / 1000));
		const extra = Object.entries(restP)
			.map(([k, v]) => `${dim(`${k}=`)}${v}`)
			.join(" ");
		console.log(
			`  ${dim(`#${r.id}`)} ${dim(`${ago}s`.padStart(4))}  ${cyan(r.kind.padEnd(18))}${dim(r.source.slice(0, 8).padEnd(9))}${r.scope ? `${r.scope}  ` : ""}${sha ? green(`@${sha.slice(0, 8)}  `) : ""}${Object.keys(restP).length ? `${extra}  ` : ""}${note ? dim(`— ${note}`) : ""}`,
		);
	}
	// advance past every EXAMINED row (shown or filtered) — never beyond; a
	// dormant lane pays one page per poll instead of the whole bus tail
	if (as) advanceCursor(as, since, examined);
	if (!rows.length) console.log(dim("(no new events)"));
}

// shared by cmdWait (poll) and cmdSubscribe (WS push) — one row-rendering so
// the two paths can never visually drift apart.
export function formatEventLine(r: Ev): string {
	const { sha, note, ...restP } = r.payload
		? (JSON.parse(r.payload) as Record<string, string>)
		: {};
	const extra = Object.entries(restP)
		.map(([k, v]) => `${dim(`${k}=`)}${v}`)
		.join(" ");
	return `  ${dim(`#${r.id}`)} ${r.source.slice(0, 8)} ${cyan(r.kind)}${r.scope ? ` ${r.scope}` : ""}${sha ? green(`@${sha.slice(0, 8)}`) : ""}${Object.keys(restP).length ? `  ${extra}` : ""}${note ? dim(` — ${note}`) : ""}`;
}

export async function cmdWait(rest: string[]): Promise<void> {
	// the fallback face (W652.2): adaptive long-poll — 250ms while events
	// flow, backing off to 2s when idle; resets to fast the moment anything
	// arrives. --forever is the persistent fallback face: one process stays
	// the live watcher for a whole session; subscribe rides it when no HTTP
	// store is bound. Near-instant coordination without a broker daemon.
	const as =
		arg("--as") ??
		die(
			"usage: wait --as <sid> [--scope s] [--kinds a,b] [--max-seconds 30] [--forever]",
		);
	const scope = arg("--scope");
	const kinds = arg("--kinds")?.split(",").filter(Boolean) ?? [];
	const forever = rest.includes("--forever");
	const deadline = Date.now() + Number(arg("--max-seconds") ?? 30) * 1000;
	let interval = 250;
	for (;;) {
		const cur =
			(
				db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
					event_id: number;
				} | null
			)?.event_id ?? 0;
		// keyset pages per tick (W644): the wait loop re-scans from its cursor
		// every interval — pages keep a stale cursor from re-paying the tail
		const { shown: rows, examined } = fetchEventsPaged({
			since: cur,
			as,
			scope,
			kinds,
		});
		if (rows.length) {
			for (const r of rows) {
				console.log(formatEventLine(r));
			}
			// advance past every EXAMINED row (shown or filtered) — the filters
			// are fixed for this invocation, so rejected rows never match again
			advanceCursor(as, cur, examined);
			if (!forever) process.exit(0);
			interval = 250; // a hit resets the backoff same as the non-forever path
			continue;
		}
		if (!forever && Date.now() > deadline) {
			console.log("(timeout, no events)");
			process.exit(0);
		}
		await new Promise((r) => setTimeout(r, interval));
		interval = Math.min(interval * 2, 2000); // back off while idle; resets by activity above
	}
}

// W303 — THE event-read face (W652.2): one WebSocket to the store server's
// /subscribe route, printed as events arrive through the same renderer as
// every other read. The open socket keeps the process alive on its own —
// no sleep loop, no exit, no relaunch, ever. Falls back to cmdWait --forever
// when no HTTP store is bound (GOVERNOR_STORE_URL=local dev mode has no
// server to connect to) — wait is the face's fallback, not a peer.
/** Re-deliver only the current durable lifecycle control after a WS gap.
 * Receipt acceptance and lifecycle transitions remain worker-owned. */
export function subscriberPendingControl(sid: string) {
	const state = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${sid}.state`) as { value: string } | null;
	const kind =
		state?.value === "RESUME_READY"
			? "resume_ready"
			: state?.value === "PAUSE_REQUESTED"
				? "pause_requested"
				: null;
	if (!kind) return null;
	return db
		.query(
			"SELECT e.id, e.ts, e.source, e.kind, e.scope, e.payload, e.target FROM events e WHERE e.target = ? AND e.kind = ? AND NOT EXISTS (SELECT 1 FROM direct_message_receipts r WHERE r.event_id = e.id AND r.sid = ? AND r.state = 'ACCEPTED') ORDER BY e.id DESC LIMIT 1",
		)
		.get(sid, kind, sid) as (Ev & { target: string }) | null;
}

export async function cmdSubscribe(rest: string[]): Promise<void> {
	const as =
		arg("--as") ?? die("usage: subscribe --as <sid> [--scope s] [--kinds a,b]");
	const scope = arg("--scope");
	const kinds = arg("--kinds") ?? "";
	const bound = resolveStoreHttpBase();
	if (!bound) {
		console.log(
			"(no HTTP store bound — falling back to poll; set GOVERNOR_STORE_URL for live push)",
		);
		return cmdWait([...rest, "--forever"]);
	}
	const wsBase = bound.base.replace(/^http/, "ws");
	const params = new URLSearchParams({ as });
	if (scope) params.set("scope", scope);
	if (kinds) params.set("kinds", kinds);
	if (bound.token) params.set("token", bound.token);
	let backoff = 500;
	// Order direct events for this session; a later consult must not overtake
	// an earlier direct message while app-server RPC is still in flight.
	let delivery = Promise.resolve();
	const connect = (): void => {
		const ws = new WebSocket(`${wsBase}/subscribe?${params}`);
		ws.addEventListener("open", () => {
			backoff = 500; // a clean connect resets the reconnect backoff
			// WebSocket push contains future events only. A pause/resume emitted
			// during disconnection is durable, but otherwise never wakes native.
			try {
				const pending = subscriberPendingControl(as);
				if (pending) signalClaudeDirectEvent(pending, as);
			} catch {
				console.error(
					"coord subscribe: durable control catch-up failed; reconnecting",
				);
				ws.close();
			}
		});
		ws.addEventListener("message", (e) => {
			const event = JSON.parse(String(e.data)) as Ev & {
				target?: string | null;
			};
			console.log(formatEventLine(event));
			if (event.target !== as) return;
			signalClaudeDirectEvent({ ...event, target: as }, as);
			delivery = delivery
				.then(async () => {
					const threadId = codexThreadForSession(db, as);
					if (!threadId) return;
					const proxy = process.env.SUSPENDERS_CODEX_BIN;
					const result = await deliverSubscribedCodexEvent(
						event,
						as,
						threadId,
						proxy
							? (direct, opts) =>
									steerCodexDirectEvent(direct, {
										...opts,
										command: [proxy, "app-server", "proxy"],
									})
							: undefined,
					);
					console.error(
						`coord Codex delivery #${event.id}: ${result.state}${result.state === "steered" ? ` turn=${result.turnId}` : ` ${result.reason}`}; Fleet inbox remains durable`,
					);
				})
				.catch((error) => {
					console.error(
						`coord Codex delivery #${event.id}: queued ${String(error)}`,
					);
				});
		});
		ws.addEventListener("close", () => {
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 10_000);
		});
		ws.addEventListener("error", () => ws.close());
	};
	connect();
	// W494: a subscribe outliving its session IS the ghost-lane factory —
	// launchd adopts it (PPID 1), it pins the lane worktree cwd and a
	// .claude-ish arg forever, and every liveness probe then reads its row
	// as live. Exit when the session's transcript goes stale (the same
	// 15-min mtime floor `work reclaim` trusts); a live session's jsonl
	// keeps growing, so this never fires under a working session.
	const sessionStaleness = setInterval(() => {
		if (!subscriberSessionAlive(as)) {
			clearInterval(sessionStaleness);
			process.exit(0);
		}
	}, 30_000);
	await new Promise<void>(() => {}); // live for the process's whole life
}

export async function cmdState(_rest: string[]): Promise<void> {
	// between-rounds check for a lane: canonical state + inbox + current HEAD
	const as = arg("--as") ?? die("usage: state --as <sid>");
	const st = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.state`) as { value: string } | null;
	const head = db
		.query("SELECT value FROM facts WHERE key = 'integration.head'")
		.get() as { value: string } | null;
	const ncur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	const pending = db
		.query("SELECT COUNT(*) AS n FROM events WHERE target = ? AND id > ?")
		.get(as, ncur) as { n: number };
	console.log(
		`state=${st?.value ?? "RUNNING"}  inbox=${pending.n}  head=${head?.value ?? dim("unknown")}`,
	);
}

export async function cmdInbox(rest: string[]): Promise<void> {
	// directed catch-up read: everything addressed to --as past the cursor;
	// the cursor moves only with --ack. W652.2: rows render via the ONE
	// formatEventLine (source glyph added — same shape as wait/subscribe).
	const as = arg("--as") ?? die("usage: inbox --as <sid> [--ack]");
	const ncur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(as) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	const fresh = readEvents({ as, since: ncur, directedOnly: true });
	const unaccepted = db
		.query(
			"SELECT e.id, e.ts, e.source, e.kind, e.scope, e.payload FROM direct_message_receipts r JOIN events e ON e.id = r.event_id WHERE r.sid = ? AND r.state != 'ACCEPTED' ORDER BY e.id",
		)
		.all(as) as Ev[];
	const rows = [
		...new Map([...unaccepted, ...fresh].map((r) => [r.id, r])).values(),
	].sort((a, b) => a.id - b.id);
	const lastShown = rows.reduce((last, row) => Math.max(last, row.id), 0);
	const shownIds = JSON.stringify(rows.map((row) => row.id));
	for (const r of rows) console.log(formatEventLine(r));
	if (rows.length) {
		const receiptKinds = [
			["NO", "TE"].join(""),
			"consult",
			"consult.answer",
			"NEED_DECISION",
		];
		for (const row of rows)
			if (receiptKinds.includes(row.kind)) queueDirectedReceipt(row.id, as);
		db.query(
			"UPDATE direct_message_receipts SET state = 'SEEN', seen_at = COALESCE(seen_at, ?) WHERE sid = ? AND event_id IN (SELECT value FROM json_each(?)) AND state = 'QUEUED'",
		).run(Date.now(), as, shownIds);
	}
	if (rest.includes("--ack")) {
		if (rows.length)
			db.query(
				"UPDATE direct_message_receipts SET state = 'ACCEPTED', seen_at = COALESCE(seen_at, ?), accepted_at = ? WHERE sid = ? AND event_id IN (SELECT value FROM json_each(?)) AND state != 'ACCEPTED'",
			).run(Date.now(), Date.now(), as, shownIds);
		advanceCursor(as, ncur, rows.length ? lastShown : ncur);
	}
	if (!rows.length) console.log(dim("(inbox empty)"));
}

/** Accept exactly one addressed event. Unlike inbox --ack, this does not
 * advance the shared read cursor or accept any other pending event. */
export async function cmdAck(rest: string[]): Promise<void> {
	const as = arg("--as") ?? die("usage: ack <event-id> --as <sid>");
	const raw = rest[0]?.replace(/^#/, "");
	const eventId = Number(raw);
	if (!raw || !Number.isSafeInteger(eventId) || eventId <= 0)
		die("usage: ack <event-id> --as <sid>");
	const event = db
		.query("SELECT target FROM events WHERE id = ?")
		.get(eventId) as { target: string | null } | null;
	if (!event || event.target !== as)
		die(`event #${eventId} is not addressed to ${as}`);
	queueDirectedReceipt(eventId, as);
	db.query(
		"UPDATE direct_message_receipts SET state = 'ACCEPTED', seen_at = COALESCE(seen_at, ?), accepted_at = COALESCE(accepted_at, ?) WHERE event_id = ? AND sid = ?",
	).run(Date.now(), Date.now(), eventId, as);
	console.log(`${green("✓")} accepted #${eventId} for ${as}`);
}

/** Read one delivery receipt without relying on a database query. */
export async function cmdReceipt(rest: string[]): Promise<void> {
	const as =
		arg("--as") ?? die("usage: receipt <event-id> --as <sid> [--json]");
	const raw = rest[0]?.replace(/^#/, "");
	const eventId = Number(raw);
	if (!raw || !Number.isSafeInteger(eventId) || eventId <= 0)
		die("usage: receipt <event-id> --as <sid> [--json]");
	const row = db
		.query(
			"SELECT e.id, e.kind, e.source, e.target, r.state, r.queued_at, r.seen_at, r.accepted_at FROM events e LEFT JOIN direct_message_receipts r ON r.event_id = e.id WHERE e.id = ?",
		)
		.get(eventId) as
		| {
				id: number;
				kind: string;
				source: string;
				target: string | null;
				state: string | null;
				queued_at: number | null;
				seen_at: number | null;
				accepted_at: number | null;
		  }
		| undefined;
	if (!row?.target || (row.source !== as && row.target !== as))
		die(`event #${eventId} is not a direct event involving ${as}`);
	const receipt = {
		id: row.id,
		kind: row.kind,
		source: row.source,
		target: row.target,
		state: row.state ?? "UNTRACKED",
		queued_at: row.queued_at,
		seen_at: row.seen_at,
		accepted_at: row.accepted_at,
	};
	if (rest.includes("--json")) console.log(JSON.stringify(receipt));
	else
		console.log(
			`#${eventId} ${receipt.kind} ${receipt.state} → ${receipt.target}`,
		);
}

// W831: the interrupt's miss report — 'interrupted' as a STICKY terminal
// state fact + the lane.interrupted event receipt. Nothing re-arms it; the
// claim converges via the reclaim sweep instead of a PAUSE_REQUESTED hanging
// unacked forever.
function markInterrupted(
	sid: string,
	source: string,
	scope: string | null,
	reason: string | null,
): void {
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(`lane.${sid}.state`, "INTERRUPTED", source, Date.now());
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'lane.interrupted', ?, ?, ?)",
	).run(
		Date.now(),
		source,
		scope,
		JSON.stringify({
			...(reason ? { reason } : {}),
			note: "no live process for this lane — sticky terminal",
		}),
		sid,
	);
	console.log(
		`${red("✖")} ${dim(`interrupted → @${sid.slice(0, 8)} — no live process; sticky terminal`)}`,
	);
}

export async function cmdPause(rest: string[]): Promise<void> {
	// cooperative preemption: PAUSE_REQUESTED is interrupt-class and goes out
	// immediately — the lane finishes its atomic edit, checkpoints, writes a
	// continuation capsule, marks PAUSED, then waits.
	// W831 interrupt double-check: the event targets sid by construction, so
	// the interrupt proceeds on the PAUSE_REQUESTED path only when a live
	// child process for that lane exists (registry row + the shared
	// lane-liveness verdict). On miss the interrupt reports 'interrupted' as
	// a STICKY terminal state — ghost running states converge instead of a
	// PAUSE_REQUESTED hanging unacked forever. --force is the explicit
	// operator override.
	const sid = rest[0];
	const reason = arg("--reason");
	if (!sid || !reason)
		die(
			'usage: pause <sid> --reason "why" [--scope s] [--intervention "what is coming"] [--force]',
		);
	const scope = arg("--scope");
	const intervention = arg("--intervention");
	const source = arg("--as") ?? "coordinator";
	// W1061 interrupt forwarding: a foreign-host registry row means the lane
	// runs on a peer hub — its managed-runtime wake lives THERE. Forward the
	// pause through the hub relay (the delivery face reports SEEN/ACCEPTED);
	// a local sticky-interrupt would be a verdict about a machine we cannot
	// probe. Unresolved hub or refused relay dies honestly — never a fake
	// local interruption state for a lane we cannot see.
	{
		let lanes: LaneRef[] = [];
		try {
			lanes = loadLaneRegistry(process.cwd());
		} catch {}
		const hit = foreignLaneMatch(lanes, sid, hostname());
		if (hit?.kind === "ambiguous")
			die(
				`ambiguous registry match for ${JSON.stringify(sid)} — ${hit.sids.join(" | ")}`,
			);
		if (hit?.kind === "foreign") {
			// Owner correction (inbox #51066): registry host is dispatch-side
			// provenance, not store residence. A co-tenant sid resolves here.
			if (!sidResolvesLocally(db, hit.sid)) {
				await forwardPauseRequest(hit, sid, reason, source);
				return;
			}
		}
	}
	if (!rest.includes("--force")) {
		const entry = loadLaneRegistry<LaneRef>(process.cwd()).find(
			(l) => l.sid === sid,
		);
		const live = entry ? laneVerdict(entry) : null;
		if (live !== "alive") {
			markInterrupted(sid, source, scope, reason);
			return;
		}
	}
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'pause_requested', ?, ?, ?)",
	).run(
		Date.now(),
		source,
		scope,
		JSON.stringify({
			...(reason ? { reason } : {}),
			...(intervention ? { intervention } : {}),
		}),
		sid,
	);
	// canonical lane state: RUNNING → PAUSE_REQUESTED (→ PAUSED by the lane itself)
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.' || ? || '.state', 'PAUSE_REQUESTED', ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = 'PAUSE_REQUESTED', source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(sid, source, Date.now());
	console.log(`${amber("⏸")} ${dim(`pause_requested → @${sid.slice(0, 8)}`)}`);
}

// W1061 — the foreign-host leg of `coord pause`: forward the interrupt
// through the lane's own hub relay. Dies honestly on an unresolved hub or a
// refused relay (no fake local interruption state for a lane we cannot see).
async function forwardPauseRequest(
	hit: Extract<ForeignLaneHit, { kind: "foreign" }>,
	sid: string,
	reason: string,
	source: string,
): Promise<void> {
	const result = await forwardDirectEvent({
		db,
		host: hit.host,
		targetSid: hit.sid,
		note: reason,
		sourceSid: source,
		kind: "pause_requested",
		project: projectIdentity(),
		originHub: localHubLabel(),
	});
	if (!result.ok)
		die(
			`pause not forwarded to foreign lane @${sid.slice(0, 8)} on host ${hit.host}: ${result.why}`,
		);
	console.log(
		`${amber("⏸")} ${dim(`pause_requested forwarded → ${result.hub} lane @${sid.slice(0, 8)} delivery ${result.deliveryId}`)}`,
	);
	console.log(dim(`receipt face: coord delivery ${result.deliveryId}`));
}

export async function cmdPaused(_rest: string[]): Promise<void> {
	// the LANE's own transition: PAUSE_REQUESTED → PAUSED. Requires proof of a
	// safe boundary: checkpoint SHA (--sha) AND a written capsule. A model
	// cannot skip the restart context by accident. W885: the receipt targets
	// the lane's own sid — a literal target never matches the WS/inbox
	// directed filter (store-server.ts: row.target !== f.as), so the row
	// orphans; same contract as lane.interrupted.
	const as =
		arg("--as") ??
		die("usage: paused --as <sid> --sha <checkpoint-sha> [--step s]");
	const sha =
		arg("--sha") ??
		die("paused requires --sha <checkpoint-sha> — no checkpoint, no pause");
	const cap = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.capsule`) as { value: string } | null;
	if (!cap)
		die(
			"no continuation capsule — `coord capsule set` before pausing (restart context is mandatory)",
		);
	let capsule: { checkpoint?: string } = {};
	try {
		capsule = JSON.parse(cap.value) as { checkpoint?: string };
	} catch {}
	if (capsule.checkpoint !== sha)
		die(
			`capsule checkpoint (${capsule.checkpoint ?? "none"}) ≠ --sha ${sha} — write a fresh capsule for THIS checkpoint`,
		);
	const st = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.state`) as { value: string } | null;
	if (st?.value !== "PAUSE_REQUESTED")
		die(
			`lane state is ${st?.value ?? "RUNNING"}, not PAUSE_REQUESTED — nothing to acknowledge`,
		);
	db.query(
		"UPDATE facts SET value = 'PAUSED', source = ?, version = version + 1, ts = ? WHERE key = ?",
	).run(as, Date.now(), `lane.${as}.state`);
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'paused', ?, ?, ?)",
	).run(
		Date.now(),
		as,
		arg("--scope"),
		JSON.stringify({ sha, ...(arg("--step") ? { step: arg("--step") } : {}) }),
		as,
	);
	console.log(
		`${amber("⏸")} ${dim(`PAUSED @${sha.slice(0, 8)} — capsule + checkpoint banked`)}`,
	);
}

export async function cmdResume(rest: string[]): Promise<void> {
	// in-band change landed: RESUME_READY carries the delta summary; clears the
	// pause fact. Refuses when the lane never reached PAUSED — never race a
	// working lane.
	const sid = rest[0];
	const onto = arg("--onto");
	if (!sid || !onto)
		die(
			'usage: resume <sid> --onto <sha> [--diff-from <pause-base>] [--note "delta summary"]',
		);
	const paused = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${sid}.state`) as { value: string } | null;
	if (paused?.value !== "PAUSED")
		die(
			`lane @${sid.slice(0, 8)} state is ${paused?.value ?? "RUNNING"} — resume requires PAUSED (never race a working lane)`,
		);
	const diffFrom = arg("--diff-from");
	let changed: string[] = [];
	if (diffFrom) {
		const d = Bun.spawnSync(
			["git", "diff", "--name-status", `${diffFrom}..${onto}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		changed = new TextDecoder()
			.decode(d.stdout)
			.split("\n")
			.filter((l) => l.trim())
			.slice(0, 30)
			.map((l) => l.replace(/\t/g, " "));
	}
	const source = arg("--as") ?? "coordinator";
	db.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'resume_ready', ?, ?, ?)",
	).run(
		Date.now(),
		source,
		arg("--scope"),
		JSON.stringify({
			onto,
			...(paused ? { pausedAt: paused.value } : {}),
			...(changed.length ? { changed } : {}),
			...(arg("--note") ? { note: arg("--note") } : {}),
		}),
		sid,
	);
	// PAUSED → RESUME_READY (the worker reconciles, then confirms via `resumed`)
	db.query(
		"INSERT INTO facts (key, value, source, version, ts) VALUES ('lane.' || ? || '.state', 'RESUME_READY', ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = 'RESUME_READY', source = excluded.source, version = version + 1, ts = excluded.ts",
	).run(sid, source, Date.now());
	console.log(
		`${green("↻")} ${dim(`resume_ready → @${sid.slice(0, 8)} onto ${onto.slice(0, 8)}${changed.length ? ` (${changed.length} files changed)` : ""}`)}`,
	);
}

export async function cmdResumed(_rest: string[]): Promise<void> {
	// the worker's confirmation: RESUME_READY → RUNNING (worktree reconciled,
	// targeted tests green)
	const as = arg("--as") ?? die("usage: resumed --as <sid>");
	const st = db
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`lane.${as}.state`) as { value: string } | null;
	if (st?.value !== "RESUME_READY")
		die(`lane state is ${st?.value ?? "RUNNING"} — nothing to resume-confirm`);
	db.query(
		"UPDATE facts SET value = 'RUNNING', source = ?, version = version + 1, ts = ? WHERE key = ?",
	).run(as, Date.now(), `lane.${as}.state`);
	console.log(
		`${green("▶")} ${dim(`RUNNING — @${as.slice(0, 8)} reconciled and re-uptaken`)}`,
	);
}

export async function cmdResumeSession(_rest: string[]): Promise<void> {
	// ownership rebind for `claude -c` continuations: the runtime hands the
	// resumed session a fresh id — move ownership forward atomically so the
	// session wakes owning what it owned before (never re-derive from Markdown)
	const as = arg("--as");
	const from = arg("--from");
	if (!as || !from || as === from)
		die("usage: resume-session --as <new-sid> --from <old-sid>");
	const old = db
		.query("SELECT project, role, worktree FROM sessions WHERE sid = ?")
		.get(from) as
		| { project: string | null; role: string | null; worktree: string | null }
		| undefined;
	if (!old) die(`no known session: ${from} — nothing to rebind`);
	const proj = old.project ?? projectIdentity();
	const now = Date.now();
	let wMoved = 0;
	let cMoved = 0;
	let fMoved = 0;
	let eMoved = 0;
	db.transaction(() => {
		wMoved = db
			.query(
				"UPDATE work_items SET owner_sid = ?, updated_at = ? WHERE project = ? AND owner_sid = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED','FAILED')",
			)
			.run(as, now, proj, from).changes;
		cMoved = db
			.query(
				"INSERT INTO claims (sid, scope, intent, hot, ts, tp) SELECT ?, scope, intent, hot, ts, tp FROM claims WHERE sid = ? ON CONFLICT DO NOTHING",
			)
			.run(as, from).changes;
		db.query("DELETE FROM claims WHERE sid = ?").run(from);
		const facts = db
			.query("SELECT key FROM facts WHERE key LIKE ?")
			.all(`lane.${from}.%`) as { key: string }[];
		for (const f of facts) {
			const nk = f.key.replace(`lane.${from}.`, `lane.${as}.`);
			db.query(
				"INSERT INTO facts (key, value, source, version, ts) SELECT ?, value, source, version + 1, ? FROM facts WHERE key = ? ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
			).run(nk, now, f.key);
			db.query("DELETE FROM facts WHERE key = ?").run(f.key);
			fMoved++;
		}
		// unconsumed directed events follow the inbox: everything past the old
		// cursor re-targets the new sid, so pending messages aren't stranded
		const oldCur =
			(
				db.query("SELECT event_id FROM cursors WHERE sid = ?").get(from) as {
					event_id: number;
				} | null
			)?.event_id ?? 0;
		eMoved = db
			.query("UPDATE events SET target = ? WHERE target = ? AND id > ?")
			.run(as, from, oldCur).changes;
		const cur = db
			.query("SELECT event_id FROM cursors WHERE sid = ?")
			.get(from) as { event_id: number } | null;
		if (cur && !db.query("SELECT 1 FROM cursors WHERE sid = ?").get(as))
			db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(
				as,
				cur.event_id,
			);
		db.query("UPDATE sessions SET state = 'CLOSED', hb = ? WHERE sid = ?").run(
			now,
			from,
		);
		db.query(
			"INSERT INTO sessions (sid, project, role, parent_sid, worktree, started_at, hb, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING') ON CONFLICT(sid) DO UPDATE SET project = excluded.project, role = excluded.role, parent_sid = excluded.parent_sid, worktree = excluded.worktree, hb = excluded.hb, state = 'RUNNING'",
		).run(as, proj, old.role ?? "worker", from, old.worktree, now, now);
	})();
	console.log(
		`✓ ${from.slice(0, 8)} → ${as.slice(0, 8)}  work:${wMoved} claims:${cMoved} facts:${fMoved} events:${eMoved} (cursor carried, ${from.slice(0, 8)} CLOSED)`,
	);
}
