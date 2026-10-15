// hooks/lib/federation-work.ts — W370 federated work view: one wire + one
// pull along the declared peer edges. localWorkFeed() emits THIS machine's
// open work (governor.db work_items, non-terminal states) on the minimal
// wire — id/title/state/owner_sid/updated_at; never descriptions, never
// key material. Visibility boundary: each hub serves only the work IT is
// responsible for — a spoke's items never travel via another hub's feed.
// pullFederatedWork() walks the same declared edges as the W362 policy
// propagation (resolvePeerLabels → resolveHub), GETs /federation/work per
// peer and keeps a per-edge last-known store under the federation home.
// Degradation law (W154/W362): an unreachable peer keeps last-known, is
// logged honestly, never throws — callers get degraded rows. Labels are
// the only thing that travels in config; hosts, ports and keys resolve at
// runtime through the resolveHub chain (config-over-code).
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./board-config.ts";
import {
	type FederationEnv,
	federationHome,
	readCapped,
} from "./federation.ts";
import { type PeersEnv, resolvePeerLabels } from "./federation-peers.ts";
import { type GovernorStore, openStore } from "./govdb-store.ts";
import { type HubLocation, resolveHub } from "./hub-locate.ts";

/** One work item on the wire — the tracking minimum, nothing else. */
export interface WorkFeedItem {
	id: string;
	title: string;
	state: string;
	owner_sid: string | null;
	updated_at: number | null;
}

/** The /federation/work wire: one hub's own open work. */
export interface WorkFeedWire {
	hub: string;
	generated_at: string;
	items: WorkFeedItem[];
	/** Open items before the cap. */
	total: number;
	/** True when items were capped (total > items.length). */
	trunc: boolean;
}

/** Env knobs beyond the shared FederationEnv. */
export interface WorkEnv extends FederationEnv, PeersEnv {
	/** This machine's hub label in the view (defaults to the hostname). */
	KLH_HUB_NAME?: string;
	/** Shared edge secret: required bearer on the serve side when set;
	 * the pull side presents it (per-label override wins, see below). */
	SUSPENDERS_FEDERATION_WORK_TOKEN?: string;
	[key: string]: string | undefined;
}

export const FEDERATION_WORK_TOKEN_ENV = "SUSPENDERS_FEDERATION_WORK_TOKEN";

/** Per-edge last-known path: <federation home>/federation-work-<label>.json */
export function workLastKnownPath(
	label: string,
	env: FederationEnv = {},
): string {
	const safe = label.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return join(federationHome(env), `federation-work-${safe}.json`);
}

export interface WorkLastKnown {
	pulled_at: string;
	hub_label: string;
	url: string;
	via: string;
	feed: WorkFeedWire;
}

/** Read the per-edge last-known store; null when absent/unparseable. */
export function loadWorkLastKnown(
	label: string,
	env: FederationEnv = {},
): WorkLastKnown | null {
	const p = workLastKnownPath(label, env);
	if (!existsSync(p)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as WorkLastKnown;
	} catch {
		return null;
	}
}

/** The hub label this machine reports in feeds and views. */
export function localHubLabel(env: WorkEnv = {}): string {
	return env.KLH_HUB_NAME?.trim() || hostname();
}

const DEFAULT_CAP = 200;
/** Open work = the non-terminal states (the work.ts sibling idiom). */
const OPEN_STATES_SQL = "state NOT IN ('DONE','SUPERSEDED')";

/** This machine's open work on the minimal wire. An unreadable graph
 *  throws — the LOCAL leg has no degradation story (the serve route
 *  answers 500 honestly; the view logs). `cap` bounds the wire; trunc +
 *  total keep the count honest. */
export function localWorkFeed(
	opts: { store?: GovernorStore; env?: WorkEnv; cap?: number } = {},
): WorkFeedWire {
	const store = opts.store ?? openStore();
	const cap = opts.cap ?? DEFAULT_CAP;
	const rows = store
		.query(
			`SELECT id, title, state, owner_sid, updated_at FROM work_items
			 WHERE ${OPEN_STATES_SQL}
			 ORDER BY priority DESC, updated_at DESC, id LIMIT ?`,
		)
		.all(cap + 1) as Array<Record<string, unknown>>;
	const cnt = store
		.query(`SELECT COUNT(*) AS n FROM work_items WHERE ${OPEN_STATES_SQL}`)
		.get() as { n: number };
	const items: WorkFeedItem[] = rows.slice(0, cap).map((r) => ({
		id: String(r.id),
		title: String(r.title ?? ""),
		state: String(r.state ?? ""),
		owner_sid:
			typeof r.owner_sid === "string" && r.owner_sid.length > 0
				? r.owner_sid
				: null,
		updated_at: typeof r.updated_at === "number" ? r.updated_at : null,
	}));
	return {
		hub: localHubLabel(opts.env ?? process.env),
		generated_at: new Date().toISOString(),
		items,
		total: cnt.n,
		trunc: cnt.n > items.length,
	};
}

/** Validate a parsed /federation/work body; null when the shape lies.
 *  Malformed item rows are dropped (honest count: total stays as sent). */
export function parseWorkFeed(
	raw: Record<string, unknown>,
): WorkFeedWire | null {
	const hub = raw.hub;
	if (typeof hub !== "string" || hub.length === 0) return null;
	if (!Array.isArray(raw.items)) return null;
	const items: WorkFeedItem[] = [];
	for (const it of raw.items) {
		if (typeof it !== "object" || it === null) continue;
		const r = it as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.state !== "string") continue;
		items.push({
			id: r.id,
			title: typeof r.title === "string" ? r.title : "",
			state: r.state,
			owner_sid:
				typeof r.owner_sid === "string" && r.owner_sid.length > 0
					? r.owner_sid
					: null,
			updated_at: typeof r.updated_at === "number" ? r.updated_at : null,
		});
	}
	const total = typeof raw.total === "number" ? raw.total : items.length;
	return {
		hub,
		generated_at: typeof raw.generated_at === "string" ? raw.generated_at : "",
		items,
		total,
		trunc: raw.trunc === true,
	};
}

/** The pull credential for one edge, in precedence order: per-label env
 *  (SUSPENDERS_HUB_<LABEL>_TOKEN, the peers-lib key) → the hub location's
 *  own token (hubs.json) → the shared SUSPENDERS_FEDERATION_WORK_TOKEN. */
export function workEdgeToken(
	label: string,
	loc: HubLocation | null,
	env: WorkEnv,
): string | null {
	const envKey = `SUSPENDERS_HUB_${label
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
	const perLabel = env[envKey];
	if (perLabel !== undefined && perLabel.length > 0) return perLabel;
	if (loc?.token !== undefined && loc.token.length > 0) return loc.token;
	const shared = env[FEDERATION_WORK_TOKEN_ENV];
	return shared !== undefined && shared.length > 0 ? shared : null;
}

export interface FedWorkRow {
	label: string;
	ok: boolean;
	degraded: boolean;
	/** First successful pull: the edge's work feed arrived (baseline, not
	 *  reported as a change). */
	seeded: boolean;
	reason: string | null;
	url: string | null;
	via: string | null;
	/** Fresh pulled_at, or the last-known one still in force when degraded. */
	pulled_at: string | null;
	/** The fresh feed, or last-known when the edge degraded (honest: this
	 *  is what the view keeps running on). */
	feed: WorkFeedWire | null;
}

async function pullOneEdge(
	label: string,
	env: WorkEnv,
	timeoutMs: number,
	resolve: (label: string) => Promise<HubLocation | null>,
): Promise<FedWorkRow> {
	const prev = loadWorkLastKnown(label, env);
	const row: FedWorkRow = {
		label,
		ok: false,
		degraded: true,
		seeded: false,
		reason: null,
		url: prev?.url ?? null,
		via: prev?.via ?? null,
		pulled_at: prev?.pulled_at ?? null,
		feed: prev?.feed ?? null,
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
		const token = workEdgeToken(label, loc, env);
		if (token !== null) headers.authorization = `Bearer ${token}`;
		const res = await fetch(`${loc.url}/federation/work`, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const parsed = await readCapped(res);
		const feed = parseWorkFeed(parsed);
		if (feed === null)
			throw new Error("malformed work feed (missing hub/items)");
		atomicWrite(
			workLastKnownPath(label, env),
			JSON.stringify({
				pulled_at: new Date().toISOString(),
				hub_label: label,
				url: loc.url,
				via: loc.via,
				feed,
			} satisfies WorkLastKnown),
		);
		return {
			label,
			ok: true,
			degraded: false,
			seeded: prev === null,
			reason: null,
			url: loc.url,
			via: loc.via,
			pulled_at: new Date().toISOString(),
			feed,
		};
	} catch (e) {
		row.reason = String(e);
		return row;
	}
}

export interface PullWorkOpts {
	labels?: string[];
	env?: WorkEnv;
	stackPath?: string;
	timeoutMs?: number;
	/** Label → location seam (tests); default the resolveHub chain. */
	resolve?: (label: string) => Promise<HubLocation | null>;
}

/** One pull cycle over every declared peer edge. Degrades per edge
 *  independently — one hub down never blocks the others (degradation law). */
export async function pullFederatedWork(
	opts: PullWorkOpts = {},
): Promise<FedWorkRow[]> {
	const env: WorkEnv = opts.env ?? process.env;
	const labels = resolvePeerLabels({
		labels: opts.labels,
		env,
		stackPath: opts.stackPath,
	});
	const timeoutMs = opts.timeoutMs ?? 5000;
	const resolve = opts.resolve ?? resolveHub;
	const rows: FedWorkRow[] = [];
	for (const label of labels)
		rows.push(await pullOneEdge(label, env, timeoutMs, resolve));
	return rows;
}

export interface FedWorkView {
	me: string;
	/** This machine's own open work — the LOCAL scope of the view. */
	local: WorkFeedWire;
	/** One row per declared edge; degraded rows carry last-known. */
	peers: FedWorkRow[];
	generated_at: string;
}

/** The whole federated view: local + every declared edge, one call. */
export async function federatedWorkView(
	opts: {
		store?: GovernorStore;
		labels?: string[];
		env?: WorkEnv;
		stackPath?: string;
		timeoutMs?: number;
		resolve?: (label: string) => Promise<HubLocation | null>;
	} = {},
): Promise<FedWorkView> {
	const env: WorkEnv = opts.env ?? process.env;
	const local = localWorkFeed({ store: opts.store, env, cap: opts.cap });
	const peers = await pullFederatedWork(opts);
	return {
		me: local.hub,
		local,
		peers,
		generated_at: new Date().toISOString(),
	};
}
