// src/gov/hub-seam.ts — W233 enterprise-posture seam
// (finding.auth-posture-split): hub-only surfaces declare their contract
// here; the implementation lives in the private enterprise overlay
// (klh-remote packages/buckle-remote). Public solo posture runs
// provider-less — the hub routes answer honest 501s (buckle.no_federation).
// One-directional: the overlay imports this contract; fleet never
// references the overlay.
import type { Database } from "bun:sqlite";
import type { GatewayPolicy } from "../policy.ts";

export const ENROLLMENT_DEFAULT_TTL_S = 900;

/** Registry row — the fleet inventory the hub can finally read. */
export interface SpokeRow {
	spoke_id: string;
	key_id: string | null;
	version: string | null;
	policy_version: string | null;
	enrolled_at: number | null;
	last_seen: number | null;
}

export type EnrollRejection =
	| "buckle.enroll_unknown"
	| "buckle.enroll_expired"
	| "buckle.enroll_used"
	| "buckle.enroll_bind";

export type RedeemResult =
	| {
			ok: true;
			spokeId: string;
			keyId: string;
			key: string;
			expiresAt: number | null;
	  }
	| { ok: false; code: EnrollRejection; why: string };

/** Factory over the federation db — the provider opens the same WAL db the
 *  hub's Federation surface holds; the overlay owns the implementation
 *  (enrollment codes, KeyStore issuance, registry rows). */
export type SpokeEnrollmentFactory = (db: Database) => SpokeEnrollmentProvider;

/** The hub-side spoke-enrollment + fleet-registry provider. Minted codes
 *  return raw material ONCE; redemption issues the hub-fixed spoke scopes
 *  (buckle:spoke:READ_+WRITE_); every authenticated manifest pull is the
 *  heartbeat (touch); list() is the admin inventory. */
export interface SpokeEnrollmentProvider {
	mint(o: { spokeId: string; ttlS: number | null; actor: string }): {
		code: string;
		expiresAt: number;
	};
	redeem(o: { code: string; actor?: string }): RedeemResult;
	touch(o: {
		keyId: string;
		version: string | null;
		policyVersion: string | null;
	}): void;
	list(): SpokeRow[];
}

/** Wire shape the spoke POSTs; the hub stamps spoke = principal key name
 *  (opaque keyId fallback), so the body carries NO identities — team
 *  membership is the only attribution. */
export interface ClassRow {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

/** The hub-side aggregate report the dashboards read (GET /federation/usage
 *  wraps it in {ok: true}). Typed here so the public route keeps its wire
 *  contract; the rollup storage lives in the overlay hub schema. */
export interface FedUsageReport {
	days: number;
	spokes: number;
	windows: Array<{
		bucket: number;
		team: string;
		spoke: string;
		classes: Record<string, ClassRow>;
	}>;
	aids: Array<{
		bucket: number;
		team: string;
		spoke: string;
		aid: string;
		domain: string;
		injected: number;
		skipped: number;
		tok_injected: number;
	}>;
}

/** One ingest verdict: ok carries the store counts; !ok is the route's
 *  error envelope (400 bad body · 403 not opted in · 422 private domain). */
export type UsageIngestResult =
	| { ok: true; windows: number; rows: number }
	| { ok: false; status: number; code: string; why: string };

/** Factory over the federation db + the hub's routing policy (the opt-in
 *  block is public config; the ingest pipeline is not) — the overlay owns
 *  validation, the private-domain guard, and the rollup DDL/storage. */
export type UsageIngestFactory = (
	db: Database,
	policy: GatewayPolicy,
) => UsageIngestProvider;

/** The hub-side aggregate self-report provider: POST /federation/usage
 *  ingest (strict allowlist, per-team opt-in, structural private-domain
 *  guard, idempotent rollup upsert) + the hub-admin rollup read. */
export interface UsageIngestProvider {
	ingest(o: { body: unknown; spoke: string }): UsageIngestResult;
	read(days: number, nowMs?: number): FedUsageReport;
}
