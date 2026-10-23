// One bounded connector for trace receipts held by other Buckle hubs.
// Peer addresses and read keys come only from a private machine-owned file.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { safeProviderErrorToken, safeRefusalCode } from "./http-trace.ts";
import {
	safeTransportEvidence,
	type TransportEvidence,
} from "./transport-evidence.ts";

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
	/** W1124.42: who was attempted (candidate hash) and where a refusal
	 *  originated — the attribution the joined trace previously dropped. */
	candidate: string | null;
	refusal: string | null;
	upstream_refusal_code: string | null;
	refusal_origin: string | null;
	duration_ms: number | null;
	retry_after_ms: number | null;
	call_id: string | null;
	provider_pool: string | null;
	queue_wait_ms: number | null;
	provider_error_code: string | null;
	provider_error_type: string | null;
	transport: TransportEvidence | null;
}

/** W1124.42: the peer's own per-request audit row, projected to the safe
 *  target + outcome subset only — origin/model of what was attempted, no
 *  bodies, no error text, no key material. */
export interface RemoteTraceRequest {
	rid: string | null;
	ts: string | null;
	lane: string | null;
	ok: number | null;
	status: number | null;
	attempts: number | null;
	target_kind: string | null;
	target_host: string | null;
	target_port: number | null;
	target_model: string | null;
}

export interface RemoteTraceResult {
	hub_id: string;
	status: "ok" | "unavailable" | "http_error" | "invalid_response";
	http_status?: number;
	attempts: RemoteTraceAttempt[];
	requests: RemoteTraceRequest[];
}

/** W1097: the per-read coverage contract — what the connector ATTEMPTED for
 *  this trace and what answered. Counts + status strings only (body-free:
 *  no receipt rows, no tokens, no URLs). Present in every readRemoteTraces
 *  answer so consumers get one uniform shape. */
export interface RemoteTraceCoverage {
	/** Configured peers evaluated this read (0 when unconfigured/invalid). */
	hubs: number;
	/** Peers that answered ok (with or without attempts for this trace). */
	ok: number;
	/** Peers that did not answer ok: unavailable, http_error, invalid. */
	degraded: number;
	/** Hub id → per-peer status, bounded by the 8-peer cap. */
	by_hub: Record<string, string>;
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

/** W1097: the peer-config law as a function of TEXT — the ONE validator both
 *  the connector read path and the hubctl peers-file merge run before bytes
 *  land (hubctl validates the merged file with the exact code that reads it).
 *  Throws with the violation when any row breaks the law. */
export function parsePeers(text: string): Peer[] {
	const parsed = JSON.parse(text) as unknown;
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

function peers(path: string): Peer[] {
	return parsePeers(privateText(path, 32_768));
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

/** The refusal-origin enum route_attempt persists (local-admission rides
 *  the hop column, never this field) — anything else is unknown. */
const REFUSAL_ORIGINS = ["upstream", "bridged-upstream", "network"] as const;

function refusalOrigin(value: unknown): string | null {
	return (REFUSAL_ORIGINS as readonly string[]).includes(value as string)
		? (value as string)
		: null;
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
		requests: [],
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
		const body = payload as {
			trace_id?: unknown;
			attempts?: unknown;
			requests?: unknown;
		};
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
				candidate: label(row.candidate),
				refusal: label(row.refusal),
				upstream_refusal_code: safeRefusalCode(row.upstream_refusal_code),
				refusal_origin: refusalOrigin(row.refusal_origin),
				duration_ms: safeInt(row.duration_ms, 3_600_000),
				retry_after_ms: safeInt(row.retry_after_ms, 3_600_000),
				call_id: label(row.call_id),
				provider_pool: label(row.provider_pool),
				queue_wait_ms: safeInt(row.queue_wait_ms, 3_600_000),
				provider_error_code: safeProviderErrorToken(row.provider_error_code),
				provider_error_type: safeProviderErrorToken(row.provider_error_type),
				transport: safeTransportEvidence(row.transport),
			});
		}
		const requests = requestsOf(body);
		return { hub_id: peer.hubId, status: "ok", attempts, requests };
	} catch {
		return empty;
	}
}

/** W1124.42: the peer's own request rows — the safe target subset only
 *  (origin/port/model of what the remote hub attempted), capped like the
 *  attempts array. A missing/oversized requests array is a legacy peer:
 *  empty, never an error. */
function requestsOf(body: { requests?: unknown }): RemoteTraceRequest[] {
	if (!Array.isArray(body.requests)) return [];
	const requests: RemoteTraceRequest[] = [];
	for (const raw of body.requests) {
		if (requests.length >= 500) break;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const row = raw as Record<string, unknown>;
		// fail-closed like the attempts loop: an unidentifiable row is not a
		// request row — skip, never project an all-null placeholder
		if (label(row.rid) === null) continue;
		if (typeof row.ts !== "string" || !/^\d{4}-\d\d-\d\dT/.test(row.ts))
			continue;
		requests.push({
			rid: label(row.rid),
			ts:
				typeof row.ts === "string" && /^\d{4}-\d\d-\d\dT/.test(row.ts)
					? row.ts.slice(0, 32)
					: null,
			lane: label(row.lane),
			ok: row.ok === 0 || row.ok === 1 ? row.ok : null,
			status: safeInt(row.status, 599),
			attempts: safeInt(row.attempts, 1000),
			target_kind: label(row.target_kind),
			target_host: label(row.target_host),
			target_port: safeInt(row.target_port, 65_535),
			target_model: label(row.target_model),
		});
	}
	return requests;
}

/** The coverage block for one read — counts + status strings only. */
export function coverageOf(peers: RemoteTraceResult[]): RemoteTraceCoverage {
	const by_hub: Record<string, string> = {};
	let ok = 0;
	for (const peer of peers) {
		by_hub[peer.hub_id] = peer.status;
		if (peer.status === "ok") ok++;
	}
	return {
		hubs: peers.length,
		ok,
		degraded: peers.length - ok,
		by_hub,
	};
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
	coverage: RemoteTraceCoverage;
}> {
	if (!configPath)
		return { status: "not_configured", peers: [], coverage: coverageOf([]) };
	if (!TRACE_ID.test(traceId))
		return { status: "invalid_config", peers: [], coverage: coverageOf([]) };
	let configured: Peer[];
	try {
		configured = peers(configPath);
	} catch {
		return { status: "invalid_config", peers: [], coverage: coverageOf([]) };
	}
	const resolved = await Promise.all(
		configured.map((peer) => readPeer(peer, traceId, request)),
	);
	return { status: "ok", peers: resolved, coverage: coverageOf(resolved) };
}
