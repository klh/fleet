// src/gov/store-auth.ts — W764: hub model-store pull auth. A dev device
// presents a bksk_ bearer; the store face verifies it against the buckle
// key ledger (one key authority), requires buckle:store:READ_, and charges
// a per-KEY token bucket — 50 devs pulling at once each drain their own
// bucket, never a shared budget (fairness = per-key isolation, not a
// global rate). Buckets are in-memory per process (a restart resets
// fairness accounting, acceptable for rate shaping) and sweep() drops
// idle keys so the map stays bounded.
import { tokenFromHeaders } from "../ledger.ts";
import { KeyStore } from "./keys.ts";
import { hasScope, scopesFromStorage } from "./scopes.ts";

export const STORE_READ_SCOPE = "buckle:store:READ_";
export const STORE_WRITE_SCOPE = "buckle:store:WRITE_";

/** Burst depth per key (tokens). */
export interface BucketOpts {
	capacity: number;
	/** Sustained refill: tokens per key per second. */
	refillPerS: number;
	/** sweep() drops buckets whose last take is older than this. */
	idleTtlMs: number;
}

interface BucketState {
	tokens: number;
	last: number;
}

export type TakeResult =
	| { ok: true; tokens: number }
	| { ok: false; retryAfterS: number | null };

/** The pull surface's fairness primitive: classic token bucket, one per
 *  key, lazy-created on first take. Fractional refill (tokens are floats)
 *  keeps accounting exact across uneven take spacing. */
export class TokenBucket {
	readonly capacity: number;
	readonly refillPerS: number;
	private readonly idleTtlMs: number;
	private readonly state = new Map<string, BucketState>();

	constructor(opts: BucketOpts) {
		if (!(opts.capacity > 0)) throw new Error("capacity must be > 0");
		if (!(opts.refillPerS > 0)) throw new Error("refillPerS must be > 0");
		this.capacity = opts.capacity;
		this.refillPerS = opts.refillPerS;
		this.idleTtlMs = opts.idleTtlMs;
	}

	/** One attempt's charge: ok spends `cost`; !ok reports retryAfterS (null
	 *  when cost exceeds capacity — no wait makes it satisfiable). */
	take(id: string, cost = 1, now = Date.now()): TakeResult {
		const b = this.state.get(id) ?? { tokens: this.capacity, last: now };
		const elapsedS = Math.max(0, now - b.last) / 1000;
		const tokens = Math.min(this.capacity, b.tokens + elapsedS * this.refillPerS);
		if (tokens >= cost) {
			this.state.set(id, { tokens: tokens - cost, last: now });
			return { ok: true, tokens: tokens - cost };
		}
		this.state.set(id, { tokens, last: now });
		return {
			ok: false,
			retryAfterS: cost > this.capacity
				? null
				: Math.ceil((cost - tokens) / this.refillPerS),
		};
	}

	/** Drop buckets idle since their last take; returns the dropped count. */
	sweep(now = Date.now()): number {
		const cutoff = now - this.idleTtlMs;
		let dropped = 0;
		for (const [id, b] of this.state) {
			if (b.last <= cutoff) {
				this.state.delete(id);
				dropped++;
			}
		}
		return dropped;
	}
}

export type AuthorizeResult =
	| {
			ok: true;
			kind: "api_key";
			keyId: string;
			actor: string | null;
			team: string | null;
	  }
	| {
			ok: false;
			status: 401 | 403 | 429;
			code: string;
			why: string;
			retryAfterS?: number | null;
	  };

/** The store face's one-call seam: Headers → verified store-read principal
 *  or the wire error envelope (401 unknown/revoked/expired/unknown-type ·
 *  403 missing scope · 429 per-key bucket). Scope check runs BEFORE the
 *  bucket so a scope-less key never touches the fairness accounting; the
 *  bucket charges only authorized takes. */
export class PullAuthorizer {
	readonly bucket: TokenBucket;
	private readonly keys: KeyStore;

	constructor(opts: { keys: KeyStore; bucket: TokenBucket }) {
		this.keys = opts.keys;
		this.bucket = opts.bucket;
	}

	authorize(headers: Headers): AuthorizeResult {
		const token = tokenFromHeaders(headers);
		if (token === null)
			return {
				ok: false,
				status: 401,
				code: "buckle.auth_missing",
				why: "missing credential (send Authorization Bearer or x-api-key)",
			};
		if (token.length === 0)
			return {
				ok: false,
				status: 401,
				code: "buckle.auth_malformed",
				why: "empty bearer token",
			};
		if (!token.startsWith("bksk_"))
			return {
				ok: false,
				status: 401,
				code: "buckle.invalid_key",
				why: "unknown credential type",
			};
		const v = this.keys.verify(token);
		if (!v.ok) return { ok: false, status: 401, code: v.code, why: v.why };
		const { scopes } = scopesFromStorage(v.key.scopes);
		if (!hasScope(scopes, STORE_READ_SCOPE)) {
			return {
				ok: false,
				status: 403,
				code: "buckle.store_scope",
				why: `key ${v.key.key_id} lacks ${STORE_READ_SCOPE}`,
			};
		}
		const t = this.bucket.take(v.key.key_id);
		if (!t.ok)
			return {
				ok: false,
				status: 429,
				code: "buckle.store_rate_limited",
				why: "per-key pull budget drained; retry after backoff",
				retryAfterS: t.retryAfterS,
			};
		return {
			ok: true,
			kind: "api_key",
			keyId: v.key.key_id,
			actor: v.key.actor,
			team: v.key.team,
		};
	}
}
