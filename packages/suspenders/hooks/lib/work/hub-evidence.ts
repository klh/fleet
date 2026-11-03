// hooks/lib/work/hub-evidence.ts — W2321.3: hub lane spend flows back onto
// the authoritative graph. A hub-side lane closes via `work done` against
// GOVERNOR_STORE_URL, so work.done + the W15 timing events already land on
// the authority — but its token spend lives in the HUB's buckle ledger
// (router_usage/route_audit), which the authority cannot open: the W776
// join reads only the local spoke ledger (resolveBuckleDb), so a hub lane
// renders TOKENS/CACHE/MODEL dashes. This module pulls the hub's own
// per-request read face (GET /v1/admin/requests, lane filter, capped +
// keyset-paged) over the item's FINAL claim window and returns the spend in
// the W2059 BackfillSpend shape, so the caller stamps the SAME
// work.attribution event `work backfill` emits — itemAttribution replays it
// unchanged (ledger > backfill > self-report; a stamp never adds to rows
// the local ledger already attributed). Honest no-data: a hub that answers
// zero rows for the window stays '-' — never invented attribution.
import type { Database } from "bun:sqlite";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import { claimWindows } from "./work-timing.ts";
import type { BackfillSpend } from "../lanes/lane-backfill.ts";
import type { GroupSpend } from "../lanes/lane-spend.ts";

/** The hub's /v1/admin/requests row subset this module consumes (W824 face
 *  — buckles older than W824 answer 404 and degrade to no-data). */
interface HubRequestRow {
	rid: string;
	ts: string;
	in_tok: number | null;
	out_tok: number | null;
	cache_r: number | null;
	cache_c: number | null;
	cost_usd?: number | null;
	requested_group?: string | null;
	served_model?: string | null;
}

export interface HubSpendResult {
	/** null = honest no-data (unreachable hub, auth refused, zero rows). */
	spend: BackfillSpend | null;
	/** why the pull degraded — surfaced to the operator, never silent. */
	reason: string;
	rows: number;
}

/** One hub page: the face caps at limit 500, so a wide window pages by
 *  (ts, rid) keyset — until holds the page's oldest ts, before_rid the
 *  oldest rid; bounded pages keep a lost hub from hanging the verb. */
async function fetchPage(
	base: string,
	token: string | null,
	lane: string,
	sinceIso: string,
	untilIso: string,
	beforeRid: string | null,
	fetchImpl: typeof fetch,
): Promise<{ rows: HubRequestRow[]; status: number; oldest: HubRequestRow | null }> {
	const u = new URL(`${base.replace(/\/+$/, "")}/v1/admin/requests`);
	u.searchParams.set("lane", lane);
	u.searchParams.set("since", sinceIso);
	u.searchParams.set("until", untilIso);
	u.searchParams.set("limit", "500");
	if (beforeRid) u.searchParams.set("before_rid", beforeRid);
	const res = await fetchImpl(u, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
	if (res.status !== 200) return { rows: [], status: res.status, oldest: null };
	const body = (await res.json().catch(() => null)) as {
		requests?: HubRequestRow[];
	} | null;
	const rows = Array.isArray(body?.requests)
		? (body.requests as HubRequestRow[])
		: [];
	// newest-first: the page's oldest row is the LAST element
	const oldest = rows.length ? rows[rows.length - 1] : null;
	return { rows, status: 200, oldest };
}

/** Pull one lane's hub spend over [fromMs, toMs): every page's rows
 *  reduced to the BackfillSpend shape (group = requested_group, else
 *  served_model, else '?'). Cost stays null — the hub's cost_usd is a
 *  per-row floor and the W2059 stamp never carried cost. */
export async function hubLaneSpend(
	opts: {
		base: string;
		token?: string | null;
		lane: string;
		fromMs: number;
		toMs: number;
		fetchImpl?: typeof fetch;
		maxPages?: number;
	},
): Promise<HubSpendResult> {
	const f = opts.fetchImpl ?? fetch;
	const sinceIso = new Date(opts.fromMs).toISOString();
	const untilIso = new Date(opts.toMs).toISOString();
	const maxPages = opts.maxPages ?? 20;
	let beforeRid: string | null = null;
	let all: HubRequestRow[] = [];
	for (let page = 0; page < maxPages; page++) {
		const r = await fetchPage(
			opts.base,
			opts.token ?? null,
			opts.lane,
			sinceIso,
			untilIso,
			beforeRid,
			f,
		);
		if (r.status !== 200)
			return {
				spend: null,
				reason: `hub ${opts.base} answered HTTP ${r.status}`,
				rows: 0,
			};
		all = all.concat(r.rows);
		if (r.rows.length < 500 || !r.oldest) break;
		beforeRid = r.oldest.rid;
	}
	if (!all.length)
		return { spend: null, reason: "no rows in the claim window", rows: 0 };
	const t = { fresh: 0, cached: 0, out: 0, requests: 0 };
	const groups: Record<string, GroupSpend> = {};
	for (const r of all) {
		// window honor: the face filters lexically on ISO ts, but a proxy that
		// ignores since/until must not smuggle out-of-window tokens in
		const ts = Date.parse(r.ts);
		if (!Number.isFinite(ts) || ts < opts.fromMs || ts >= opts.toMs) continue;
		const i = r.in_tok ?? 0;
		const o = r.out_tok ?? 0;
		const cr = r.cache_r ?? 0;
		const cc = r.cache_c ?? 0;
		t.fresh += i;
		t.out += o;
		t.cached += cr + cc;
		t.requests += 1;
		const g = r.requested_group || r.served_model || "?";
		const cur = groups[g] ?? {
			in: 0,
			out: 0,
			cacheR: 0,
			cacheC: 0,
			requests: 0,
			costUsd: null,
		};
		groups[g] = {
			in: cur.in + i,
			out: cur.out + o,
			cacheR: cur.cacheR + cr,
			cacheC: cur.cacheC + cc,
			requests: cur.requests + 1,
			costUsd: null,
		};
	}
	if (t.fresh + t.cached + t.out <= 0)
		return { spend: null, reason: "rows carried no usage", rows: all.length };
	return {
		spend: { ...t, groups },
		reason: "ok",
		rows: all.length,
	};
}

/** The item's FINAL claim window (last claim → its close; open claim runs
 *  to nowMs) — the same replay backfillForItem windows on, minus the local
 *  ledger read. Null when the item was never claimed. */
export function finalClaimWindow(
	store: GovernorStore,
	project: string,
	work: string,
	nowMs = Date.now(),
): { sid: string; start: number; end: number } | null {
	const { windows } = claimWindows(
		store as unknown as Database,
		project,
		nowMs,
	);
	const ws = windows.get(work) ?? [];
	const last = ws[ws.length - 1];
	if (!last) return null;
	return { sid: last.sid, start: last.start, end: last.end || nowMs };
}

/** The stamp digest — payload identity for idempotence. */
export const hubStampDigest = (
	spend: BackfillSpend,
	hub: string,
): string =>
	`${hub}|${spend.fresh}|${spend.cached}|${spend.out}|${spend.requests}|${Object.keys(spend.groups).sort().join(",")}`;

/** Latest work.attribution stamp digest for an item, or null when none.
 *  Reads the bus the same replay attributionBackfills does (last event
 *  wins); payload.hub + the backfill JSON identify a hub stamp. */
export function latestStamp(
	store: GovernorStore,
	project: string,
	work: string,
): { digest: string; hub: string | null } | null {
	const rows = (
		store
			.query(
				"SELECT payload FROM events WHERE kind = 'work.attribution' AND project = ? AND payload LIKE ? ORDER BY ts, id",
			)
			.all(project, `%"work":"${work}"%`) as { payload: string | null }[]
	).slice(-1);
	const raw = rows[0]?.payload;
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as {
			backfill?: string;
			hub?: string;
		};
		if (!p.backfill) return null;
		const spend = JSON.parse(p.backfill) as BackfillSpend;
		return { digest: hubStampDigest(spend, p.hub ?? ""), hub: p.hub ?? null };
	} catch {
		return null;
	}
}

/** Resolve a hub label to its buckle base + front token (machine config
 *  chain, hub-locate.ts). Null = unreachable label — the caller reports. */
export async function resolveHubFace(
	label: string,
): Promise<{ base: string; token: string | null } | null> {
	const { resolveHub } = await import("../hub/hub-locate.ts");
	const loc = await resolveHub(label);
	return loc ? { base: loc.url, token: loc.token ?? null } : null;
}

/** W2321.3: one item's hub-side spend over its final claim window — the
 *  --hub leg of `work backfill`. Null when the hub is unreachable or the
 *  window honestly carries nothing (never invented data). */
export async function hubBackfillForItem(
	store: GovernorStore,
	project: string,
	work: string,
	sid: string,
	hubLabel: string,
	resolve: typeof resolveHubFace = resolveHubFace,
): Promise<BackfillSpend | null> {
	const win = finalClaimWindow(store, project, work);
	if (!win) return null;
	const face = await resolve(hubLabel);
	if (!face) return null;
	const r = await hubLaneSpend({
		base: face.base,
		token: face.token,
		lane: sid,
		fromMs: win.start,
		toMs: win.end,
	});
	return r.spend;
}

/** The `work backfill` branch, wholesale (W2059 + the W2321.3 --hub leg).
 *  CLI singletons arrive injected — this module never imports the CLI. */
export interface BackfillVerbDeps {
	store: GovernorStore;
	project: string;
	get: (id: string) => { state: string };
	completionRecord: (
		store: GovernorStore,
		project: string,
		id: string,
	) => { completed_by?: string | null } | null;
	backfillForItem: (
		store: never,
		project: string,
		id: string,
		sid: string,
		ledger: string | null,
	) => BackfillSpend | null;
	resolveBuckleDb: () => string | null;
	/** pin: hub face resolver (tests point this at a stub hub) */
	hubFace?: typeof resolveHubFace;
	emit: (kind: string, id: string, extra: Record<string, string>) => void;
	log: (line: string) => void;
	green: (s: string) => string;
	cyan: (s: string) => string;
	die: (m: string) => never;
}

export async function runBackfillVerb(
	deps: BackfillVerbDeps,
	id: string | undefined,
	flag: (n: string) => string | null,
): Promise<void> {
	const { store, project, die } = deps;
	if (!id) die("usage: backfill <id> [--as sid] [--hub <label>]");
	const hubLabel = flag("--hub");
	const it = deps.get(id);
	if (it.state !== "DONE")
		die(`${id} is ${it.state} — backfill attributes a DONE item close`);
	const record = deps.completionRecord(store, project, id);
	const sid = flag("--as") ?? String(record?.completed_by ?? "").trim();
	if (!sid) die(`${id} has no closer sid on record — pass --as <sid>`);
	await stampBackfill(deps, id, sid, hubLabel);
}

// The spend pull + stamp, shared by both legs (local spoke ledger vs hub
// /v1/admin/requests). Honest no-data on a null pull; the hub leg rides
// hubBackfillForItem (window + face resolution + bounded pages).
async function stampBackfill(
	deps: BackfillVerbDeps,
	id: string,
	sid: string,
	hubLabel: string | null,
): Promise<void> {
	const { store, project } = deps;
	const bf = hubLabel
		? await hubBackfillForItem(
				store,
				project,
				id,
				sid,
				hubLabel,
				deps.hubFace,
			)
		: deps.backfillForItem(
				store as never,
				project,
				id,
				sid,
				deps.resolveBuckleDb(),
			);
	if (!bf) {
		deps.log(
			`${id}: ${hubLabel ? `hub ${hubLabel} pull gave no spend` : "no closer-key ledger rows in the close window"} — stays '-' (honest no-data)`,
		);
		return;
	}
	deps.emit("work.attribution", id, {
		backfill: JSON.stringify(bf),
		sid,
		...(hubLabel ? { hub: hubLabel } : {}),
	});
	deps.log(
		`${deps.green("✓")} ${deps.cyan(id)} attribution backfilled${hubLabel ? ` from hub ${hubLabel}` : ""}: fresh ${bf.fresh} · cached ${bf.cached} · out ${bf.out} · ${bf.requests} req · groups ${Object.keys(bf.groups).join(",") || "-"}`,
	);
}
