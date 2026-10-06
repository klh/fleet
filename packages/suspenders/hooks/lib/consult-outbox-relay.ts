import type { Database } from "bun:sqlite";
import { ensureConsultOutbox, consultStoreId } from "./consult-outbox.ts";
import { resolveStoreHttpBase } from "./govdb.ts";
import { readFileSync, statSync, existsSync } from "node:fs";

interface Binding {
	base: string;
	token: string | null;
}
export interface RelayOptions {
	resolve?: () => Binding | null;
	fetch?: typeof fetch;
	now?: () => number;
	projectAliases?: () => Record<string, string>;
}
interface Delivery {
	delivery_id: string;
	local_consult_id: number;
	destination: string | null;
	created_at: number;
	attempts: number;
	status: string;
	remote_consult_id: number | null;
	project: string;
	asker_sid: string;
	expert_sid: string;
	question: string;
	scope: string | null;
	remote_project: string | null;
	remote_store_id: string | null;
	local_state: string;
}
const active = new WeakSet<Database>();
const TTL = 3_600_000;

function projectAliases(): Record<string, string> {
	const path =
		process.env.GOVERNOR_CONSULT_PROJECTS_FILE ??
		`${process.env.HOME}/.config/klh/consult-projects.json`;
	if (!existsSync(path)) return {};
	const stat = statSync(path);
	if ((stat.mode & 0o777) !== 0o600 || stat.size > 16_384 || !stat.isFile())
		throw new Error("INVALID_PROJECT_ALIASES");
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (
		!value ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		Object.keys(value).length > 128 ||
		Object.values(value).some((v) => typeof v !== "string" || !v.trim())
	)
		throw new Error("INVALID_PROJECT_ALIASES");
	return value;
}

function allowedBase(raw: string): string | null {
	try {
		const url = new URL(raw);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.username || url.password || url.search || url.hash) return null;
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
			return null;
		return url.href.replace(/\/+$/, "");
	} catch {
		return null;
	}
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw new Error(`HTTP_${response.status}`);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("EMPTY_RESPONSE");
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 65_536) throw new Error("RESPONSE_TOO_LARGE");
			text += decoder.decode(chunk.value, { stream: true });
		}
		const value = JSON.parse(text + decoder.decode());
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("INVALID_RESPONSE");
		return value;
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** One bounded, sequential tick. Delivery IDs and pinned destinations survive
 * lost acknowledgements and worker restarts; receiver dedupe makes retries safe. */
export async function relayConsultOutbox(
	db: Database,
	options: RelayOptions = {},
) {
	const result = {
		processed: 0,
		sent: 0,
		answered: 0,
		expired: 0,
		local: 0,
		busy: false,
	};
	if (active.has(db)) return { ...result, busy: true };
	active.add(db);
	try {
		ensureConsultOutbox(db);
		const now = options.now?.() ?? Date.now();
		db.query(
			"DELETE FROM consult_outbox WHERE status IN ('ANSWERED','EXPIRED','LOCAL') AND created_at < ?",
		).run(now - 7 * 86_400_000);
		db.run(
			"DELETE FROM consult_outbox WHERE NOT EXISTS (SELECT 1 FROM consults WHERE consults.id = consult_outbox.local_consult_id)",
		);
		const resolve = options.resolve ?? resolveStoreHttpBase;
		const network = options.fetch ?? fetch;
		let binding: Binding | null = null;
		let bindingFailed = false;
		try {
			binding = resolve();
		} catch {
			bindingFailed = true;
		}
		const base = binding ? allowedBase(binding.base) : null;
		let healthRequest: Promise<Record<string, unknown>> | null = null;
		const rows = db
			.query(`SELECT o.*, c.project, c.asker_sid, c.expert_sid, c.question, c.scope, c.state AS local_state
			FROM consult_outbox o JOIN consults c ON c.id = o.local_consult_id
			WHERE o.status IN ('PENDING','SENT') AND (o.next_at <= ? OR o.created_at <= ?)
			ORDER BY o.created_at, o.delivery_id LIMIT 20`)
			.all(now, now - TTL) as Delivery[];
		const retry = (row: Delivery, reason: string) => {
			const delay = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
			db.query(
				"UPDATE consult_outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE delivery_id = ? AND status IN ('PENDING','SENT')",
			).run(now + delay, reason, row.delivery_id);
		};
		for (const row of rows) {
			result.processed++;
			if (row.local_state !== "OPEN") {
				db.query(
					"UPDATE consult_outbox SET status = 'ANSWERED', last_error = NULL WHERE delivery_id = ?",
				).run(row.delivery_id);
				continue;
			}
			if (now - row.created_at >= TTL) {
				db.transaction(() => {
					db.query(
						"UPDATE consult_outbox SET status = 'EXPIRED', last_error = 'DELIVERY_TTL_EXPIRED' WHERE delivery_id = ?",
					).run(row.delivery_id);
					const expired = db
						.query(
							"UPDATE consults SET state = 'EXPIRED', answered_at = ? WHERE id = ? AND state = 'OPEN'",
						)
						.run(now, row.local_consult_id);
					if (expired.changes)
						db.query(
							"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?, 'consult-outbox-relay', 'consult.answer', ?, ?, ?)",
						).run(
							now,
							row.scope,
							JSON.stringify({
								consult: `C${row.local_consult_id}`,
								state: "EXPIRED",
								deliveryId: row.delivery_id,
								project: row.project,
							}),
							row.asker_sid,
						);
				})();
				result.expired++;
				continue;
			}
			if (bindingFailed) {
				retry(row, "INVALID_STORE_BINDING");
				continue;
			}
			if (!binding) {
				if (row.destination || row.remote_consult_id !== null) {
					retry(row, "BINDING_UNAVAILABLE");
					continue;
				}
				db.query(
					"UPDATE consult_outbox SET status = 'LOCAL', last_error = NULL WHERE delivery_id = ?",
				).run(row.delivery_id);
				result.local++;
				continue;
			}
			if (!base) {
				retry(row, "UNSAFE_STORE_BINDING");
				continue;
			}
			if (row.destination && row.destination !== base) {
				retry(row, "DESTINATION_BINDING_CHANGED");
				continue;
			}
			let remoteProject = row.remote_project;
			if (!remoteProject) {
				try {
					remoteProject =
						(options.projectAliases ?? projectAliases)()[row.project] ??
						row.project;
					db.query(
						"UPDATE consult_outbox SET destination = ?, remote_project = ? WHERE delivery_id = ? AND remote_project IS NULL",
					).run(base, remoteProject, row.delivery_id);
				} catch {
					retry(row, "INVALID_PROJECT_ALIASES");
					continue;
				}
			}
			const remote = !["localhost", "127.0.0.1", "[::1]"].includes(
				new URL(base).hostname,
			);
			if (remote && !binding.token) {
				retry(row, "REMOTE_AUTH_REQUIRED");
				continue;
			}
			const headers = {
				"content-type": "application/json",
				...(binding.token ? { "x-governor-token": binding.token } : {}),
			};
			const request = async (path: string, method = "GET", body?: unknown) =>
				readJson(
					await network(`${base}${path}`, {
						method,
						headers,
						redirect: "manual",
						signal: AbortSignal.timeout(3000),
						...(body ? { body: JSON.stringify(body) } : {}),
					}),
				);
			try {
				if (!healthRequest) healthRequest = request("/health");
				const health = await healthRequest;
				if (health.instanceId === consultStoreId(db)) {
					if (row.destination || row.remote_consult_id !== null)
						throw new Error("STORE_IDENTITY_CHANGED");
					db.query(
						"UPDATE consult_outbox SET status = 'LOCAL', last_error = NULL WHERE delivery_id = ?",
					).run(row.delivery_id);
					result.local++;
					continue;
				}
				if (
					typeof health.instanceId !== "string" ||
					!health.instanceId ||
					health.instanceId.length > 128
				)
					throw new Error("INVALID_STORE_IDENTITY");
				if (row.remote_store_id && row.remote_store_id !== health.instanceId)
					throw new Error("STORE_IDENTITY_CHANGED");
				if (!row.remote_store_id)
					db.query(
						"UPDATE consult_outbox SET remote_store_id = ? WHERE delivery_id = ? AND remote_store_id IS NULL",
					).run(health.instanceId, row.delivery_id);
				if (!binding.token) throw new Error("REMOTE_AUTH_REQUIRED");
				const response =
					row.status === "SENT"
						? await request(
								`/consult-relay/${encodeURIComponent(row.delivery_id)}`,
							)
						: await request("/consult-relay", "POST", {
								deliveryId: row.delivery_id,
								project: remoteProject,
								askerSid: row.asker_sid,
								expertSid: row.expert_sid,
								question: row.question,
								scope: row.scope ?? "recovery",
								createdAt: row.created_at,
							});
				const consult = (response.consult ?? response) as Record<
					string,
					unknown
				>;
				const remoteId = consult?.id ?? response.consultId;
				if (!Number.isSafeInteger(remoteId) || Number(remoteId) < 1)
					throw new Error("INVALID_CONSULT_ACK");
				if (
					row.remote_consult_id !== null &&
					row.remote_consult_id !== Number(remoteId)
				)
					throw new Error("CONSULT_ID_MISMATCH");
				const state = consult?.state;
				const answer = consult?.answer;
				if (
					!["OPEN", "ANSWERED", "DECLINED", "EXPIRED"].includes(
						String(state),
					) ||
					(state === "ANSWERED" &&
						(typeof answer !== "string" || answer.length > 16_384))
				)
					throw new Error("INVALID_CONSULT_STATE");
				if (
					consult.expertSid !== undefined &&
					consult.expertSid !== row.expert_sid
				)
					throw new Error("CONSULT_EXPERT_MISMATCH");
				if (
					(state === "ANSWERED" &&
						typeof answer === "string" &&
						answer.length <= 16_384) ||
					state === "DECLINED" ||
					state === "EXPIRED"
				) {
					db.transaction(() => {
						const updated = db
							.query(
								"UPDATE consults SET state = ?, answer = ?, answered_at = ? WHERE id = ? AND state = 'OPEN'",
							)
							.run(
								state,
								state === "ANSWERED" ? answer : null,
								now,
								row.local_consult_id,
							);
						db.query(
							"UPDATE consult_outbox SET status = 'ANSWERED', remote_consult_id = ?, next_at = ?, last_error = NULL WHERE delivery_id = ?",
						).run(remoteId, now, row.delivery_id);
						if (updated.changes)
							db.query(
								"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?, 'consult-outbox-relay', 'consult.answer', ?, ?, ?)",
							).run(
								now,
								row.scope,
								JSON.stringify({
									consult: `C${row.local_consult_id}`,
									state,
									answer: state === "ANSWERED" ? answer : null,
									deliveryId: row.delivery_id,
									remoteConsult: `C${remoteId}`,
									project: row.project,
								}),
								row.asker_sid,
							);
					})();
					result.answered++;
				} else {
					db.query(
						"UPDATE consult_outbox SET status = 'SENT', remote_consult_id = ?, next_at = ?, attempts = attempts + 1, last_error = NULL WHERE delivery_id = ?",
					).run(remoteId, now + 5_000, row.delivery_id);
					result.sent++;
				}
			} catch (error) {
				// Network messages can contain credentials, URLs or payloads. Persist
				// only our bounded error codes; never the raw exception or headers.
				const reason =
					error instanceof Error &&
					(/^(HTTP_\d{3})$/.test(error.message) ||
						[
							"EMPTY_RESPONSE",
							"RESPONSE_TOO_LARGE",
							"INVALID_RESPONSE",
							"INVALID_STORE_IDENTITY",
							"INVALID_CONSULT_ACK",
							"CONSULT_ID_MISMATCH",
							"CONSULT_EXPERT_MISMATCH",
							"REMOTE_AUTH_REQUIRED",
							"STORE_IDENTITY_CHANGED",
							"INVALID_CONSULT_STATE",
						].includes(error.message))
						? error.message
						: "DELIVERY_REQUEST_FAILED";
				retry(row, reason);
			}
		}
		return result;
	} finally {
		active.delete(db);
	}
}
