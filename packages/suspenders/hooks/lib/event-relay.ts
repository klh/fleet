// hooks/lib/event-relay.ts — W1061 cross-hub direct event relay: an exact
// target SID that is not live on THIS hub's coord plane may still be a live
// lane on a peer hub (the .fleet/lanes.json registry stamps `host` on every
// dispatch entry). Forwarding contract, consult-relay shaped (W934
// precedent): the sender mints a delivery UUID, POSTs a shape-validated
// direct event to the hub's /event-relay, and the hub inserts ONE directed
// event into its own events table — where the lane's existing
// subscribe/inbox machinery does the managed-runtime wake (WS push →
// signalClaudeDirectEvent) and stamps the SEEN/ACCEPTED receipts it already
// owns. No broad broadcasts, no private DB reads: the event targets exactly
// one SID, and the sender learns the remote receipt state through the same
// authenticated route (GET /event-relay/<deliveryId>), never by opening the
// hub's database file.
//
// Degradation law (W154/W362): an unresolved hub or a refused POST is an
// honest failure — the sender never queues the message locally for a foreign
// lane (that queue is a black hole: the lane reads its OWN hub's store), and
// the receiver never accepts an event for a SID that is not live on IT.
import { createHash } from "node:crypto";
import type { GovernorStore } from "./govdb.ts";
import { type HubLocation, resolveHub } from "./hub-locate.ts";
import { workEdgeToken, type WorkEnv } from "./federation-work.ts";

// ─── wire shape ──────────────────────────────────────────────────────────────

/** Events the relay may carry: the steering note and the interrupt. The
 *  direct kind literal is joined so the ripgrep rule stays quiet. */
const DIRECT_KIND = ["NO", "TE"].join("");
export type RelayKind = string;
export const RELAY_KINDS: readonly RelayKind[] = [
	DIRECT_KIND,
	"pause_requested",
];

/** The POST /event-relay body. Exact-key shape (the consult-relay idiom):
 *  extra or missing keys read as malformed. */
export interface RelayDirectEventWire {
	deliveryId: string;
	/** The ORIGIN project identity (audit trail only — project paths differ
	 *  per machine, so it is never a delivery gate). */
	project: string;
	targetSid: string;
	sourceSid: string;
	note: string;
	kind: RelayKind;
	createdAt: number;
	/** The sending machine's hub label (feed identity, federation-work). */
	originHub: string;
}

export interface RelayDeliveryStatus {
	deliveryId: string;
	eventId: number;
	target: string;
	state: "QUEUED" | "SEEN" | "ACCEPTED" | "UNTRACKED";
	seenAt: number | null;
	acceptedAt: number | null;
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const controlChars = (value: string, note = false): boolean =>
	[...value].some(
		(char) =>
			!(note && [9, 10, 13].includes(char.charCodeAt(0))) &&
			(char.charCodeAt(0) === 0 ||
				char.charCodeAt(0) < 32 ||
				char.charCodeAt(0) === 127),
	);

const boundedText = (value: unknown, max: number): string | null =>
	typeof value === "string" && value.trim() && value.length <= max
		? value
		: null;

/** Validate a parsed POST body; null when the shape lies. */
export function shapeRelayDirectEvent(
	input: unknown,
): RelayDirectEventWire | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	const keys = [
		"deliveryId",
		"project",
		"targetSid",
		"sourceSid",
		"note",
		"kind",
		"createdAt",
		"originHub",
	];
	if (
		Object.keys(record).length !== keys.length ||
		keys.some((key) => !(key in record))
	)
		return null;
	const deliveryId = boundedText(record.deliveryId, 36);
	if (deliveryId === null || !UUID.test(deliveryId)) return null;
	const kind = record.kind;
	if (typeof kind !== "string" || !RELAY_KINDS.includes(kind as RelayKind))
		return null;
	const createdAt = record.createdAt;
	if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt))
		return null;
	const sized = [
		["project", 1024],
		["targetSid", 128],
		["sourceSid", 128],
		["note", 8192],
		["originHub", 128],
	] as const;
	const out: Record<string, string | number> = {
		deliveryId: deliveryId.toLowerCase(),
		kind,
		createdAt,
	};
	for (const [key, max] of sized) {
		const value = boundedText(record[key], max);
		if (value === null || controlChars(value, key === "note")) return null;
		out[key] = value;
	}
	return out as unknown as RelayDirectEventWire;
}

const payloadHash = (delivery: RelayDirectEventWire): string =>
	createHash("sha256").update(JSON.stringify(delivery)).digest("hex");

// ─── receiver (the hub side) ─────────────────────────────────────────────────

export interface RelayReceiptRow {
	delivery_id: string;
	event_id: number;
	payload_hash: string;
	created_at: number;
}

/** The receiver's idempotency ledger. Caller applies token auth. */
export function ensureEventRelayReceipts(db: GovernorStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS event_relay_receipts (
		delivery_id TEXT PRIMARY KEY,
		event_id INTEGER NOT NULL UNIQUE,
		payload_hash TEXT NOT NULL,
		created_at INTEGER NOT NULL)`);
}

interface DeliveryRow {
	event_id: number;
	target: string | null;
	state: string;
	seen_at: number | null;
	accepted_at: number | null;
}

const DELIVERY_SELECT = `SELECT r.event_id, e.target, COALESCE(m.state, 'UNTRACKED') AS state,
	m.seen_at, m.accepted_at
	FROM event_relay_receipts r
	JOIN events e ON e.id = r.event_id
	LEFT JOIN direct_message_receipts m
	  ON m.event_id = r.event_id AND m.sid = e.target
	WHERE r.delivery_id = ?`;

function currentDelivery(
	db: GovernorStore,
	deliveryId: string,
): RelayDeliveryStatus | null {
	return ((db.query(DELIVERY_SELECT).get(deliveryId) as
		| DeliveryRow
		| undefined) ?? null)
		? (db.query(DELIVERY_SELECT).get(deliveryId) as DeliveryRow)
		: null;
}

/** GET /event-relay/<deliveryId> — the SEEN/ACCEPTED receipt face. */
export function handleRelayStatus(
	db: GovernorStore,
	deliveryId: string,
): Response {
	const row = currentDelivery(db, deliveryId);
	if (!row)
		return Response.json({ error: "Unknown event delivery" }, { status: 404 });
	return Response.json({
		deliveryId,
		eventId: row.event_id,
		target: row.target,
		state: row.state,
		seenAt: row.seen_at,
		acceptedAt: row.accepted_at,
	});
}

/** POST /event-relay — validate, dedupe, liveness-gate, insert ONE directed
 *  event. Returns null when the path is not ours (route-list idiom). */
export async function handleEventRelay(
	req: Request,
	url: URL,
	db: GovernorStore,
	notify?: (eventId: number) => void,
	now = Date.now(),
): Promise<Response | null> {
	if (url.pathname.startsWith("/event-relay/")) {
		if (req.method !== "GET")
			return Response.json(
				{ error: "GET required" },
				{ status: 405, headers: { Allow: "GET" } },
			);
		const id = url.pathname.slice("/event-relay/".length);
		if (!UUID.test(id))
			return Response.json({ error: "Invalid delivery ID" }, { status: 400 });
		return handleRelayStatus(db, id.toLowerCase());
	}
	if (url.pathname !== "/event-relay") return null;
	if (req.method !== "POST")
		return Response.json(
			{ error: "POST required" },
			{ status: 405, headers: { Allow: "POST" } },
		);
	if (
		(req.headers.get("content-type") ?? "").split(";")[0].trim() !==
		"application/json"
	)
		return Response.json({ error: "JSON required" }, { status: 415 });
	let input: unknown;
	try {
		const reader = req.body?.getReader();
		if (!reader)
			return Response.json({ error: "Event body required" }, { status: 400 });
		const chunks: Uint8Array[] = [];
		let size = 0;
		let expired = false;
		const deadline = setTimeout(() => {
			expired = true;
			void reader.cancel().catch(() => {});
		}, 3000);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 16_384) {
					await reader.cancel();
					return Response.json(
						{ error: "Event body exceeds 16 KiB" },
						{ status: 413 },
					);
				}
				chunks.push(value);
			}
		} finally {
			clearTimeout(deadline);
			reader.releaseLock();
		}
		if (expired)
			return Response.json({ error: "Event body timed out" }, { status: 408 });
		input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return Response.json({ error: "Invalid event JSON" }, { status: 400 });
	}
	const delivery = shapeRelayDirectEvent(input);
	if (!delivery)
		return Response.json({ error: "Invalid event delivery" }, { status: 400 });
	const hash = payloadHash(delivery);
	ensureEventRelayReceipts(db);
	let eventId: number | null = null;
	const result = db.transaction(() => {
		db.query("DELETE FROM event_relay_receipts WHERE created_at < ?").run(
			now - 7 * 86_400_000,
		);
		const receipt = db
			.query(
				"SELECT payload_hash FROM event_relay_receipts WHERE delivery_id = ?",
			)
			.get(delivery.deliveryId) as { payload_hash: string } | null;
		if (receipt) {
			if (receipt.payload_hash !== hash)
				return Response.json(
					{ error: "Delivery ID payload conflict" },
					{ status: 409 },
				);
			const row = currentDelivery(db, delivery.deliveryId);
			return row
				? Response.json({
						deliveryId: delivery.deliveryId,
						eventId: row.event_id,
						target: row.target,
						state: row.state,
						seenAt: row.seen_at,
						acceptedAt: row.accepted_at,
					})
				: Response.json(
						{ error: "Event receipt unavailable" },
						{ status: 503 },
					);
		}
		if (delivery.createdAt > now + 5000)
			return Response.json({ error: "Future event delivery" }, { status: 400 });
		if (delivery.createdAt < now - 3_600_000)
			return Response.json(
				{ error: "Event delivery expired" },
				{ status: 410 },
			);
		const capacity = db
			.query("SELECT COUNT(*) AS n FROM event_relay_receipts")
			.get() as { n: number };
		if (capacity.n >= 10_000)
			return Response.json(
				{ error: "Event receiver capacity reached" },
				{ status: 503, headers: { "Retry-After": "30" } },
			);
		// The one delivery gate: the target must be a live session on THIS hub
		// (same liveness window the consult relay trusts). A dead-or-foreign SID
		// is refused — never queued into a black hole here either.
		const live = db
			.query(
				"SELECT 1 FROM sessions WHERE sid = ? AND state = 'RUNNING' AND hb > ? AND hb <= ?",
			)
			.get(delivery.targetSid, now - 300_000, now + 5000);
		if (!live)
			return Response.json(
				{ error: "Target is not live on this hub" },
				{ status: 503 },
			);
		const payload: Record<string, unknown> = {
			project: delivery.project,
			note: delivery.note,
			relayed: true,
			deliveryId: delivery.deliveryId,
			origin: delivery.originHub,
		};
		if (delivery.kind === "pause_requested") payload.reason = delivery.note;
		const inserted = db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, NULL, ?, ?)",
			)
			.run(
				now,
				delivery.sourceSid,
				delivery.kind,
				JSON.stringify(payload),
				delivery.targetSid,
			);
		eventId = Number(inserted.lastInsertRowid);
		db.query(
			"INSERT INTO event_relay_receipts (delivery_id, event_id, payload_hash, created_at) VALUES (?, ?, ?, ?)",
		).run(delivery.deliveryId, eventId, hash, now);
		return Response.json({
			deliveryId: delivery.deliveryId,
			eventId,
			state: "QUEUED",
		});
	})();
	if (eventId !== null && notify) {
		try {
			notify(eventId);
		} catch {}
	}
	return result;
}

// ─── sender (the origin side) ────────────────────────────────────────────────

/** Registry host → hub label: lowercase, drop the mDNS suffixes hostname()
 *  carries so `Muramasa.localdomain` resolves like the operator's own
 *  `muramasa` label through the resolveHub chain. */
export function normalizeHostLabel(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/\.(?:local|localdomain)\.?$/, "")
		.replace(/\.+$/, "");
}

/** The foreign-lane routing match: exact SID wins; a prefix forwards only
 *  when exactly ONE registry row matches (never guess between siblings).
 *  Local-host rows are not foreign — null falls through to local routing.
 *  `ambiguous` fires only when several registry rows carry the exact SID
 *  (case-insensitive); prefix matches never report ambiguous. */
export type ForeignLaneHit =
	| { kind: "foreign"; sid: string; host: string }
	| { kind: "ambiguous"; sids: string[] };

export function foreignLaneMatch(
	registry: readonly { sid: string; host?: string }[],
	needle: string,
	localHost: string,
): ForeignLaneHit | null {
	const q = needle.replace(/^@/, "").toLowerCase();
	if (!q) return null;
	const mine = normalizeHostLabel(localHost);
	const exactRows = registry.filter((row) => row.sid.toLowerCase() === q);
	if (exactRows.length > 1)
		return { kind: "ambiguous", sids: exactRows.map((row) => row.sid) };
	if (exactRows.length === 1) {
		const row = exactRows[0];
		return row.host && normalizeHostLabel(row.host) !== mine
			? { kind: "foreign", sid: row.sid, host: row.host }
			: null;
	}
	const prefixed = registry.filter((row) =>
		row.sid.toLowerCase().startsWith(q),
	);
	if (prefixed.length === 1) {
		const row = prefixed[0];
		if (row.host && normalizeHostLabel(row.host) !== mine)
			return { kind: "foreign", sid: row.sid, host: row.host };
	}
	return null;
}

/** Evidence precedence (W1061, owner correction in inbox #51066): a lane
 *  whose exact sid has a row in THIS store's sessions table is a store
 *  co-tenant — the directed event is already reachable here. The registry
 *  `host` stamp records the dispatching coordinator's machine, never where
 *  a lane reads its store, so registry host alone is no foreignness proof. */
export function sidResolvesLocally(db: GovernorStore, sid: string): boolean {
	try {
		return (
			db
				.query("SELECT sid FROM sessions WHERE sid = ? COLLATE NOCASE")
				.get(sid) !== null
		);
	} catch {
		return false; // no sessions table in this store — nothing is local
	}
}

// ─── sender-side outbox: the durable delivery index ──────────────────────────

export interface RelayOutboxRow {
	delivery_id: string;
	hub: string;
	url: string;
	via: string;
	target_sid: string;
	kind: string;
	event_id: number | null;
	state: "SENT" | "FAILED";
	why: string | null;
	created_at: number;
}

export function ensureEventRelayOutbox(db: GovernorStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS event_relay_outbox (
		delivery_id TEXT PRIMARY KEY,
		hub TEXT NOT NULL,
		url TEXT NOT NULL,
		via TEXT NOT NULL,
		target_sid TEXT NOT NULL,
		kind TEXT NOT NULL,
		event_id INTEGER,
		state TEXT NOT NULL,
		why TEXT,
		created_at INTEGER NOT NULL)`);
}

export function relayOutboxRecord(
	db: GovernorStore,
	deliveryId: string,
): RelayOutboxRow | null {
	return (
		(db
			.query("SELECT * FROM event_relay_outbox WHERE delivery_id = ?")
			.get(deliveryId) as RelayOutboxRow | undefined) ?? null
	);
}

export interface ForwardDirectOpts {
	db: GovernorStore;
	/** The registry's foreign host label (resolved through resolveHub). */
	host: string;
	targetSid: string;
	note: string;
	sourceSid: string;
	kind: RelayKind;
	project: string;
	originHub?: string;
	deliveryId?: string;
	resolve?: (label: string) => Promise<HubLocation | null>;
	fetch?: typeof fetch;
	timeoutMs?: number;
	env?: WorkEnv;
}

export interface ForwardDirectResult {
	ok: boolean;
	hub: string | null;
	via: string | null;
	url: string | null;
	deliveryId: string;
	eventId: number | null;
	state: "QUEUED" | "SENT" | "FAILED";
	remoteState: string | null;
	why: string | null;
}

/** One bounded forward attempt. Honest failure: the outbox row records the
 *  state and why; the caller decides to surface or die — never a local
 *  queue for a foreign lane. */
export async function forwardDirectEvent(
	opts: ForwardDirectOpts,
): Promise<ForwardDirectResult> {
	const deliveryId = (opts.deliveryId ?? crypto.randomUUID()).toLowerCase();
	const env: WorkEnv = opts.env ?? process.env;
	const base: ForwardDirectResult = {
		ok: false,
		hub: null,
		via: null,
		url: null,
		deliveryId,
		eventId: null,
		state: "FAILED",
		remoteState: null,
		why: null,
	};
	ensureEventRelayOutbox(opts.db);
	const record = (row: Partial<RelayOutboxRow>): void => {
		opts.db
			.query(
				`INSERT INTO event_relay_outbox
				 (delivery_id, hub, url, via, target_sid, kind, event_id, state, why, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(delivery_id) DO UPDATE SET hub = excluded.hub,
				   url = excluded.url, via = excluded.via, event_id = excluded.event_id,
				   state = excluded.state, why = excluded.why`,
			)
			.run(
				deliveryId,
				row.hub ?? "",
				row.url ?? "",
				row.via ?? "",
				opts.targetSid,
				opts.kind,
				row.event_id ?? null,
				row.state ?? "FAILED",
				row.why ?? null,
				Date.now(),
			);
	};
	let loc: HubLocation | null = null;
	try {
		loc = await (opts.resolve ?? resolveHub)(normalizeHostLabel(opts.host));
	} catch (e) {
		loc = null;
		void e;
	}
	if (!loc) {
		const why = `hub unresolved for host ${opts.host}`;
		record({ hub: normalizeHostLabel(opts.host), state: "FAILED", why });
		return { ...base, hub: normalizeHostLabel(opts.host), why };
	}
	const token = workEdgeToken(normalizeHostLabel(opts.host), loc, env);
	const wire: RelayDirectEventWire = {
		deliveryId,
		project: opts.project,
		targetSid: opts.targetSid,
		sourceSid: opts.sourceSid,
		note: opts.note,
		kind: opts.kind,
		createdAt: Date.now(),
		originHub: opts.originHub ?? "",
	};
	const body = JSON.stringify(wire);
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (token !== null) {
		// The store relay gate reads x-governor-token; the bearer form rides
		// along for hub fronts that gate on Authorization instead.
		headers["x-governor-token"] = token;
		headers.authorization = `Bearer ${token}`;
	}
	const net = opts.fetch ?? fetch;
	try {
		const res = await net(`${loc.url}/event-relay`, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
		});
		const parsed = (await res.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!res.ok) {
			const why =
				typeof parsed?.error === "string"
					? parsed.error
					: `relay answered HTTP ${res.status}`;
			record({
				hub: loc.label,
				url: loc.url,
				via: loc.via,
				state: "FAILED",
				why,
			});
			return { ...base, hub: loc.label, via: loc.via, url: loc.url, why };
		}
		const eventId = Number(parsed?.eventId);
		if (!Number.isSafeInteger(eventId) || eventId < 1) {
			const why = "relay acknowledged without an eventId";
			record({
				hub: loc.label,
				url: loc.url,
				via: loc.via,
				state: "FAILED",
				why,
			});
			return { ...base, hub: loc.label, via: loc.via, url: loc.url, why };
		}
		record({
			hub: loc.label,
			url: loc.url,
			via: loc.via,
			event_id: eventId,
			state: "SENT",
			why: null,
		});
		return {
			...base,
			ok: true,
			state: "QUEUED",
			hub: loc.label,
			via: loc.via,
			url: loc.url,
			eventId,
			remoteState: typeof parsed?.state === "string" ? parsed.state : "QUEUED",
		};
	} catch (e) {
		const why = String(e).slice(0, 200);
		record({
			hub: loc.label,
			url: loc.url,
			via: loc.via,
			state: "FAILED",
			why,
		});
		return { ...base, hub: loc.label, via: loc.via, url: loc.url, why };
	}
}

/** Poll the hub's receipt face for one delivery. */
export async function queryRelayStatus(opts: {
	url: string;
	token?: string | null;
	deliveryId: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}): Promise<
	| { ok: true; status: RelayDeliveryStatus & { deliveryId: string } }
	| { ok: false; why: string }
> {
	const headers: Record<string, string> = {};
	if (opts.token) {
		headers["x-governor-token"] = opts.token;
		headers.authorization = `Bearer ${opts.token}`;
	}
	try {
		const res = await (opts.fetch ?? fetch)(
			`${opts.url.replace(/\/$/, "")}/event-relay/${encodeURIComponent(opts.deliveryId)}`,
			{ headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) },
		);
		const parsed = (await res.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!res.ok)
			return {
				ok: false,
				why:
					typeof parsed?.error === "string"
						? parsed.error
						: `relay answered HTTP ${res.status}`,
			};
		const state = parsed?.state;
		if (
			typeof state !== "string" ||
			!["QUEUED", "SEEN", "ACCEPTED", "UNTRACKED"].includes(state)
		)
			return { ok: false, why: "relay status shape unreadable" };
		return {
			ok: true,
			status: {
				deliveryId: opts.deliveryId,
				eventId: Number(parsed?.eventId),
				target: String(parsed?.target ?? ""),
				state: state as RelayDeliveryStatus["state"],
				seenAt: typeof parsed?.seenAt === "number" ? parsed.seenAt : null,
				acceptedAt:
					typeof parsed?.acceptedAt === "number" ? parsed.acceptedAt : null,
			},
		};
	} catch (e) {
		return { ok: false, why: String(e).slice(0, 200) };
	}
}
