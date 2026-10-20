// W1020: pull authenticated, bounded pages of exact Buckle observations from
// remote hubs into the Mac projection. Billing stays in each hub's ledger;
// this is topology evidence only. A duplicate source+id is harmless.

import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveNetworkDbPaths } from "../../../buckle/src/network-read-model.ts";
import type { Observation } from "../../../buckle/src/observe.ts";
import { LaneProjection } from "../../../buckle/src/projection.ts";
import { type StackConfig, tryLoadStack } from "../lib/stack-config.ts";

const MAX_PAGE_BYTES = 320 * 1024;
const MAX_PAGES_PER_TICK = 8;
const POLL_MS = 3000;

export interface BuckleObservationPeer {
	hubId: string;
	url: string;
	tokenFile: string;
}

export interface BuckleObservationPeerState {
	peer: BuckleObservationPeer;
	cursor: number;
	generation: string | null;
	lastSuccessAt: number | null;
	lastError: string | null;
	applied: number;
}

function privateFile(path: string, maxBytes: number): string {
	const stat = statSync(path);
	if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o777) !== 0o600)
		throw new Error("Relay file must be private mode 600");
	return readFileSync(path, "utf8");
}

/** Operator-owned machine config, never a checked-in host or credential. */
export function readBuckleObservationPeers(
	path: string,
): BuckleObservationPeer[] {
	let raw: string;
	try {
		raw = privateFile(path, 32_768);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const input = JSON.parse(raw) as unknown;
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid Buckle observation relay config");
	const peers = (input as { peers?: unknown }).peers;
	if (!Array.isArray(peers) || peers.length > 8)
		throw new Error("Invalid Buckle observation relay peers");
	const parsed = peers.map((value): BuckleObservationPeer => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid Buckle observation relay peer");
		const peer = value as Record<string, unknown>;
		if (
			typeof peer.hubId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(peer.hubId) ||
			typeof peer.url !== "string" ||
			peer.url.length > 2048 ||
			typeof peer.tokenFile !== "string" ||
			!isAbsolute(peer.tokenFile)
		)
			throw new Error("Invalid Buckle observation relay peer");
		const url = new URL(peer.url);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!(
				url.protocol === "https:" ||
				(url.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			)
		)
			throw new Error("Remote observation relays require HTTPS");
		return { hubId: peer.hubId, url: url.origin, tokenFile: peer.tokenFile };
	});
	if (new Set(parsed.map((peer) => peer.hubId)).size !== parsed.length)
		throw new Error("Duplicate Buckle observation relay hub");
	return parsed;
}

/** Reuse the fleet's one hub registry. Local Docker profiles are reached on
 * loopback; remote profiles need an explicit HTTPS URL in machine config. */
export function peersFromStack(
	stack: StackConfig | null,
): BuckleObservationPeer[] {
	if (!stack) return [];
	const peers: BuckleObservationPeer[] = [];
	for (const [hubId, hub] of Object.entries(stack.hubs)) {
		if (!hub.token_file || !hub.buckle_port) continue;
		const url =
			hub.url ??
			(!hub.deploy?.ssh ? `http://127.0.0.1:${hub.buckle_port}` : null);
		if (!url) continue;
		const parsed = new URL(url);
		if (
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			parsed.pathname !== "/" ||
			!(
				parsed.protocol === "https:" ||
				(parsed.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
			)
		)
			continue;
		peers.push({ hubId, url: parsed.origin, tokenFile: hub.token_file });
	}
	return peers.slice(0, 8);
}

function readToken(path: string): string {
	const token = privateFile(path, 4096).trim();
	if (!token || /\s/.test(token)) throw new Error("Invalid relay token");
	return token;
}

async function boundedText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty observation page");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_PAGE_BYTES) {
				await reader.cancel();
				throw new Error("Observation page exceeds transfer limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

function validObservation(value: unknown, hubId: string): value is Observation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const event = value as Partial<Observation>;
	const data = event.data as Record<string, unknown> | undefined;
	return (
		event.specversion === "1.0" &&
		typeof event.source === "string" &&
		event.source.startsWith(`buckle://${hubId}/`) &&
		typeof event.id === "string" &&
		/^\d+$/.test(event.id) &&
		[
			"lane.request.admitted",
			"lane.request.started",
			"lane.request.ended",
		].includes(event.type ?? "") &&
		typeof event.time === "string" &&
		Number.isFinite(Date.parse(event.time)) &&
		!!data &&
		typeof data.rid === "string" &&
		typeof data.traceparent === "string" &&
		typeof data.lane === "string" &&
		typeof data.origin === "string"
	);
}

/** One page, all-or-nothing. Cursor advances only after projection ingest. */
export async function pullBuckleObservationPage(
	state: BuckleObservationPeerState,
	projection: LaneProjection,
	request: typeof fetch = fetch,
): Promise<boolean> {
	const target = `${state.peer.url}/v1/admin/observations?cursor=${state.cursor}&limit=64`;
	const response = await request(target, {
		headers: { authorization: `Bearer ${readToken(state.peer.tokenFile)}` },
		redirect: "error",
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok)
		throw new Error(`Hub observation export HTTP ${response.status}`);
	const payload = JSON.parse(await boundedText(response)) as Record<
		string,
		unknown
	>;
	if (
		!Array.isArray(payload.events) ||
		payload.events.length > 64 ||
		!(payload.generation === null || typeof payload.generation === "string") ||
		!Number.isSafeInteger(payload.nextCursor) ||
		!Number.isSafeInteger(payload.maxCursor) ||
		typeof payload.hasMore !== "boolean" ||
		!payload.events.every((event) => validObservation(event, state.peer.hubId))
	)
		throw new Error("Invalid hub observation page");
	const nextCursor = payload.nextCursor as number;
	const maxCursor = payload.maxCursor as number;
	const generation = payload.generation as string | null;
	if (state.generation !== null && state.generation !== generation) {
		state.cursor = 0;
		state.generation = generation;
		return true;
	}
	if (
		nextCursor < 0 ||
		maxCursor < 0 ||
		nextCursor > maxCursor ||
		(payload.events.length > 0 && nextCursor === state.cursor)
	)
		throw new Error("Invalid hub observation cursor");
	state.applied += projection.ingest(payload.events as Observation[]);
	state.cursor = nextCursor;
	state.generation = generation;
	state.lastSuccessAt = Date.now();
	state.lastError = null;
	return payload.hasMore as boolean;
}

export function startBuckleObservationRelay(
	env: Record<string, string | undefined> = process.env,
	request: typeof fetch = fetch,
): { stop(): void; states: BuckleObservationPeerState[] } {
	const peers = env.KLH_BUCKLE_OBSERVATION_PEERS
		? readBuckleObservationPeers(env.KLH_BUCKLE_OBSERVATION_PEERS)
		: peersFromStack(tryLoadStack());
	const obsDb = resolveNetworkDbPaths(env).obsDb;
	if (peers.length && !obsDb)
		throw new Error("Buckle observation relay needs a local projection DB");
	const states: BuckleObservationPeerState[] = peers.map((peer) => ({
		peer,
		cursor: 0,
		generation: null,
		lastSuccessAt: null,
		lastError: null,
		applied: 0,
	}));
	let cursorDb: Database | null = null;
	if (states.length && obsDb) {
		cursorDb = new Database(obsDb, { create: true });
		cursorDb.exec("PRAGMA journal_mode = WAL");
		cursorDb.exec("PRAGMA busy_timeout = 5000");
		cursorDb.exec(`CREATE TABLE IF NOT EXISTS buckle_relay_cursor (
			hub_id TEXT PRIMARY KEY, url TEXT NOT NULL, generation TEXT,
			cursor INTEGER NOT NULL)`);
		for (const state of states) {
			const row = cursorDb
				.query(
					"SELECT url, generation, cursor FROM buckle_relay_cursor WHERE hub_id = ?",
				)
				.get(state.peer.hubId) as {
				url: string;
				generation: string | null;
				cursor: number;
			} | null;
			if (row?.url === state.peer.url && Number.isSafeInteger(row.cursor)) {
				state.cursor = row.cursor;
				state.generation = row.generation;
			}
		}
	}
	let busy = false;
	const poll = async () => {
		if (busy || !obsDb) return;
		busy = true;
		let projection: LaneProjection | null = null;
		try {
			projection = new LaneProjection(obsDb);
			for (const state of states) {
				try {
					for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
						const more = await pullBuckleObservationPage(
							state,
							projection,
							request,
						);
						cursorDb
							?.query(`INSERT INTO buckle_relay_cursor (hub_id, url, generation, cursor)
							VALUES (?, ?, ?, ?) ON CONFLICT(hub_id) DO UPDATE SET
							url = excluded.url, generation = excluded.generation, cursor = excluded.cursor`)
							.run(
								state.peer.hubId,
								state.peer.url,
								state.generation,
								state.cursor,
							);
						if (!more) break;
					}
				} catch (error) {
					state.lastError =
						error instanceof Error ? error.message : "Observation relay failed";
				}
			}
		} finally {
			projection?.close();
			busy = false;
		}
	};
	if (states.length) void poll();
	const timer = setInterval(() => void poll(), POLL_MS);
	timer.unref();
	return {
		stop: () => {
			clearInterval(timer);
			cursorDb?.close();
		},
		states,
	};
}
