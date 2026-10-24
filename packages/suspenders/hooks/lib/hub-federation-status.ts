// hooks/lib/hub-federation-status.ts — W231 hub admin plane: the
// federation status lens for /console/hub. Peers come from the same
// precedence the peers loop uses (HUB_PEERS → stack.json hubs.<me>.peers);
// each peer's last-known store (the peers loop writes it atomically) is
// the status evidence — version in force, pulled-at, and a derived
// live/stale/down verdict against a freshness window. Never throws: a
// peer without a store reads "down (never pulled)".
import { statSync } from "node:fs";
import {
	type PeersEnv,
	loadPeerLastKnown,
	peerLastKnownPath,
	resolvePeerLabels,
} from "./federation-peers.ts";

/** A peer whose last-known store is older than this is stale (the peers
 *  loop defaults to a 300s cycle — 3 missed cycles = stale). */
const STALE_MS = 15 * 60_000;

export type PeerState = "live" | "stale" | "down";

export interface FederationPeerStatus {
	label: string;
	state: PeerState;
	/** The policy manifest version in force (last-known when degraded). */
	version: string | null;
	pulled_at: string | null;
	/** ms epoch of the last-known store's mtime; null = never pulled. */
	last_known_at: number | null;
	url: string | null;
	via: string | null;
	rules: number | null;
	cr_queue: number | null;
}

export interface FederationStatus {
	/** This machine's hub label (KLH_HUB_NAME), null when unset. */
	me: string | null;
	peers: FederationPeerStatus[];
	/** True when no peer edges are declared — an honest idle, not an error. */
	idle: boolean;
}

function peerState(
	lastKnownAt: number | null,
	pulledAt: string | null,
): PeerState {
	if (lastKnownAt === null && pulledAt === null) return "down";
	if (lastKnownAt === null) return "down";
	return Date.now() - lastKnownAt <= STALE_MS ? "live" : "stale";
}

function toStatus(label: string, env: PeersEnv): FederationPeerStatus {
	const lk = loadPeerLastKnown(label, env);
	if (lk === null)
		return {
			label,
			state: "down",
			version: null,
			pulled_at: null,
			last_known_at: null,
			url: null,
			via: null,
			rules: null,
			cr_queue: null,
		};
	let lastKnownAt: number | null = null;
	try {
		lastKnownAt = statSync(peerLastKnownPath(label, env)).mtimeMs;
	} catch {
		lastKnownAt = null;
	}
	const manifest = lk.manifest as { version?: unknown } | null;
	return {
		label,
		state: peerState(lastKnownAt, lk.pulled_at ?? null),
		version: typeof manifest?.version === "string" ? manifest.version : null,
		pulled_at: lk.pulled_at ?? null,
		last_known_at: lastKnownAt,
		url: lk.url ?? null,
		via: lk.via ?? null,
		rules: typeof manifest?.rules === "number" ? manifest.rules : null,
		cr_queue: typeof manifest?.cr_queue === "number" ? manifest.cr_queue : null,
	};
}

/** The federation status snapshot. `env` injectable for tests (the peers
 *  lib reads HUB_PEERS / KLH_HUB_NAME / KLH_STACK through it). */
export function federationStatus(
	opts: { labels?: string[]; env?: PeersEnv } = {},
): FederationStatus {
	const env: PeersEnv = opts.env ?? process.env;
	const labels = resolvePeerLabels({ labels: opts.labels, env });
	const me = env.KLH_HUB_NAME?.trim() || null;
	if (labels.length === 0) return { me, peers: [], idle: true };
	return {
		me,
		idle: false,
		peers: labels.map((l) => toStatus(l, env)),
	};
}
