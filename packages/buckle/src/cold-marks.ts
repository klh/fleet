// src/cold-marks.ts — the ONE shared cold mark per upstream account
// (anti-stampede; owner correction 2026-10-29). One rate-shaped refusal or
// quota wall marks the account cold for EVERY caller until its clamped,
// jittered reset: callers arriving inside the window never knock — they get
// the instant local answer (429 + Retry-After) or a known-healthy failover
// rung. N callers → 1 upstream knock per window.
//
// Expiry is half-open and SINGLE-FLIGHT: exactly one caller claims the probe;
// everyone else stays cold until that probe answers (success closes, a new
// refusal re-colds) or goes stale (probe_stale_s — an abandoned probe never
// wedges the account). The mark keys on the explicit provider_pool binding
// when present (the account — every alias shares it), else group|url.
//
// Rate pressure (Z.ai 1302/1305, plain 429) is a SHORT cold; only declared
// quota-wall codes (balance/plan exhaustion) are long and flip the dispatch
// stop signal. Nothing here sleeps.
import {
	RESILIENCE_DEFAULTS,
	type ResilienceConfig,
} from "./resilience-config.ts";
import type { Deployment } from "./upstreams.ts";

export type ColdState = "none" | "cold" | "probe-free" | "probe-busy";

/** An in-flight knock/probe verdict its RTT burst can ride. */
interface VerdictGate {
	verdict: Promise<"success" | "refused" | "released">;
	settle: (v: "success" | "refused" | "released") => void;
}

interface ColdCell {
	until: number;
	quota: boolean;
	halfOpen: boolean;
	probeAt: number | null;
	groups: Set<string>;
	/** A knock in flight whose verdict has not landed: stamped by the
	 *  claiming walker (placeholder) or by the first rider on a half-open
	 *  probe. Concurrent callers ride the gate instead of knocking — a
	 *  refusal answers them locally from the banked words, a success opens
	 *  the account to the whole riding batch. */
	placeholder?: boolean;
	gate?: VerdictGate;
}

type ColdRowState = Exclude<ColdState, "none">;

export interface ColdSnapshotRow {
	key: string;
	groups: string[];
	reason: "rate" | "quota";
	state: ColdRowState;
	remainingS: number;
}

/** The account key a cold mark binds to: provider_pool when declared (same
 *  grammar the router validates), else the deployment identity. */
export function coldKeyOf(dep: Deployment): string {
	const pool = dep.adapter_config?.provider_pool;
	return typeof pool === "string" && /^[\w.-]{1,64}$/.test(pool)
		? `pool:${pool}`
		: `${dep.group}|${dep.url}`;
}

export class ColdMarks {
	private readonly cells = new Map<string, ColdCell>();

	/** An in-flight knock/probe verdict its RTT burst can ride. */
	static openGate(): VerdictGate {
		let settle!: (v: "success" | "refused" | "released") => void;
		const verdict = new Promise<"success" | "refused" | "released">((r) => {
			settle = r;
		});
		return { verdict, settle };
	}

	/** Ride an in-flight verdict for at most `ms` (a real, cleared timer —
	 *  never the router's backoff seam). Abort or timeout = "timeout". */
	static async ride(
		gate: VerdictGate,
		ms: number,
		signal?: AbortSignal,
	): Promise<"success" | "refused" | "released" | "timeout"> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		const bound = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), ms);
			onAbort = () => resolve("timeout");
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([gate.verdict, bound]);
		} finally {
			clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	constructor(
		private readonly now: () => number = Date.now,
		private readonly cfg: ResilienceConfig = RESILIENCE_DEFAULTS,
		private readonly rng: () => number = Math.random,
	) {}

	/** The in-flight verdict gate a blocked caller may ride, if one exists. */
	gateOf(dep: Deployment): VerdictGate | null {
		return this.cells.get(coldKeyOf(dep))?.gate ?? null;
	}

	/** Mark the account cold. Returns the (jittered) cold seconds. A quota
	 *  mark is sticky over a later rate refusal inside its window. */
	cool(
		dep: Deployment,
		o: { retryAfterS: number | null; quota: boolean },
	): number {
		const c = this.cfg;
		const k = coldKeyOf(dep);
		const prior = this.cells.get(k);
		const quota =
			o.quota || (prior?.quota === true && this.now() < prior.until);
		const ra =
			o.retryAfterS !== null && Number.isFinite(o.retryAfterS)
				? Math.max(0, o.retryAfterS)
				: null;
		const base = quota
			? Math.min(ra ?? c.quota_cooldown_s, c.quota_cooldown_max_s)
			: Math.min(ra ?? c.rate_cooldown_s, c.rate_cooldown_max_s);
		const r = this.rng();
		// the in-flight knock's verdict settles its riding burst
		prior?.gate?.settle("refused");
		const jitter = Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0;
		const coldS = Math.max(1, base) * (1 + c.cooldown_jitter_ratio * jitter);
		const groups = prior?.groups ?? new Set<string>();
		groups.add(dep.group);
		this.cells.set(k, {
			until: this.now() + coldS * 1000,
			quota,
			halfOpen: false,
			probeAt: null,
			groups,
		});
		return coldS;
	}

	/** Expiry transitions cold → half-open (probe-free until claimed). */
	state(dep: Deployment): ColdState {
		const cell = this.cells.get(coldKeyOf(dep));
		if (cell === undefined) return "none";
		const now = this.now();
		if (now < cell.until) return "cold";
		cell.halfOpen = true;
		if (
			cell.probeAt !== null &&
			now - cell.probeAt < this.cfg.probe_stale_s * 1000
		)
			return "probe-busy";
		return "probe-free";
	}

	/** Blocks a knock: cold, or a half-open probe already in flight. */
	blocking(dep: Deployment): boolean {
		const s = this.state(dep);
		return s === "cold" || s === "probe-busy";
	}

	/** May this caller knock? Closed → yes; half-open → exactly one caller
	 *  wins the probe; cold or probe-busy → no. While a knock or probe is in
	 *  flight the OTHERS of the same RTT burst ride the gate (short bounded
	 *  queue — the owner's allowance) instead of knocking or falsely
	 *  refusing before any verdict exists. */
	claimProbe(dep: Deployment): boolean {
		const s = this.state(dep);
		if (s === "none") {
			// stamp the placeholder NOW: the rest of this RTT burst sees an
			// in-flight verdict instead of racing their own knocks
			this.cells.set(coldKeyOf(dep), {
				until: this.now(),
				quota: false,
				halfOpen: false,
				probeAt: null,
				groups: new Set<string>(),
				placeholder: true,
				gate: ColdMarks.openGate(),
			});
			return true;
		}
		if (s === "cold") return false;
		const cell = this.cells.get(coldKeyOf(dep));
		if (cell === undefined) return true; // raced a success deletion — go
		if (cell.placeholder === true) {
			// a lost knock (its walker died) never wedges the account: past
			// the stale horizon the placeholder is re-claimable
			if (this.now() - cell.until < this.cfg.probe_stale_s * 1000) return false; // ride the in-flight knock
			this.cells.set(coldKeyOf(dep), {
				until: this.now(),
				quota: false,
				halfOpen: false,
				probeAt: null,
				groups: cell.groups,
				placeholder: true,
				gate: ColdMarks.openGate(),
			});
			return true;
		}
		// half-open: exactly one rider claims the single-flight probe
		if (cell.probeAt === null) {
			cell.probeAt = this.now();
			cell.gate = ColdMarks.openGate();
			return true;
		}
		return false;
	}

	/** Seconds a blocked caller should wait (null = not blocked). */
	remainingS(dep: Deployment): number | null {
		const s = this.state(dep);
		if (s === "probe-busy") return 1;
		if (s !== "cold") return null;
		const cell = this.cells.get(coldKeyOf(dep));
		return Math.max(1, Math.ceil(((cell?.until ?? 0) - this.now()) / 1000));
	}

	/** True while a quota wall blocks this account. */
	quotaWall(dep: Deployment): boolean {
		return this.blocking(dep) && this.cells.get(coldKeyOf(dep))?.quota === true;
	}

	/** A delivered answer closes a half-open (or lapsed) mark. A success from
	 *  a request that started BEFORE the mark never clears a live window.
	 *  The in-flight probe's verdict settles its riding burst (opens the
	 *  account to all of them). */
	success(dep: Deployment): void {
		const k = coldKeyOf(dep);
		const cell = this.cells.get(k);
		if (cell === undefined) return;
		cell.gate?.settle("success");
		if (cell.halfOpen || this.now() >= cell.until || cell.placeholder === true)
			this.cells.delete(k);
	}

	/** A non-rate probe failure releases the probe (outlier ejection owns the
	 *  health verdict); the mark stays half-open for the next claimant. */
	releaseProbe(dep: Deployment): void {
		const k = coldKeyOf(dep);
		const cell = this.cells.get(k);
		if (cell === undefined) return;
		// no cold verdict: riders knock (or queue in admission) themselves
		cell.gate?.settle("released");
		// a knock that ended without a cold mark (concurrency pressure, a
		// non-rate failure) retires its placeholder — the account reopens
		if (cell.placeholder === true) this.cells.delete(k);
		else if (cell.halfOpen === true) cell.probeAt = null;
	}

	snapshot(): ColdSnapshotRow[] {
		const now = this.now();
		const rows: ColdSnapshotRow[] = [];
		for (const [key, cell] of this.cells) {
			const busy =
				cell.probeAt !== null &&
				now - cell.probeAt < this.cfg.probe_stale_s * 1000;
			const state: ColdRowState =
				now < cell.until ? "cold" : busy ? "probe-busy" : "probe-free";
			rows.push({
				key,
				groups: [...cell.groups].sort(),
				reason: cell.quota ? "quota" : "rate",
				state,
				remainingS:
					state === "cold"
						? Math.max(1, Math.ceil((cell.until - now) / 1000))
						: 0,
			});
		}
		return rows;
	}
}
