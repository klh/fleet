// dispatch-admission.ts — W576.1.1 decomposition of dispatch-next.ts
// (1500-line law): admission-side reads shared by the dispatch entry and
// its consumers — capsule stdout parsing and the dry-run executor-cv
// snapshot. The CLI-spawning wrappers (capsuleGet/itemCapsuleGet) stay in
// the entry: they bind argv-derived BIN/sh.
import { hostname } from "node:os";
import { cvMap } from "../../hooks/lib/executors/executor-cv.ts";
import { openStore } from "../../hooks/lib/govdb/govdb.ts";
import { quotaProviderPenalty } from "../../hooks/lib/usage/exec-quota.ts";
import type { StarterSeedFailure } from "./lane-starter.ts";
import { ANSI } from "./ready-pool.ts";
import {
	AUDIT_WINDOW_MS,
	type AuditReadVerdict,
	type AuditRow,
	fetchBuckleRouteAuditVerdict,
} from "./route-audit-read.ts";

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

const INTERNAL_CODES = new Set([
	"no_route",
	"buckle.no_route",
	"buckle.internal_error",
	"no_healthy_fit",
]);

/** One bounded, authenticated read per refill. Missing evidence never blocks.
 *  W1310: the wire call and its failure classification live in
 *  ./route-audit-read.ts; this wrapper keeps the `AuditRow[] | null`
 *  contract for existing callers. */
export const fetchBuckleRouteAudit = async (
	front: string | null,
	token: string | null,
	model: string,
	now = Date.now(),
): Promise<AuditRow[] | null> =>
	(await fetchBuckleRouteAuditVerdict(front, token, model, now)).rows;

/** Only exact selected-target evidence can hold a route. A typed upstream
 * refusal may hold until Retry-After; a bare 429 cannot. */
export const assessBuckleRoute = (
	rows: AuditRow[] | null,
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
				r.selected_target_exact === true &&
				typeof r.target_kind === "string" &&
				r.target_kind.length > 0 &&
				typeof r.target_host === "string" &&
				r.target_host.length > 0 &&
				Number.isSafeInteger(r.target_port) &&
				Number(r.target_port) > 0 &&
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
			r.attempts === 0 &&
			INTERNAL_CODES.has(String(r.error_code));
		const localCold =
			r.ok === 0 &&
			r.status === 429 &&
			r.selected_target_attempted === true &&
			r.upstream_refusal_code === "local_cold" &&
			(r.refusal_origin === "upstream" ||
				r.refusal_origin === "bridged-upstream") &&
			Number.isSafeInteger(r.retry_after_ms) &&
			Number(r.retry_after_ms) > 0 &&
			now < r.when + Math.min(Number(r.retry_after_ms), AUDIT_WINDOW_MS);
		if (internal || localCold) failures++;
	}
	return { pause: failures >= 3, failures };
};

/** Cache each exact model's bounded audit read for one dispatch cycle. */
export class RouteAdmission {
	/** The cached verdict per exact model (W1310: verdict, not bare rows). */
	private readonly reads = new Map<string, AuditReadVerdict>();

	constructor(
		private readonly enabled: boolean,
		private readonly front: () => Promise<string | null>,
		private readonly token: () => string | null,
		/** W1102.1 plaid posture: an UNAVAILABLE audit read holds the launch
		 *  (fail-closed); steady keeps missing-evidence-never-blocks. */
		private readonly requireEvidence = false,
	) {}

	/** A newly launched lane may have produced fresh refusal evidence. */
	invalidate(): void {
		this.reads.clear();
	}

	async check(
		model: string | null,
	): Promise<{ pause: boolean; failures: number; reason?: string | null }> {
		if (!this.enabled || !model) return { pause: false, failures: 0 };
		if (!this.reads.has(model))
			this.reads.set(
				model,
				await fetchBuckleRouteAuditVerdict(
					await this.front(),
					this.token(),
					model,
				),
			);
		const read = this.reads.get(model);
		const rows = read?.rows ?? null;
		// rows null = the read found no usable evidence — front down/401/
		// timeout/odd shape (the verdict names the class); a reachable
		// authenticated `requests: []` is rows === []
		if (this.requireEvidence && rows === null)
			return {
				pause: true,
				failures: 0,
				reason: `buckle route audit read unavailable — launch held (fail-closed): ${read?.note ?? "no read"}`,
			};
		return assessBuckleRoute(rows, model);
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
