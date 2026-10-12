// hooks/lib/federation-peers.ts — W362 peer-to-peer policy propagation.
// The start-topology edges (hubs.<me>.peers in stack.yaml, mirrored by the
// belt-remote profile's federation.peers) are the seam: each hub pulls its
// declared peers' /federation/policy-manifest and keeps a per-peer
// last-known store under the federation home. The manifest's
// content-addressed version is the change detector — same rules → same
// string, so comparing one field detects a peer policy change (the W154
// spoke contract, applied peer-to-peer). Degradation law: an unreachable
// peer keeps last-known, logs honestly, never blocks the hub (this module
// never throws for peer-down; callers get degraded rows). Labels are the
// only thing that travels in config — hosts, ports and keys resolve at
// runtime through the resolveHub chain (config-over-code).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { atomicWrite } from "./board-config.ts";
import {
	type FederationEnv,
	federationHome,
	type HubManifestShape,
	readCapped,
} from "./federation.ts";
import { type HubLocation, resolveHub } from "./hub-locate.ts";

export interface PeerRow {
	label: string;
	ok: boolean;
	degraded: boolean;
	/** First successful pull: the peer's policy arrived (baseline seeded,
	 *  not reported as a change). */
	seeded: boolean;
	/** The version echo differs from the stored last-known manifest. */
	changed: boolean;
	reason: string | null;
	/** Fresh manifest version, or the last-known one still in force when
	 *  the peer degraded (honest: this is what the hub keeps running on). */
	version: string | null;
	url: string | null;
	via: string | null;
	rules: number;
	cr_queue: number;
}

export interface PeerLastKnown {
	pulled_at: string;
	hub_label: string;
	url: string;
	via: string;
	manifest: HubManifestShape;
}

/** Env knobs beyond the shared FederationEnv. */
export interface PeersEnv extends FederationEnv {
	/** Comma-separated peer labels — the hubctl-rendered, compose-forwarded
	 *  form (hubctl render emits HUB_PEERS from stack.yaml). */
	HUB_PEERS?: string;
	/** This machine's own hub label — selects hubs.<me>.peers in stack.yaml. */
	KLH_HUB_NAME?: string;
}

/** Per-peer last-known path: <federation home>/federation-peer-<label>.json */
export function peerLastKnownPath(
	label: string,
	env: FederationEnv = {},
): string {
	const safe = label.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return join(federationHome(env), `federation-peer-${safe}.json`);
}

/** Read the per-peer last-known store; null when absent/unparseable. */
export function loadPeerLastKnown(
	label: string,
	env: PeersEnv,
): PeerLastKnown | null {
	const p = peerLastKnownPath(label, env);
	if (!existsSync(p)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as PeerLastKnown;
	} catch {
		return null;
	}
}

/** The peer labels this machine propagates from, in precedence order:
 *  explicit call argument → HUB_PEERS env (hubctl renders it from
 *  stack.yaml into the hub .env; compose forwards it) → stack.yaml
 *  hubs.<KLH_HUB_NAME>.peers (the machine-level truth). Empty = no edges
 *  declared — nothing to propagate, never an error. */
export function resolvePeerLabels(
	opts: { labels?: string[]; env?: PeersEnv; stackPath?: string } = {},
): string[] {
	if (opts.labels !== undefined) return opts.labels;
	const env: PeersEnv = opts.env ?? process.env;
	const hubPeers = env.HUB_PEERS?.trim();
	if (hubPeers !== undefined && hubPeers.length > 0)
		return hubPeers
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	const me = env.KLH_HUB_NAME?.trim();
	if (me === undefined || me.length === 0) return [];
	const path =
		opts.stackPath ??
		process.env.KLH_STACK ??
		join(env.HOME ?? homedir(), ".config", "klh", "stack.yaml");
	if (!existsSync(path)) return [];
	try {
		const stack = parse(readFileSync(path, "utf8")) as {
			hubs?: Record<string, { peers?: unknown }>;
		} | null;
		const peers = stack?.hubs?.[me]?.peers ?? [];
		if (!Array.isArray(peers)) return [];
		return peers.filter(
			(p): p is string => typeof p === "string" && p.length > 0,
		);
	} catch {
		return [];
	}
}

function peerToken(
	label: string,
	loc: HubLocation,
	env: PeersEnv,
): string | null {
	const envKey = `SUSPENDERS_HUB_${label
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
	const fromEnv = (env as Record<string, string | undefined>)[envKey];
	return fromEnv !== undefined && fromEnv.length > 0
		? fromEnv
		: (loc.token ?? null);
}

/** One peer cycle: resolve → pull manifest → version-echo compare →
 *  atomically store last-known. Never throws — every failure mode lands in
 *  a degraded row (last-known version echoed when one exists). */
async function pullOnePeer(
	label: string,
	env: PeersEnv,
	timeoutMs: number,
	resolve: (label: string) => Promise<HubLocation | null>,
): Promise<PeerRow> {
	const prev = loadPeerLastKnown(label, env);
	const row: PeerRow = {
		label,
		ok: false,
		degraded: true,
		seeded: false,
		changed: false,
		reason: null,
		version: prev?.manifest.version ?? null,
		url: prev?.url ?? null,
		via: prev?.via ?? null,
		rules: prev?.manifest.rules.length ?? 0,
		cr_queue: prev?.manifest.cr_queue.length ?? 0,
	};
	let loc: HubLocation;
	try {
		const found = await resolve(label);
		if (found === null) {
			row.reason = "peer label unresolved (resolveHub chain exhausted)";
			return row;
		}
		loc = found;
	} catch (e) {
		row.reason = `resolve failed: ${String(e)}`;
		return row;
	}
	row.url = loc.url;
	row.via = loc.via;
	try {
		const headers: Record<string, string> = {};
		const token = peerToken(label, loc, env);
		if (token !== null) headers.authorization = `Bearer ${token}`;
		const res = await fetch(`${loc.url}/federation/policy-manifest`, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const man = (await readCapped(res)) as unknown as HubManifestShape;
		if (typeof man.version !== "string" || !Array.isArray(man.rules))
			throw new Error("malformed manifest (missing version/rules)");
		atomicWrite(
			peerLastKnownPath(label, env),
			JSON.stringify({
				pulled_at: new Date().toISOString(),
				hub_label: label,
				url: loc.url,
				via: loc.via,
				manifest: man,
			} satisfies PeerLastKnown),
		);
		return {
			label,
			ok: true,
			degraded: false,
			seeded: prev === null,
			changed: prev !== null && prev.manifest.version !== man.version,
			reason: null,
			version: man.version,
			url: loc.url,
			via: loc.via,
			rules: man.rules.length,
			cr_queue: Array.isArray(man.cr_queue) ? man.cr_queue.length : 0,
		};
	} catch (e) {
		row.reason = String(e);
		return row;
	}
}

export interface PullPeersOpts {
	labels?: string[];
	env?: PeersEnv;
	stackPath?: string;
	timeoutMs?: number;
	/** Label → location seam (tests); default the resolveHub chain. */
	resolve?: (label: string) => Promise<HubLocation | null>;
}

/** One propagation cycle over every declared peer edge. Degrades per peer
 *  independently — one hub down never blocks the others (degradation law). */
export async function pullPeerPolicy(
	opts: PullPeersOpts = {},
): Promise<PeerRow[]> {
	const env: PeersEnv = opts.env ?? process.env;
	const labels = resolvePeerLabels({
		labels: opts.labels,
		env,
		stackPath: opts.stackPath,
	});
	const timeoutMs = opts.timeoutMs ?? 5000;
	const resolve = opts.resolve ?? resolveHub;
	const rows: PeerRow[] = [];
	for (const label of labels)
		rows.push(await pullOnePeer(label, env, timeoutMs, resolve));
	return rows;
}
