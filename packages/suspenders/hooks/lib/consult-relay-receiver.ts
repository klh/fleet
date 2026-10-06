import { createHash } from "node:crypto";
import type { GovernorStore } from "./govdb.ts";

export interface RelayConsultRequest {
	deliveryId: string;
	project: string;
	askerSid: string;
	expertSid: string;
	question: string;
	scope: string;
	createdAt: number;
}
interface ConsultRecord {
	id: number;
	state: string;
	answer: string | null;
	answered_at: number | null;
	expert_sid: string;
	created_at: number;
}
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ensureConsultRelayReceipts(db: GovernorStore): void {
	db.run(`CREATE TABLE IF NOT EXISTS consult_relay_receipts (
		delivery_id TEXT PRIMARY KEY, consult_id INTEGER NOT NULL UNIQUE REFERENCES consults(id) ON DELETE CASCADE,
		payload_hash TEXT NOT NULL)`);
	const keys = db
		.query("PRAGMA foreign_key_list(consult_relay_receipts)")
		.all() as { on_delete: string }[];
	if (!keys.some((key) => key.on_delete === "CASCADE"))
		db.transaction(() => {
			db.run(
				"ALTER TABLE consult_relay_receipts RENAME TO consult_relay_receipts_previous",
			);
			db.run(
				"CREATE TABLE consult_relay_receipts (delivery_id TEXT PRIMARY KEY, consult_id INTEGER NOT NULL UNIQUE REFERENCES consults(id) ON DELETE CASCADE, payload_hash TEXT NOT NULL)",
			);
			db.run(
				"INSERT INTO consult_relay_receipts SELECT r.delivery_id,r.consult_id,r.payload_hash FROM consult_relay_receipts_previous r JOIN consults c ON c.id = r.consult_id",
			);
			db.run("DROP TABLE consult_relay_receipts_previous");
		})();
}

function shape(input: unknown): RelayConsultRequest | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	const keys = [
		"deliveryId",
		"project",
		"askerSid",
		"expertSid",
		"question",
		"scope",
		"createdAt",
	];
	if (
		Object.keys(record).length !== keys.length ||
		keys.some((key) => !(key in record))
	)
		return null;
	if (typeof record.deliveryId !== "string" || !UUID.test(record.deliveryId))
		return null;
	for (const [key, max] of [
		["project", 1024],
		["askerSid", 128],
		["expertSid", 128],
		["question", 8192],
		["scope", 1024],
	] as const) {
		const value = record[key];
		if (
			typeof value !== "string" ||
			!value.trim() ||
			value.length > max ||
			[...value].some(
				(char) =>
					char.charCodeAt(0) === 0 ||
					(key !== "question" &&
						(char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)),
			)
		)
			return null;
	}
	if (
		typeof record.createdAt !== "number" ||
		!Number.isSafeInteger(record.createdAt)
	)
		return null;
	return {
		deliveryId: record.deliveryId.toLowerCase(),
		project: record.project as string,
		askerSid: record.askerSid as string,
		expertSid: record.expertSid as string,
		question: record.question as string,
		scope: record.scope as string,
		createdAt: record.createdAt,
	};
}

function current(db: GovernorStore, deliveryId: string): ConsultRecord | null {
	return db
		.query(
			"SELECT c.id, c.state, c.answer, c.answered_at, c.expert_sid, c.created_at FROM consult_relay_receipts r JOIN consults c ON c.id = r.consult_id WHERE r.delivery_id = ?",
		)
		.get(deliveryId) as ConsultRecord | null;
}
function response(consult: ConsultRecord, now: number): Response {
	if (consult.state === "OPEN" && consult.created_at < now - 3_600_000)
		return Response.json(
			{ error: "Consult delivery expired" },
			{ status: 410 },
		);
	return Response.json({
		consultId: consult.id,
		state: consult.state,
		answer: consult.answer,
		answeredAt: consult.answered_at,
		expertSid: consult.expert_sid,
	});
}

/** Caller applies store token authentication. Commit precedes targeted WS notification. */
export async function handleConsultRelay(
	req: Request,
	url: URL,
	db: GovernorStore,
	notify?: (eventId: number) => void,
	now = Date.now(),
): Promise<Response | null> {
	if (
		url.pathname !== "/consult-relay" &&
		!url.pathname.startsWith("/consult-relay/")
	)
		return null;
	if (url.pathname.startsWith("/consult-relay/")) {
		if (req.method !== "GET")
			return Response.json(
				{ error: "GET required" },
				{ status: 405, headers: { Allow: "GET" } },
			);
		const id = url.pathname.slice("/consult-relay/".length);
		if (!UUID.test(id))
			return Response.json({ error: "Invalid delivery ID" }, { status: 400 });
		const consult = current(db, id.toLowerCase());
		return consult
			? response(consult, now)
			: Response.json({ error: "Unknown consult delivery" }, { status: 404 });
	}
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
			return Response.json({ error: "Consult body required" }, { status: 400 });
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
						{ error: "Consult body exceeds 16 KiB" },
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
			return Response.json(
				{ error: "Consult body timed out" },
				{ status: 408 },
			);
		input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return Response.json({ error: "Invalid consult JSON" }, { status: 400 });
	}
	const delivery = shape(input);
	if (!delivery)
		return Response.json(
			{ error: "Invalid consult delivery" },
			{ status: 400 },
		);
	const hash = createHash("sha256")
		.update(JSON.stringify(delivery))
		.digest("hex");
	let eventId: number | null = null;
	const result = db.transaction(() => {
		db.query(
			"DELETE FROM consult_relay_receipts WHERE consult_id IN (SELECT id FROM consults WHERE created_at < ?) OR consult_id NOT IN (SELECT id FROM consults)",
		).run(now - 604_800_000);
		const receipt = db
			.query(
				"SELECT payload_hash FROM consult_relay_receipts WHERE delivery_id = ?",
			)
			.get(delivery.deliveryId) as { payload_hash: string } | null;
		if (receipt) {
			if (receipt.payload_hash !== hash)
				return Response.json(
					{ error: "Delivery ID payload conflict" },
					{ status: 409 },
				);
			const consult = current(db, delivery.deliveryId);
			return consult
				? response(consult, now)
				: Response.json(
						{ error: "Consult receipt unavailable" },
						{ status: 503 },
					);
		}
		if (delivery.createdAt > now + 5000)
			return Response.json(
				{ error: "Future consult delivery" },
				{ status: 400 },
			);
		if (delivery.createdAt < now - 3_600_000)
			return Response.json(
				{ error: "Consult delivery expired" },
				{ status: 410 },
			);
		const capacity = db
			.query("SELECT COUNT(*) AS n FROM consult_relay_receipts")
			.get() as { n: number };
		if (capacity.n >= 10_000)
			return Response.json(
				{ error: "Consult receiver capacity reached" },
				{ status: 503, headers: { "Retry-After": "30" } },
			);
		const expert = db
			.query(
				"SELECT 1 FROM sessions WHERE sid = ? AND project = ? AND state = 'RUNNING' AND hb > ? AND hb <= ?",
			)
			.get(delivery.expertSid, delivery.project, now - 300_000, now + 5000);
		if (!expert)
			return Response.json(
				{ error: "Expert is unavailable in the requested project" },
				{ status: 503 },
			);
		const queue = db
			.query(
				"SELECT COALESCE(SUM(asker_sid = ?), 0) AS asker, COALESCE(SUM(expert_sid = ?), 0) AS expert FROM consults WHERE project = ? AND state = 'OPEN' AND created_at > ?",
			)
			.get(
				delivery.askerSid,
				delivery.expertSid,
				delivery.project,
				now - 3_600_000,
			) as { asker: number; expert: number };
		if (queue.asker >= 3 || queue.expert >= 3)
			return Response.json(
				{ error: "Consult queue is full" },
				{ status: 429, headers: { "Retry-After": "30" } },
			);
		const inserted = db
			.query(
				"INSERT INTO consults (project, asker_sid, expert_sid, question, scope, state, created_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)",
			)
			.run(
				delivery.project,
				delivery.askerSid,
				delivery.expertSid,
				delivery.question,
				delivery.scope,
				delivery.createdAt,
			);
		const consultId = Number(inserted.lastInsertRowid);
		db.query(
			"INSERT INTO consult_relay_receipts (delivery_id, consult_id, payload_hash) VALUES (?, ?, ?)",
		).run(delivery.deliveryId, consultId, hash);
		const event = db
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'consult', ?, ?, ?)",
			)
			.run(
				now,
				delivery.askerSid,
				delivery.scope,
				JSON.stringify({
					consult: `C${consultId}`,
					q: delivery.question,
					project: delivery.project,
					deliveryId: delivery.deliveryId,
					relayed: true,
				}),
				delivery.expertSid,
			);
		eventId = Number(event.lastInsertRowid);
		return Response.json({
			consultId,
			state: "OPEN",
			answer: null,
			answeredAt: null,
			expertSid: delivery.expertSid,
		});
	})();
	if (eventId !== null && notify) {
		try {
			notify(eventId);
		} catch {}
	}
	return result;
}
