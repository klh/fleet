// hooks/lib/federation/cross-hub-usage.ts — W365 cross-hub usage rollup: aggregate the
// per-hub GET /federation/usage reports (the hub-stored fed class windows +
// aid rollups) into the local board's usage views. Hubs enumerate from the
// ONE stack config (stack.json hubs) + the global registry (hubs.json) —
// labels travel in config; URLs/tokens resolve at runtime (config-over-code).
// Each hub fetches independently and degrades alone: a down hub lands a
// degraded row, never blocks the others. Results are TTL-cached per label
// (module Map) so the /usage page stays cheap between reloads.
import { readFileSync, statSync } from "node:fs";
import { darkHubNow, tryLoadStack, type StackConfig } from "../stack-config.ts";
import { readCapped } from "./federation.ts";

// ─── wire shapes (mirror of buckle's FedUsageReport GET envelope) ─────────
export interface CrossHubClassCell {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

export interface HubUsageWire {
	ok?: unknown;
	days?: unknown;
	spokes?: unknown;
	windows?: unknown;
	aids?: unknown;
}

// ─── rollup shapes ────────────────────────────────────────────────────────
export interface ClassSum {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
	tok: number;
}

export interface AidSum {
	aid: string;
	domain: string;
	injected: number;
	skipped: number;
	tok_injected: number;
}

export interface CrossHubRow {
	label: string;
	/** Fetched + shaped OK — sums are fresh. */
	ok: boolean;
	/** Resolved but the fetch failed (down/refused/unreachable). */
	degraded: boolean;
	/** No URL candidate anywhere in the config chain. */
	unresolved: boolean;
	/** W483: inside the hub's declared dark window — expected down. */
	quiet: boolean;
	reason: string | null;
	url: string | null;
	via: string | null;
	spokes: number;
	classes: Record<string, ClassSum>;
	aids: AidSum[];
	fetchedAt: string | null;
}

export interface CrossHubReport {
	days: number;
	rows: CrossHubRow[];
	summary: {
		hubs: number;
		ok: number;
		degraded: number;
		unresolved: number;
		classes: Record<string, ClassSum>;
		aids: AidSum[];
	};
}

// ─── enumeration: labels from stack.json hubs ∪ hubs.json registry ────────
const normLabel = (l: string): string => l.trim().toLowerCase();

export interface CrossHubEnv extends Record<string, string | undefined> {
	KLH_STACK?: string;
	SUSPENDERS_HUBS_FILE?: string;
	FEDERATION_HUB_TOKEN?: string;
	BUCKLE_ADMIN_KEY?: string;
	SUSPENDERS_CROSS_HUB_USAGE_TTL_MS?: string;
}

/** Hub labels this board aggregates, case-insensitively deduped, sorted.
 *  stack.json hubs are the machine truth; hubs.json registry keys join. */
export function crossHubLabels(
	opts: { env?: CrossHubEnv; stack?: StackConfig | null } = {},
): string[] {
	const stack = opts.stack !== undefined ? opts.stack : tryLoadStack();
	const seen = new Map<string, string>();
	const add = (l: string): void => {
		const k = normLabel(l);
		if (k.length > 0 && !seen.has(k)) seen.set(k, l.trim());
	};
	for (const l of Object.keys(stack?.hubs ?? {})) add(l);
	for (const l of Object.keys(readRegistryFrom(opts.env))) add(l);
	return [...seen.values()].sort();
}

function readRegistryFrom(env?: CrossHubEnv): Record<string, unknown> {
	const file =
		env?.SUSPENDERS_HUBS_FILE ??
		`${env?.HOME ?? process.env.HOME ?? ""}/.claude/local-llm/hubs.json`;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function readHubTokenFile(path: string | undefined): string | null {
	if (!path) return null;
	try {
		const resolved = path.startsWith("~/")
			? `${process.env.HOME ?? ""}/${path.slice(2)}`
			: path;
		const { mode, size } = statSync(resolved);
		if ((mode & 0o777) !== 0o600 || size > 4096) return null;
		return readFileSync(resolved, "utf8").trim() || null;
	} catch {
		return null;
	}
}

// ─── endpoint resolution: stack profile url → registry candidates ─────────
export interface HubEndpoint {
	url: string;
	via: string;
	token: string | null;
}

/** URL candidates for one label, in try order, with the per-source token.
 *  Never probes the network — the fetch itself decides reachability. */
export function resolveHubEndpoints(
	label: string,
	opts: { env?: CrossHubEnv; stack?: StackConfig | null } = {},
): HubEndpoint[] {
	const want = normLabel(label);
	const out: HubEndpoint[] = [];
	const stack = opts.stack !== undefined ? opts.stack : tryLoadStack();
	let stackToken: string | null = null;
	for (const [l, prof] of Object.entries(stack?.hubs ?? {})) {
		if (normLabel(l) !== want) continue;
		stackToken = readHubTokenFile(prof.token_file) ?? prof.token ?? null;
		if (typeof prof?.url === "string" && prof.url.length > 0)
			out.push({
				url: prof.url.replace(/\/$/, ""),
				via: "stack.json",
				token: stackToken,
			});
	}
	// registry keys are operator config (hubs.json labels like "NAS") while
	// panel labels travel lowercase — the stack.json leg matches case-
	// insensitively, so the registry leg must too, or an upper/lower split
	// config strands every row unresolved.
	const reg = Object.entries(readRegistryFrom(opts.env)).find(
		([k]) => normLabel(k) === want,
	)?.[1] as { candidates?: unknown; token?: unknown } | undefined;
	if (reg !== null && typeof reg === "object") {
		const token =
			stackToken ?? (typeof reg.token === "string" ? reg.token : null);
		const cands = Array.isArray(reg.candidates) ? reg.candidates : [];
		for (const c of cands)
			if (typeof c === "string" && c.length > 0)
				out.push({
					url: c.replace(/\/$/, ""),
					via: "hubs.json",
					token,
				});
	}
	return out;
}

// ─── pure rollup: windows/aids → sums ─────────────────────────────────────
const n0 = (x: unknown): number =>
	typeof x === "number" && Number.isFinite(x) ? x : 0;

/** Sum one hub's windows into per-class sums + per-(aid,domain) aid rows.
 *  Pure — the hub wire carries no identities (team/spoke never summed). */
export function rollupHubWire(wire: HubUsageWire): {
	spokes: number;
	classes: Record<string, ClassSum>;
	aids: AidSum[];
} {
	const classes: Record<string, ClassSum> = {};
	const aidMap = new Map<string, AidSum>();
	const windows = Array.isArray(wire.windows) ? wire.windows : [];
	for (const w of windows) {
		if (typeof w !== "object" || w === null) continue;
		const cls = (w as { classes?: unknown }).classes;
		if (cls === null || typeof cls !== "object") continue;
		for (const [g, cell] of Object.entries(cls as Record<string, unknown>)) {
			if (cell === null || typeof cell !== "object") continue;
			const c = cell as Record<string, unknown>;
			const cur = classes[g] ?? {
				in_tok: 0,
				out_tok: 0,
				cache_r: 0,
				cache_c: 0,
				requests: 0,
				tok: 0,
			};
			cur.in_tok += n0(c.in_tok);
			cur.out_tok += n0(c.out_tok);
			cur.cache_r += n0(c.cache_r);
			cur.cache_c += n0(c.cache_c);
			cur.requests += n0(c.requests);
			cur.tok = cur.in_tok + cur.out_tok + cur.cache_r + cur.cache_c;
			classes[g] = cur;
		}
	}
	const aids = Array.isArray(wire.aids) ? wire.aids : [];
	for (const a of aids) {
		if (typeof a !== "object" || a === null) continue;
		const r = a as Record<string, unknown>;
		const aid = typeof r.aid === "string" ? r.aid : "";
		const domain = typeof r.domain === "string" ? r.domain : "";
		if (aid.length === 0) continue;
		const k = `${aid}\x00${domain}`;
		const cur = aidMap.get(k) ?? {
			aid,
			domain,
			injected: 0,
			skipped: 0,
			tok_injected: 0,
		};
		cur.injected += n0(r.injected);
		cur.skipped += n0(r.skipped);
		cur.tok_injected += n0(r.tok_injected);
		aidMap.set(k, cur);
	}
	return {
		spokes: n0(wire.spokes),
		classes,
		aids: [...aidMap.values()].sort((x, y) => y.tok_injected - x.tok_injected),
	};
}

function emptySum(): ClassSum {
	return {
		in_tok: 0,
		out_tok: 0,
		cache_r: 0,
		cache_c: 0,
		requests: 0,
		tok: 0,
	};
}

function addInto(
	target: Record<string, ClassSum>,
	from: Record<string, ClassSum>,
): void {
	for (const [g, s] of Object.entries(from)) {
		const cur = target[g] ?? emptySum();
		cur.in_tok += s.in_tok;
		cur.out_tok += s.out_tok;
		cur.cache_r += s.cache_r;
		cur.cache_c += s.cache_c;
		cur.requests += s.requests;
		cur.tok += s.tok;
		target[g] = cur;
	}
}

/** Merge two aid sums by (aid, domain) — the summary aggregation. */
function mergeAids(target: AidSum[], add: AidSum[]): AidSum[] {
	const map = new Map<string, AidSum>();
	for (const a of [...target, ...add]) {
		const k = `${a.aid}\x00${a.domain}`;
		const cur = map.get(k) ?? {
			aid: a.aid,
			domain: a.domain,
			injected: 0,
			skipped: 0,
			tok_injected: 0,
		};
		cur.injected += a.injected;
		cur.skipped += a.skipped;
		cur.tok_injected += a.tok_injected;
		map.set(k, cur);
	}
	return [...map.values()].sort((x, y) => y.tok_injected - x.tok_injected);
}

// ─── fetch + TTL cache ────────────────────────────────────────────────────
export type HubFetcher = (
	url: string,
	token: string | null,
	days: number,
) => Promise<{ ok: true; wire: HubUsageWire } | { ok: false; why: string }>;

/** One GET /federation/usage against a hub base URL. Degrades honestly:
 *  non-2xx, malformed body and network errors all land {ok:false, why}. */
export async function fetchHubUsage(
	url: string,
	token: string | null,
	days: number,
	timeoutMs = 4000,
): Promise<{ ok: true; wire: HubUsageWire } | { ok: false; why: string }> {
	try {
		const headers: Record<string, string> = {};
		if (token !== null) headers.authorization = `Bearer ${token}`;
		const res = await fetch(`${url}/federation/usage?days=${String(days)}`, {
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok)
			return { ok: false, why: `hub answered ${String(res.status)}` };
		const body = await readCapped(res);
		if (body.ok !== true)
			return { ok: false, why: "hub answered without ok:true envelope" };
		return { ok: true, wire: body as HubUsageWire };
	} catch (e) {
		return { ok: false, why: String(e) };
	}
}

const cache = new Map<string, { atMs: number; row: CrossHubRow }>();

/** Test seam — drops every TTL-cached hub row. */
export function clearCrossHubTtl(): void {
	cache.clear();
}

const defaultTtl = (env: CrossHubEnv): number => {
	const raw = env.SUSPENDERS_CROSS_HUB_USAGE_TTL_MS;
	const n = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 300_000;
};

export interface RollupOpts {
	days?: number;
	env?: CrossHubEnv;
	nowMs?: number;
	ttlMs?: number;
	timeoutMs?: number;
	/** Label → endpoints seam (tests); default the config chain. */
	endpoints?: (label: string) => HubEndpoint[];
	/** Fetch seam (tests); default fetchHubUsage. */
	fetch?: HubFetcher;
	/** Ignore the TTL cache and fetch fresh (tests, explicit reloads). */
	fresh?: boolean;
}

/** One rollup cycle over every enumerated hub: resolve → fetch (per-hub
 *  degrade) → rollup → TTL cache. One hub down never blocks the others. */
export async function crossHubRollup(
	opts: RollupOpts = {},
): Promise<CrossHubReport> {
	const env = opts.env ?? (process.env as CrossHubEnv);
	const days = Math.min(90, Math.max(1, Math.trunc(opts.days ?? 28) || 28));
	const now = opts.nowMs ?? Date.now();
	const ttlMs = opts.ttlMs ?? defaultTtl(env);
	const labels = crossHubLabels(opts);
	const fetchOne = opts.fetch ?? fetchHubUsage;
	const endpointsFor =
		opts.endpoints ?? ((l: string) => resolveHubEndpoints(l, opts));
	const rows: CrossHubRow[] = [];
	for (const label of labels) {
		const cached = cache.get(normLabel(label));
		if (!opts.fresh && cached !== undefined && now - cached.atMs < ttlMs) {
			rows.push({ ...cached.row, label: cached.row.label });
			continue;
		}
		const row: CrossHubRow = {
			label,
			ok: false,
			degraded: false,
			unresolved: false,
			quiet: darkHubNow(label),
			reason: null,
			url: null,
			via: null,
			spokes: 0,
			classes: {},
			aids: [],
			fetchedAt: null,
		};
		const eps = endpointsFor(label);
		if (eps.length === 0) {
			row.unresolved = true;
			row.reason = "no url in stack.json/hubs.json for this label";
			rows.push(row);
			cache.set(normLabel(label), { atMs: now, row });
			continue;
		}
		let lastWhy = "no endpoint tried";
		let fetched:
			| { ok: true; wire: HubUsageWire }
			| { ok: false; why: string }
			| null = null;
		for (const ep of eps) {
			const out = await fetchOne(ep.url, ep.token ?? envToken(opts.env), days);
			if (out.ok) {
				fetched = out;
				row.url = ep.url;
				row.via = ep.via;
				break;
			}
			lastWhy = out.why;
		}
		if (fetched === null) {
			row.degraded = true;
			row.reason = lastWhy;
			rows.push(row);
			cache.set(normLabel(label), { atMs: now, row });
			continue;
		}
		const roll = rollupHubWire(fetched.wire);
		row.ok = true;
		row.spokes = roll.spokes;
		row.classes = roll.classes;
		row.aids = roll.aids;
		row.fetchedAt = new Date(now).toISOString();
		rows.push(row);
		cache.set(normLabel(label), { atMs: now, row });
	}
	const summary = {
		hubs: rows.length,
		ok: 0,
		degraded: 0,
		unresolved: 0,
		classes: {} as Record<string, ClassSum>,
		aids: [] as AidSum[],
	};
	for (const r of rows) {
		if (r.ok) {
			summary.ok += 1;
			addInto(summary.classes, r.classes);
			summary.aids = mergeAids(summary.aids, r.aids);
		} else if (r.unresolved) summary.unresolved += 1;
		else summary.degraded += 1;
	}
	return { days, rows, summary };
}

/** Env token fallback (routes-federation precedence): FEDERATION_HUB_TOKEN
 *  then BUCKLE_ADMIN_KEY — the browser never sees either. Exported for the
 *  sibling hub-fetch libs (cache-drill) so the precedence lives once. */
export function envToken(env?: CrossHubEnv): string | null {
	const t = env?.FEDERATION_HUB_TOKEN ?? env?.BUCKLE_ADMIN_KEY;
	return t !== undefined && t.length > 0 ? t : null;
}
