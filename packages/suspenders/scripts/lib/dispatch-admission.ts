// dispatch-admission.ts — W576.1.1 decomposition of dispatch-next.ts
// (1500-line law): admission-side reads shared by the dispatch entry and
// its consumers — capsule stdout parsing and the dry-run executor-cv
// snapshot. The CLI-spawning wrappers (capsuleGet/itemCapsuleGet) stay in
// the entry: they bind argv-derived BIN/sh.
import { hostname } from "node:os";
import { cvMap } from "../../hooks/lib/executor-cv.ts";
import { quotaProviderPenalty } from "../../hooks/lib/exec-quota.ts";
import { openStore } from "../../hooks/lib/govdb.ts";
import { ANSI } from "./ready-pool.ts";
import type { StarterSeedFailure } from "./lane-starter.ts";

export type DispatchLane = {
	sid: string;
	item: string;
	pid: number;
	branch: string;
	worktree: string;
	agent?: string;
	host?: string;
	hub?: string;
	slab?: string;
	launchedAt: number;
	attempt?: number;
	seedError?: StarterSeedFailure;
};

type AuditRow = Record<string, unknown>;
const AUDIT_WINDOW_MS = 90_000;
const INTERNAL_CODES = new Set([
	"no_route",
	"buckle.no_route",
	"buckle.internal_error",
	"no_healthy_fit",
]);
/** Ports that can never answer as a cold local specialist: 0 = the cloud
 * escalation leg, 4100 = the litellm cloud gateway. Cloud concurrency
 * limits never pause a route. */
const NON_LOCAL_PORTS = new Set([0, 4100]);
const MAX_TRACE_READS = 5;

/** One bounded, authenticated read per refill. Missing evidence never blocks. */
export const fetchBuckleRouteAudit = async (
	front: string | null,
	token: string | null,
	model: string,
	now = Date.now(),
): Promise<AuditRow[] | null> => {
	if (!front || !token || !model) return null;
	try {
		const url = new URL("/v1/admin/requests", front);
		url.searchParams.set(
			"since",
			new Date(now - AUDIT_WINDOW_MS).toISOString(),
		);
		url.searchParams.set("limit", "200");
		url.searchParams.set("inference", "true");
		url.searchParams.set("model", model);
		const response = await fetch(url, {
			signal: AbortSignal.timeout(1_500),
			headers: { authorization: `Bearer ${token}` },
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { requests?: unknown };
		return Array.isArray(body?.requests) ? body.requests : null;
	} catch {
		return null;
	}
};

/** Belt per-hop receipts for the failing 429s — the only surface where the
 *  cold-model refusal is typed (status 429 + Retry-After on a local port).
 *  Missing evidence never blocks: an unavailable trace read just means the
 *  row stays a bare 429. */
export const fetchBuckleColdReceipts = async (
	front: string | null,
	token: string | null,
	traceIds: string[],
): Promise<Map<string, AuditRow[]>> => {
	const out = new Map<string, AuditRow[]>();
	if (!front || !token) return out;
	for (const traceId of traceIds.slice(0, MAX_TRACE_READS)) {
		if (!/^[0-9a-f]{32}$/.test(traceId)) continue;
		try {
			const url = new URL("/v1/admin/traces", front);
			url.searchParams.set("trace_id", traceId);
			const response = await fetch(url, {
				signal: AbortSignal.timeout(1_500),
				headers: { authorization: `Bearer ${token}` },
			});
			if (!response.ok) continue;
			const body = (await response.json()) as { belt?: { attempts?: unknown } };
			if (Array.isArray(body?.belt?.attempts))
				out.set(traceId, body.belt.attempts);
		} catch {
			// an unreadable trace leaves its 429 unattributed
		}
	}
	return out;
};

/** The typed cold-model receipt: the route_audit 429 row's belt trace must
 *  show a local-port hop answered 429 with a live Retry-After. Cloud ports
 *  (0 = escalation, 4100 = litellm) and bare 429s without a receipt never
 *  count; the hold expires with the receipt's Retry-After or the window. */
const coldReceipt = (
	row: AuditRow,
	receipts: Map<string, AuditRow[]> | null,
	now: number,
): boolean => {
	if (row.ok !== 0 || row.status !== 429) return false;
	const attempts = receipts?.get(String(row.trace_id));
	if (!attempts) return false;
	for (const a of attempts) {
		const when = Date.parse(String(a.ts));
		const port = Number(a.port);
		const retryAfterMs = Number(a.retry_after_ms);
		if (
			Number.isFinite(when) &&
			Number.isSafeInteger(a.port) &&
			port > 0 &&
			!NON_LOCAL_PORTS.has(port) &&
			a.status === 429 &&
			Number.isSafeInteger(a.retry_after_ms) &&
			retryAfterMs > 0 &&
			when >= row.when - 5_000 &&
			when <= row.when + 5_000
		)
			return now < when + Math.min(retryAfterMs, AUDIT_WINDOW_MS);
	}
	return false;
};

/** Only exact single-candidate origin evidence for one target can hold a
 *  route: typed internal refusals (502/503 + buckle error code) and cold
 *  model receipts (429 whose belt trace shows the local 429 + Retry-After).
 *  Bare 429s and cloud limits never count; later success clears. */
export const assessBuckleRoute = (
	rows: AuditRow[] | null,
	receipts: Map<string, AuditRow[]> | null,
	model: string | null,
	now = Date.now(),
): { pause: boolean; failures: number } => {
	const clear = { pause: false, failures: 0 };
	if (!rows || !model) return clear;
	const exact = rows
		.map((r) => ({ ...r, when: Date.parse(String(r.ts)) }))
		.filter(
			(r) =>
				r.traffic_kind === "inference" &&
				r.hop === "origin" &&
				r.target_model === model &&
				r.candidates_seen === 1 &&
				typeof r.target_kind === "string" &&
				r.target_kind.length > 0 &&
				typeof r.target_host === "string" &&
				r.target_host.length > 0 &&
				Number.isSafeInteger(r.target_port) &&
				Number(r.target_port) > 0 &&
				typeof r.trace_id === "string" &&
				/^[0-9a-f]{32}$/.test(r.trace_id) &&
				Number.isFinite(r.when) &&
				r.when >= now - AUDIT_WINDOW_MS &&
				r.when <= now,
		)
		.sort((a, b) => b.when - a.when);
	if (!exact.length) return clear;
	const targets = new Set(
		exact.map((r) => `${r.target_kind}|${r.target_host}|${r.target_port}`),
	);
	if (targets.size !== 1) return clear;
	let failures = 0;
	for (const r of exact) {
		if (r.ok === 1 && typeof r.status === "number" && r.status < 400) break;
		const internal =
			r.ok === 0 &&
			(r.status === 502 || r.status === 503) &&
			Number(r.attempts ?? 0) === 0 &&
			INTERNAL_CODES.has(String(r.error_code));
		const cold = coldReceipt(r, receipts, now);
		if (internal || cold) failures++;
	}
	return { pause: failures >= 3, failures };
};

/** Cache each exact model's bounded audit read for one dispatch cycle. */
export class RouteAdmission {
	private readonly rows = new Map<string, AuditRow[] | null>();
	private readonly receipts = new Map<string, Map<string, AuditRow[]>>();

	constructor(
		private readonly enabled: boolean,
		private front: () => Promise<string | null>,
		private token: () => string | null,
	) {}

	async check(
		model: string | null,
	): Promise<{ pause: boolean; failures: number }> {
		if (!this.enabled || !model) return { pause: false, failures: 0 };
		if (!this.rows.has(model)) {
			const rows = await fetchBuckleRouteAudit(
				await this.front(),
				this.token(),
				model,
			);
			this.rows.set(model, rows);
			const cold = (rows ?? []).filter((r) => r.ok === 0 && r.status === 429);
			this.receipts.set(
				model,
				await fetchBuckleColdReceipts(await this.front(), this.token(), [
					...new Set(cold.map((r) => String(r.trace_id))),
				]),
			);
		}
		return assessBuckleRoute(
			this.rows.get(model) ?? null,
			this.receipts.get(model) ?? null,
			model,
		);
	}
}

/** `coord capsule get --as <sid>` output → parsed capsule, or null when the
 *  lane has none. (Bare `capsule get <sid>` misparses the sid as "get" —
 *  always pass --as.) */
export const parseCapsuleGet = (
	stdout: string,
): Record<string, string> | null => {
	const line = stdout.replace(ANSI, "").trim();
	if (!line || line.includes("(no capsule)")) return null;
	try {
		const c = JSON.parse(line) as Record<string, string>;
		return typeof c === "object" && c !== null ? c : null;
	} catch {
		return null;
	}
};

// W620: dry-run cv snapshot — facts read only, no write; the dry brief shows
// the same trust-reordered default ladder the spawn path would pick.
export const cvSnapshot = (): Map<string, number> => {
	const s = openStore();
	try {
		return cvMap(s, hostname());
	} finally {
		s.close();
	}
};

// W374: dry-run quota snapshot — facts + window-state read only (the pick
// path never harvests or writes); the dry brief shows the same
// quota-reordered default ladder the spawn path would pick.
export const quotaSnapshot = (): Map<string, string> => {
	const s = openStore();
	try {
		return quotaProviderPenalty(s);
	} finally {
		s.close();
	}
};
