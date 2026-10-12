// src/admission.ts — W450 bounded RPC admission for the proxy path. Every
// in-flight upstream RPC (headers through full body drain) holds one slot:
// the pass-through socket lives as long as the client keeps reading, so the
// bound must cover the whole stream, not just the walk. Past the cap the
// gateway answers 429 + Retry-After (belt's router-shim precedent — the
// router never queues blindly); the client retries or its ladder falls
// through. Caps: BUCKLE_MAX_INFLIGHT globally, BUCKLE_GROUP_CAPS
// ("group:4,...") per group; malformed entries are dropped, never fatal.

export const DEFAULT_MAX_INFLIGHT = 256;
export const DEFAULT_RETRY_AFTER_S = 2;

const envInt = (v: string | undefined, dflt: number): number => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : dflt;
};

/** Parse a "local-swarm:4,gpt-5.2:32" caps table. */
export function parseGroupCaps(v: string | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	for (const part of (v ?? "").split(",")) {
		const m = part.trim().match(/^([\w.-]+):(\d{1,4})$/);
		if (!m) continue;
		const cap = Number(m[2]);
		if (cap >= 1) out[m[1]] = cap;
	}
	return out;
}

export class RpcAdmission {
	private readonly counts = new Map<string, number>();
	readonly max: number;
	readonly retryAfterS: number;
	readonly groupCaps: Record<string, number>;

	constructor(
		max = envInt(process.env.BUCKLE_MAX_INFLIGHT, DEFAULT_MAX_INFLIGHT),
		retryAfterS = envInt(
			process.env.BUCKLE_RETRY_AFTER_S,
			DEFAULT_RETRY_AFTER_S,
		),
		groupCaps = parseGroupCaps(process.env.BUCKLE_GROUP_CAPS),
	) {
		this.max = max;
		this.retryAfterS = retryAfterS;
		this.groupCaps = groupCaps;
	}

	/** Effective cap: per-group override, else the global max. */
	capOf(group: string): number {
		return this.groupCaps[group] ?? this.max;
	}

	inflight(group: string): number {
		return this.counts.get(group) ?? 0;
	}

	/** Total slots held across all groups. */
	total(): number {
		let n = 0;
		for (const c of this.counts.values()) n += c;
		return n;
	}

	/** Take a slot on `group`; returns a release fn, or null when full. */
	tryAcquire(group: string): (() => void) | null {
		const n = this.counts.get(group) ?? 0;
		if (n >= this.capOf(group)) return null;
		this.counts.set(group, n + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.counts.get(group) ?? 1) - 1;
			if (left > 0) this.counts.set(group, left);
			else this.counts.delete(group);
		};
	}
}
