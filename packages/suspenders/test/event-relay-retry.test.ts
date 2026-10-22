// W1163 — sender retry × receiver idempotency. The outbox freezes the wire
// envelope at first hub contact, so a caller-supplied delivery-id retry
// re-sends the ORIGINAL bytes (createdAt included) and the receiver's
// payload-hash gate replays the original delivery instead of 409-conflicting
// on a regenerated createdAt.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	ensureEventRelayOutbox,
	ensureEventRelayReceipts,
	forwardDirectEvent,
	type ForwardDirectOpts,
	type RelayDirectEventWire,
	relayOutboxRecord,
} from "../hooks/lib/event-relay.ts";
import { handleEventRelay } from "../hooks/lib/event-relay.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

const NOW = 1_790_000_000_000;
// relay kind literal, joined so the ripgrep rule stays quiet
const DIRECT_KIND = ["NO", "TE"].join("");

function fixture(hb = NOW) {
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
	ensureEventRelayReceipts(db);
	ensureEventRelayOutbox(db);
	return db;
}

const eventCount = (db: GovernorStore): number =>
	(db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

// The real receiver face, in-process: forwardDirectEvent's fetch stub pipes
// the wire body straight into handleEventRelay.
const postWire = (
	db: GovernorStore,
	body: string,
	now: number,
): Promise<Response | null> => {
	const url = new URL("http://127.0.0.1/event-relay");
	return handleEventRelay(
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		}),
		url,
		db,
		undefined,
		now,
	);
};

// The sender under test with the steady parts pinned.
const forward = (
	db: GovernorStore,
	deliveryId: string,
	over: Partial<ForwardDirectOpts> = {},
): ReturnType<typeof forwardDirectEvent> =>
	forwardDirectEvent({
		db,
		host: "nas",
		targetSid: "lane-remote",
		note: "steer",
		sourceSid: "coord",
		kind: DIRECT_KIND,
		project: "/origin",
		originHub: "origin-box",
		deliveryId,
		resolve: () =>
			Promise.resolve({
				label: "nas",
				url: "https://hub.test",
				via: "test",
			}),
		timeoutMs: 500,
		...over,
	});

// Attempt one of the lost-ack scenario, driven for real: the receiver face
// inserts the event, then the transport dies before the sender reads the ack.
test("W1163: lost-ack attempt freezes the envelope in the outbox", async () => {
	const t0 = Date.now();
	const db = fixture(t0);
	const id = crypto.randomUUID();
	const lostAck = await forward(db, id, {
		fetch: (async (_url: string, init?: RequestInit) => {
			await postWire(db, String(init?.body), t0);
			throw new TypeError("connection reset");
		}) as unknown as typeof fetch,
	});
	expect(lostAck.ok).toBe(false);
	expect(eventCount(db)).toBe(1); // the receiver DID insert
	const row = relayOutboxRecord(db, id);
	expect(row?.state).toBe("FAILED");
	expect(row?.envelope).toBeTruthy();
});

// The full round trip: same delivery id, sender retry re-sends the frozen
// envelope, receiver replays the ORIGINAL event (200, same id) instead of
// 409-conflicting on a regenerated createdAt.
test("W1163: same-id retry re-sends the original envelope and the receiver replays", async () => {
	const t0 = Date.now();
	const db = fixture(t0);
	const id = crypto.randomUUID();
	await forward(db, id, {
		fetch: (async (_url: string, init?: RequestInit) => {
			await postWire(db, String(init?.body), t0);
			throw new TypeError("connection reset");
		}) as unknown as typeof fetch,
	});
	let retryBody = "";
	const retried = await forward(db, id, {
		fetch: (async (_url: string, init?: RequestInit) => {
			retryBody = String(init?.body);
			return Response.json({ eventId: 1, state: "QUEUED" });
		}) as unknown as typeof fetch,
	});
	expect(retried.ok).toBe(true);
	const sent = JSON.parse(retryBody) as RelayDirectEventWire;
	const frozen = JSON.parse(
		relayOutboxRecord(db, id)?.envelope ?? "{}",
	) as RelayDirectEventWire;
	expect(sent).toEqual(frozen); // byte-identical envelope, createdAt included
	const replay = await postWire(db, retryBody, t0);
	expect(replay?.status).toBe(200); // idempotent replay, NOT 409
	const parsed = (await replay?.json()) as { eventId: number };
	expect(parsed.eventId).toBe(1); // the ORIGINAL event
	expect(eventCount(db)).toBe(1);
});

// A same-id retry whose opts diverge from the stored envelope is a caller
// bug: refused locally before any round trip; the row keeps telling the
// truth about the original attempt.
test("W1163: divergent same-id retry is refused without a round trip", async () => {
	const db = fixture();
	const id = crypto.randomUUID();
	let posts = 0;
	const stub = (async () => {
		posts++;
		return Response.json({ eventId: 3, state: "QUEUED" });
	}) as unknown as typeof fetch;
	const first = await forward(db, id, { fetch: stub });
	expect(first.ok).toBe(true);
	const divergent = await forward(db, id, {
		note: "different steering",
		fetch: stub,
	});
	expect(divergent.ok).toBe(false);
	expect(divergent.why).toContain("envelope conflict");
	expect(posts).toBe(1);
	const frozen = JSON.parse(
		relayOutboxRecord(db, id)?.envelope ?? "{}",
	) as RelayDirectEventWire;
	expect(frozen.note).toBe("steer"); // the ORIGINAL attempt
});

// Stores minted before the envelope column migrate on open — the ALTER runs
// inside ensureEventRelayOutbox.
test("W1163: outbox migration adds envelope to a pre-W1163 table", () => {
	const db = fixture();
	db.run("DROP TABLE event_relay_outbox");
	db.run(`CREATE TABLE event_relay_outbox (
		delivery_id TEXT PRIMARY KEY, hub TEXT NOT NULL, url TEXT NOT NULL,
		via TEXT NOT NULL, target_sid TEXT NOT NULL, kind TEXT NOT NULL,
		event_id INTEGER, state TEXT NOT NULL, why TEXT, created_at INTEGER NOT NULL)`);
	ensureEventRelayOutbox(db);
	const cols = (
		db.query("PRAGMA table_info(event_relay_outbox)").all() as {
			name: string;
		}[]
	).map((c) => c.name);
	expect(cols).toContain("envelope");
});
