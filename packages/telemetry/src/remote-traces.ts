// One bounded connector for trace receipts held by other Buckle hubs.
// Peer addresses and read keys come only from a private machine-owned file.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const TRACE_ID = /^[0-9a-f]{32}$/;
const HUB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LABEL = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PEERS = 8;
const MAX_BYTES = 256 * 1024;

interface Peer {
	hubId: string;
	url: URL;
	tokenFile: string;
}

export interface RemoteTraceAttempt {
	hub_id: string;
	trace_id: string;
	rid: string | null;
	ordinal: number;
	ts: string;
	hop: string | null;
	status: number | null;
	duration_ms: number | null;
	retry_after_ms: number | null;
	call_id: string | null;
}

export interface RemoteTraceResult {
	hub_id: string;
	status: "ok" | "unavailable" | "http_error" | "invalid_response";
	http_status?: number;
	attempts: RemoteTraceAttempt[];
}

function privateText(path: string, limit: number): string {
	if (!isAbsolute(path)) throw new Error("private path must be absolute");
	const stat = lstatSync(path);
	if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > limit)
		throw new Error("private file unavailable");
	if (typeof process.getuid === "function" && stat.uid !== process.getuid())
		throw new Error("private file owner mismatch");
	return readFileSync(path, "utf8");
}

function peers(path: string): Peer[] {
	const parsed = JSON.parse(privateText(path, 32_768)) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("invalid trace peers");
	const rows = (parsed as { peers?: unknown }).peers;
	if (!Array.isArray(rows) || rows.length > MAX_PEERS)
		throw new Error("invalid trace peers");
	const out: Peer[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object" || Array.isArray(row))
			throw new Error("invalid trace peer");
		const value = row as Record<string, unknown>;
		if (
			typeof value.hubId !== "string" ||
			!HUB_ID.test(value.hubId) ||
			typeof value.url !== "string" ||
			value.url.length > 2048 ||
			typeof value.tokenFile !== "string" ||
			!isAbsolute(value.tokenFile)
		)
			throw new Error("invalid trace peer");
		const url = new URL(value.url);
		const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!(url.protocol === "https:" || (url.protocol === "http:" && loopback))
		)
			throw new Error("invalid trace peer URL");
		out.push({ hubId: value.hubId, url, tokenFile: value.tokenFile });
	}
	if (new Set(out.map((peer) => peer.hubId)).size !== out.length)
		throw new Error("duplicate trace peer");
	return out;
}

function safeInt(value: unknown, max: number): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= max
		? value
		: null;
}

function label(value: unknown): string | null {
	return typeof value === "string" && LABEL.test(value) ? value : null;
}

async function boundedJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BYTES)
		throw new Error("trace response too large");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("trace response empty");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > MAX_BYTES) {
				await reader.cancel();
				throw new Error("trace response too large");
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function readPeer(
	peer: Peer,
	traceId: string,
	request: typeof fetch,
): Promise<RemoteTraceResult> {
	const empty: RemoteTraceResult = {
		hub_id: peer.hubId,
		status: "unavailable",
		attempts: [],
	};
	let token: string;
	try {
		token = privateText(peer.tokenFile, 4096).trim();
		if (!token || /\s/.test(token)) return empty;
	} catch {
		return empty;
	}
	try {
		const url = new URL(`/v1/admin/traces?trace_id=${traceId}`, peer.url);
		const response = await request(url, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.timeout(2500),
		});
		if (!response.ok)
			return {
				...empty,
				status: "http_error",
				http_status: response.status,
			};
		const payload = await boundedJson(response);
		if (!payload || typeof payload !== "object" || Array.isArray(payload))
			return { ...empty, status: "invalid_response" };
		const body = payload as { trace_id?: unknown; attempts?: unknown };
		if (
			body.trace_id !== traceId ||
			!Array.isArray(body.attempts) ||
			body.attempts.length > 500
		)
			return { ...empty, status: "invalid_response" };
		const attempts: RemoteTraceAttempt[] = [];
		for (const raw of body.attempts) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const row = raw as Record<string, unknown>;
			if (
				row.trace_id !== traceId ||
				typeof row.ts !== "string" ||
				!/^\d{4}-\d\d-\d\dT/.test(row.ts)
			)
				continue;
			const ordinal = safeInt(row.ordinal, 1_000_000);
			if (ordinal === null) continue;
			attempts.push({
				hub_id: peer.hubId,
				trace_id: traceId,
				rid: label(row.rid),
				ordinal,
				ts: row.ts.slice(0, 32),
				hop: label(row.hop),
				status: safeInt(row.status, 599),
				duration_ms: safeInt(row.duration_ms, 3_600_000),
				retry_after_ms: safeInt(row.retry_after_ms, 3_600_000),
				call_id: label(row.call_id),
			});
		}
		return { hub_id: peer.hubId, status: "ok", attempts };
	} catch {
		return empty;
	}
}

/** Local Buckle calls all fixed peers; remote hubs are never selected by a
 * request parameter. Empty config stays explicit rather than implying zero
 * remote attempts. */
export async function readRemoteTraces(
	configPath: string | undefined,
	traceId: string,
	request: typeof fetch = fetch,
): Promise<{
	status: "ok" | "not_configured" | "invalid_config";
	peers: RemoteTraceResult[];
}> {
	if (!configPath) return { status: "not_configured", peers: [] };
	if (!TRACE_ID.test(traceId)) return { status: "invalid_config", peers: [] };
	let configured: Peer[];
	try {
		configured = peers(configPath);
	} catch {
		return { status: "invalid_config", peers: [] };
	}
	return {
		status: "ok",
		peers: await Promise.all(
			configured.map((peer) => readPeer(peer, traceId, request)),
		),
	};
}
