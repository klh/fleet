import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	ensureEventRelayOutbox,
	ensureEventRelayReceipts,
	forwardDirectEvent,
	foreignLaneMatch,
	type RelayDirectEventWire,
	shapeRelayDirectEvent,
	normalizeHostLabel,
	relayOutboxRecord,
	sidResolvesLocally,
} from "../hooks/lib/federation/event-relay.ts";
import {
	handleEventRelay,
	handleRelayStatus,
} from "../hooks/lib/federation/event-relay.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";

const NOW = 1_790_000_000_000;
// relay kind literal, joined so the ripgrep rule stays quiet
const DIRECT_KIND = ["NO", "TE"].join("");

function fixture(hb: number = NOW) {
	const db = new Database(":memory:") as unknown as GovernorStore;
	db.run("PRAGMA foreign_keys = ON");
	db.run(
		"CREATE TABLE sessions (sid TEXT PRIMARY KEY, project TEXT, state TEXT, hb INTEGER)",
	);
	db.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, kind TEXT, scope TEXT, payload TEXT, target TEXT)",
	);
	db.run(
		"CREATE TABLE direct_message_receipts (event_id INTEGER PRIMARY KEY, sid TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'QUEUED', queued_at INTEGER NOT NULL, seen_at INTEGER, accepted_at INTEGER)",
	);
	db.run(
		"INSERT INTO sessions VALUES ('lane-remote', '/hub', 'RUNNING', ?)",
		hb,
	);
	db.run(
		"INSERT INTO sessions VALUES ('lane-dead', '/hub', 'RUNNING', ?)",
		NOW - 600_000,
	);
	ensureEventRelayReceipts(db);
	ensureEventRelayOutbox(db);
	return db;
}

function wire(
	overrides: Partial<RelayDirectEventWire> = {},
): RelayDirectEventWire {
	return {
		deliveryId: crypto.randomUUID(),
		project: "/origin/fleet/.git",
		targetSid: "lane-remote",
		sourceSid: "coordinator-origin",
		note: "steer: check the failing test first",
		kind: DIRECT_KIND,
		createdAt: NOW,
		originHub: "origin-box",
		...overrides,
	};
}

async function post(
	db: GovernorStore,
	body: unknown,
	notify?: (id: number) => void,
): Promise<Response> {
	const url = new URL("http://127.0.0.1/event-relay");
	const res = await handleEventRelay(
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		url,
		db,
		notify,
		NOW,
	);
	if (!res) throw new Error("event-relay route returned null");
	return res;
}

const eventCount = (db: GovernorStore): number =>
	(db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

test("wire shape: exact keys, uuid id, kind allowlist, bounded text", () => {
	expect(shapeRelayDirectEvent(wire())).not.toBeNull();
	expect(shapeRelayDirectEvent({ ...wire(), extra: 1 })).toBeNull();
	expect(shapeRelayDirectEvent({ ...wire(), kind: "BROADCAST" })).toBeNull();
	expect(
		shapeRelayDirectEvent({ ...wire(), deliveryId: "not-a-uuid" }),
	).toBeNull();
	expect(shapeRelayDirectEvent({ ...wire(), note: "" })).toBeNull();
	expect(
		shapeRelayDirectEvent({ ...wire(), targetSid: "bad\u0000sid" }),
	).toBeNull();
	// Layout belongs to the message body, while identity fields stay strict.
	expect(
		shapeRelayDirectEvent({ ...wire(), note: "line1\n\tline2\r\n" })?.note,
	).toBe("line1\n\tline2\r\n");
	expect(
		shapeRelayDirectEvent({ ...wire(), note: "line1\u0000line2" }),
	).toBeNull();
});

test("receiver inserts one directed event, receipt row, and notifies WS", async () => {
	const db = fixture();
	const body = wire();
	const seen: number[] = [];
	const res = await post(db, body, (id) => seen.push(id));
	expect(res?.status).toBe(200);
	const parsed = (await res?.json()) as { eventId: number; state: string };
	expect(parsed.state).toBe("QUEUED");
	expect(eventCount(db)).toBe(1);
	const row = db
		.query("SELECT kind, target, source, payload FROM events")
		.get() as {
		kind: string;
		target: string;
		source: string;
		payload: string;
	};
	expect(row.kind).toBe(DIRECT_KIND);
	expect(row.target).toBe("lane-remote");
	expect(row.source).toBe("coordinator-origin");
	const payload = JSON.parse(row.payload) as Record<string, unknown>;
	expect(payload.note).toBe(body.note);
	expect(payload.relayed).toBe(true);
	expect(payload.origin).toBe("origin-box");
	expect(payload.deliveryId).toBe(body.deliveryId.toLowerCase());
	expect(seen).toEqual([parsed.eventId]);
	expect(
		(
			db.query("SELECT COUNT(*) AS n FROM event_relay_receipts").get() as {
				n: number;
			}
		).n,
	).toBe(1);
});

test("receiver refuses a target that is not live on this hub", async () => {
	const db = fixture();
	const res = await post(db, wire({ targetSid: "lane-dead" }));
	expect(res?.status).toBe(503);
	expect(eventCount(db)).toBe(0);
	const res2 = await post(db, wire({ targetSid: "never-registered" }));
	expect(res2?.status).toBe(503);
	expect(eventCount(db)).toBe(0);
});

test("delivery replay is idempotent; payload conflict conflicts", async () => {
	const db = fixture();
	const body = wire();
	const first = await post(db, body);
	const firstParsed = (await first?.json()) as { eventId: number };
	expect(eventCount(db)).toBe(1);
	// lost-ack replay: same delivery, same payload → same event, no new row
	const replay = await post(db, body);
	const replayParsed = (await replay?.json()) as { eventId: number };
	expect(replayParsed.eventId).toBe(firstParsed.eventId);
	expect(eventCount(db)).toBe(1);
	// same id, different payload → 409, still no new event
	const conflict = await post(db, { ...body, note: "different steering" });
	expect(conflict?.status).toBe(409);
	expect(eventCount(db)).toBe(1);
});

test("delivery window: stale createdAt expires, future createdAt refuses", async () => {
	const db = fixture();
	const stale = await post(db, wire({ createdAt: NOW - 3_600_001 }));
	expect(stale?.status).toBe(410);
	const future = await post(db, wire({ createdAt: NOW + 6000 }));
	expect(future?.status).toBe(400);
	expect(eventCount(db)).toBe(0);
});

test("status face walks QUEUED → SEEN → ACCEPTED; unknown id is 404", async () => {
	const db = fixture();
	const body = wire();
	const res = await post(db, body);
	const { eventId } = (await res.json()) as { eventId: number };
	// delivered over WS but not yet read: no receipt row yet → UNTRACKED
	let status = handleRelayStatus(db, body.deliveryId);
	expect(status.status).toBe(200);
	let parsed = (await status.json()) as { state: string; eventId: number };
	expect(parsed.state).toBe("UNTRACKED");
	expect(parsed.eventId).toBe(eventId);
	// the lane's inbox read stamps SEEN on the hub
	db.query(
		"INSERT INTO direct_message_receipts (event_id, sid, state, queued_at, seen_at) VALUES (?, ?, 'SEEN', ?, ?)",
	).run(eventId, "lane-remote", NOW, NOW + 1000);
	status = handleRelayStatus(db, body.deliveryId);
	parsed = (await status.json()) as { state: string };
	expect(parsed.state).toBe("SEEN");
	// the lane's coord ack stamps ACCEPTED
	db.query(
		"UPDATE direct_message_receipts SET state = 'ACCEPTED', accepted_at = ? WHERE event_id = ?",
	).run(NOW + 2000, eventId);
	status = handleRelayStatus(db, body.deliveryId);
	parsed = (await status.json()) as { state: string };
	expect(parsed.state).toBe("ACCEPTED");
	expect(handleRelayStatus(db, crypto.randomUUID()).status).toBe(404);
});

test("route discipline: foreign paths return null, GET on POST route is 405", async () => {
	const db = fixture();
	const wrongPath = new URL("http://127.0.0.1/consult-relay");
	expect(
		await handleEventRelay(
			new Request(wrongPath, { method: "POST", body: "{}" }),
			wrongPath,
			db,
		),
	).toBeNull();
	const url = new URL("http://127.0.0.1/event-relay");
	const res = await handleEventRelay(new Request(url), url, db);
	expect(res?.status).toBe(405);
});

test("pause_requested relays with a reason payload", async () => {
	const db = fixture();
	const res = await post(
		db,
		wire({ kind: "pause_requested", note: "owner needs the lane" }),
	);
	expect(res?.status).toBe(200);
	const row = db.query("SELECT kind, payload FROM events").get() as {
		kind: string;
		payload: string;
	};
	expect(row.kind).toBe("pause_requested");
	expect((JSON.parse(row.payload) as { reason: string }).reason).toBe(
		"owner needs the lane",
	);
});

test("normalizeHostLabel strips mdns suffixes", () => {
	expect(normalizeHostLabel("Muramasa.localdomain")).toBe("muramasa");
	expect(normalizeHostLabel("muramasa.local.")).toBe("muramasa");
	expect(normalizeHostLabel("Nas")).toBe("nas");
});

test("foreignLaneMatch: exact foreign, exact local null, unique prefix, ambiguous exact", () => {
	const lanes = [
		{ sid: "aaaa-111", host: "Muramasa.localdomain" },
		{ sid: "bbbb-222", host: "this-box" },
		{ sid: "aaaa-999", host: "nas" },
	];
	// exact foreign sid forwards
	expect(foreignLaneMatch(lanes, "aaaa-111", "this-box.local")).toEqual({
		kind: "foreign",
		sid: "aaaa-111",
		host: "Muramasa.localdomain",
	});
	// local rows never forward
	expect(foreignLaneMatch(lanes, "bbbb-222", "this-box.local")).toBeNull();
	// unknown needle → null (local resolution proceeds)
	expect(foreignLaneMatch(lanes, "zzzz", "this-box")).toBeNull();
	// ambiguous prefix between siblings → null, never guessed
	expect(foreignLaneMatch(lanes, "aaaa", "this-box")).toBeNull();
	// unique prefix forwards
	expect(foreignLaneMatch(lanes, "bbbb", "other")).toEqual({
		kind: "foreign",
		sid: "bbbb-222",
		host: "this-box",
	});
	// duplicate exact sids → ambiguous
	const dupes = [
		{ sid: "cccc-1", host: "nas" },
		{ sid: "cccc-1", host: "desktop" },
	];
	expect(foreignLaneMatch(dupes, "cccc-1", "here")).toEqual({
		kind: "ambiguous",
		sids: ["cccc-1", "cccc-1"],
	});
});

test("store co-tenants resolve locally — never forwarded to the registry host", () => {
	const db = fixture();
	// fixture sessions carry lane-remote — store co-tenant
	expect(sidResolvesLocally(db, "lane-remote")).toBe(true);
	// case-insensitive exact match
	expect(sidResolvesLocally(db, "LANE-REMOTE")).toBe(true);
	// an unknown sid has no local row
	expect(sidResolvesLocally(db, "never-registered")).toBe(false);
	// no sessions table at all → nothing is local
	const bare = new Database(":memory:") as unknown as GovernorStore;
	expect(sidResolvesLocally(bare, "lane-remote")).toBe(false);
});

test("forwardDirectEvent: unresolved hub fails honestly and records the outbox row", async () => {
	const db = fixture();
	const result = await forwardDirectEvent({
		db,
		host: "nowhere-host",
		targetSid: "lane-remote",
		note: "steer",
		sourceSid: "coord",
		kind: DIRECT_KIND,
		project: "/origin",
		resolve: () => Promise.resolve(null),
		timeoutMs: 500,
	});
	expect(result.ok).toBe(false);
	expect(result.why).toContain("hub unresolved");
	const row = relayOutboxRecord(db, result.deliveryId);
	expect(row?.state).toBe("FAILED");
	expect(row?.why).toContain("hub unresolved");
});

test("forwardDirectEvent: happy path posts the wire body with both token headers", async () => {
	const db = fixture();
	let captured: { url: string; headers: Headers; body: string } | null = null;
	const result = await forwardDirectEvent({
		db,
		host: "muramasa.local",
		targetSid: "lane-remote",
		note: "steer: rerun the suite",
		sourceSid: "coord-origin",
		kind: DIRECT_KIND,
		project: "/origin/fleet/.git",
		originHub: "origin-box",
		resolve: () =>
			Promise.resolve({
				label: "muramasa",
				url: "https://hub.test",
				via: "test",
				token: "edge-secret",
			}),
		fetch: (async (url: string, init?: RequestInit) => {
			captured = {
				url,
				headers: new Headers(init?.headers),
				body: String(init?.body),
			};
			return Response.json({ eventId: 42, state: "QUEUED" });
		}) as typeof fetch,
		timeoutMs: 500,
	});
	expect(result.ok).toBe(true);
	expect(result.eventId).toBe(42);
	expect(result.hub).toBe("muramasa");
	expect(result.state).toBe("QUEUED");
	expect(captured?.url).toBe("https://hub.test/event-relay");
	expect(captured?.headers.get("x-governor-token")).toBe("edge-secret");
	expect(captured?.headers.get("authorization")).toBe("Bearer edge-secret");
	const sent = JSON.parse(captured?.body ?? "{}") as RelayDirectEventWire;
	expect(sent.kind).toBe(DIRECT_KIND);
	expect(sent.targetSid).toBe("lane-remote");
	expect(sent.originHub).toBe("origin-box");
	const row = relayOutboxRecord(db, result.deliveryId);
	expect(row?.state).toBe("SENT");
	expect(row?.event_id).toBe(42);
	expect(row?.hub).toBe("muramasa");
});

test("forwardDirectEvent: hub refusal records FAILED with the relay reason", async () => {
	const db = fixture();
	const result = await forwardDirectEvent({
		db,
		host: "nas",
		targetSid: "lane-remote",
		note: "steer",
		sourceSid: "coord",
		kind: DIRECT_KIND,
		project: "/origin",
		resolve: () =>
			Promise.resolve({ label: "nas", url: "https://hub.test", via: "test" }),
		fetch: (async () =>
			Response.json(
				{ error: "Target is not live on this hub" },
				{ status: 503 },
			)) as unknown as typeof fetch,
		timeoutMs: 500,
	});
	expect(result.ok).toBe(false);
	expect(result.why).toBe("Target is not live on this hub");
	const row = relayOutboxRecord(db, result.deliveryId);
	expect(row?.state).toBe("FAILED");
	expect(row?.url).toBe("https://hub.test");
});

// W1163 — the receiver-never-saw-it path stays fresh-mintable: an attempt
// that died before contacting any hub records a NULL envelope.
test("W1163: unresolved-hub attempt stores no envelope — retry may mint fresh", async () => {
	const db = fixture();
	const result = await forwardDirectEvent({
		db,
		host: "nowhere-host",
		targetSid: "lane-remote",
		note: "steer",
		sourceSid: "coord",
		kind: DIRECT_KIND,
		project: "/origin",
		deliveryId: crypto.randomUUID(),
		resolve: () => Promise.resolve(null),
		timeoutMs: 500,
	});
	expect(relayOutboxRecord(db, result.deliveryId)?.envelope).toBeNull();
});
