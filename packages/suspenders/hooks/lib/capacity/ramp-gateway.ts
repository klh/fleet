// hooks/lib/capacity/ramp-gateway.ts — W1713 admin-surface reads for the
// capacity ramp: the in-flight index (gateway-wide RPCs), the request ledger
// window (distinct productive lane ids, cache/token columns, collateral
// errors on lanes that are not ours) and the key list (revoke verification).
// Parsers are pure; the three fetchers take an injected fetch + admin key.

export type Fetch = typeof fetch;

export interface GatewayInflight {
	active: number;
	byLane: Record<string, number>;
	byModel: Record<string, number>;
}

export interface LedgerRow {
	rid: string;
	lane: string;
	ts: string;
	status: number | null;
	ok: boolean;
	durationMs: number;
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheC: number;
	errorCode: string | null;
	model: string | null;
}

export interface LedgerSide {
	rows: number;
	okRows: number;
	errRows: number;
	lanesOk: number;
	lanesErr: number;
	byStatus: Record<string, number>;
	tokens: { in: number; out: number; cacheRead: number; cacheWrite: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) ? v : 0;
const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

const counts = (v: unknown): Record<string, number> => {
	const out: Record<string, number> = {};
	if (!isRecord(v)) return out;
	for (const [k, n] of Object.entries(v))
		if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
	return out;
};

export function parseInflight(body: unknown): GatewayInflight | null {
	if (!isRecord(body) || !isRecord(body.aggregates)) return null;
	const a = body.aggregates;
	if (typeof a.active_requests !== "number") return null;
	return {
		active: a.active_requests,
		byLane: counts(a.by_lane),
		byModel: counts(a.by_model),
	};
}

export function parseLedger(body: unknown): LedgerRow[] | null {
	if (!isRecord(body) || !Array.isArray(body.requests)) return null;
	const rows: LedgerRow[] = [];
	for (const r of body.requests) {
		if (!isRecord(r)) continue;
		rows.push({
			rid: str(r.rid) ?? "",
			lane: str(r.lane) ?? "",
			ts: str(r.ts) ?? "",
			status: typeof r.status === "number" ? r.status : null,
			ok: r.ok === 1 || r.ok === true,
			durationMs: num(r.duration_ms),
			inTok: num(r.in_tok),
			outTok: num(r.out_tok),
			cacheR: num(r.cache_r),
			cacheC: num(r.cache_c),
			errorCode: str(r.error_code),
			model: str(r.target_model),
		});
	}
	return rows;
}

const emptySide = (): LedgerSide => ({
	rows: 0,
	okRows: 0,
	errRows: 0,
	lanesOk: 0,
	lanesErr: 0,
	byStatus: {},
	tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
});

/** Split a ledger window into this run's lanes and everyone else's. */
export function summarizeLedger(
	rows: LedgerRow[],
	isOwn: (lane: string) => boolean,
): { own: LedgerSide; others: LedgerSide } {
	const sides = { own: emptySide(), others: emptySide() };
	const okLanes = { own: new Set<string>(), others: new Set<string>() };
	const errLanes = { own: new Set<string>(), others: new Set<string>() };
	for (const r of rows) {
		const k = isOwn(r.lane) ? "own" : "others";
		const s = sides[k];
		s.rows += 1;
		const status = String(r.status ?? "none");
		s.byStatus[status] = (s.byStatus[status] ?? 0) + 1;
		if (r.ok) {
			s.okRows += 1;
			okLanes[k].add(r.lane);
		} else {
			s.errRows += 1;
			errLanes[k].add(r.lane);
		}
		s.tokens.in += r.inTok;
		s.tokens.out += r.outTok;
		s.tokens.cacheRead += r.cacheR;
		s.tokens.cacheWrite += r.cacheC;
	}
	for (const k of ["own", "others"] as const) {
		sides[k].lanesOk = okLanes[k].size;
		sides[k].lanesErr = errLanes[k].size;
	}
	return sides;
}

/** Admin GET; null on any transport/HTTP failure (callers degrade, never throw). */
export async function adminGet(
	f: Fetch,
	front: string,
	admin: string,
	path: string,
	timeoutMs = 5_000,
): Promise<unknown> {
	try {
		const r = await f(`${front}${path}`, {
			headers: { authorization: `Bearer ${admin}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		return r.ok ? await r.json() : null;
	} catch {
		return null;
	}
}

export async function fetchInflight(
	f: Fetch,
	front: string,
	admin: string,
): Promise<GatewayInflight | null> {
	return parseInflight(await adminGet(f, front, admin, "/v1/admin/inflight"));
}

const PAGE = 500;

/** One newest-first page (<=500 rows) of the window; null = endpoint unreadable. */
export async function fetchLedger(
	f: Fetch,
	front: string,
	admin: string,
	w: { sinceIso: string; untilIso: string },
): Promise<LedgerRow[] | null> {
	const q = new URLSearchParams({
		since: w.sinceIso,
		until: w.untilIso,
		limit: String(PAGE),
		inference: "true",
	});
	return parseLedger(
		await adminGet(f, front, admin, `/v1/admin/requests?${q.toString()}`),
	);
}

export interface LedgerPages {
	rows: LedgerRow[];
	/** the page budget ran out before the window was exhausted: counts are a floor */
	truncated: boolean;
}

const rowKey = (r: LedgerRow): string =>
	r.rid !== "" ? r.rid : `${r.ts}|${r.lane}|${String(r.durationMs)}`;

/** Walk the window back page by page: each next page ends 1ms past the oldest
 *  ts seen (inclusive of same-ms ties, rid-deduped). null = first page unreadable. */
export async function fetchLedgerAll(
	f: Fetch,
	front: string,
	admin: string,
	w: { sinceIso: string; untilIso: string },
	maxPages = 6,
): Promise<LedgerPages | null> {
	const seen = new Set<string>();
	const rows: LedgerRow[] = [];
	let untilIso = w.untilIso;
	for (let page = 0; page < maxPages; page += 1) {
		const batch = await fetchLedger(f, front, admin, {
			sinceIso: w.sinceIso,
			untilIso,
		});
		if (batch === null) return page === 0 ? null : { rows, truncated: true };
		const fresh = batch.filter((r) => !seen.has(rowKey(r)));
		for (const r of fresh) {
			seen.add(rowKey(r));
			rows.push(r);
		}
		if (batch.length < PAGE) return { rows, truncated: false };
		const oldest = Date.parse(batch.at(-1)?.ts ?? "");
		if (fresh.length === 0 || !Number.isFinite(oldest))
			return { rows, truncated: true };
		untilIso = new Date(oldest + 1).toISOString();
	}
	return { rows, truncated: true };
}

/** A ledger window split own vs others; truncated = counts are a floor. */
export interface LedgerView {
	own: LedgerSide;
	others: LedgerSide;
	truncated: boolean;
}

/** null in, null out: an unreadable ledger is reported as unreadable, never as zeros. */
export const ledgerView = (
	pages: LedgerPages | null,
	isOwn: (lane: string) => boolean,
): LedgerView | null =>
	pages === null
		? null
		: { ...summarizeLedger(pages.rows, isOwn), truncated: pages.truncated };

/** key_id → revoked? for the requested ids; unknown ids are absent (never minted/purged). */
export async function fetchKeyRevocations(
	f: Fetch,
	front: string,
	admin: string,
	ids: string[],
): Promise<Map<string, boolean> | null> {
	const body = await adminGet(f, front, admin, "/v1/admin/keys");
	if (!isRecord(body) || !Array.isArray(body.keys)) return null;
	const want = new Set(ids);
	const out = new Map<string, boolean>();
	for (const k of body.keys) {
		if (!isRecord(k)) continue;
		const id = str(k.key_id);
		if (id !== null && want.has(id)) out.set(id, k.revoked_at != null);
	}
	return out;
}
