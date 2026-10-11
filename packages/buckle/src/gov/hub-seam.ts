// src/gov/hub-seam.ts — W233 enterprise-posture seam
// (finding.auth-posture-split): hub-only surfaces declare their contract
// here; the implementation lives in the private enterprise overlay
// (klh-remote packages/buckle-remote). Public solo posture runs
// provider-less — the hub routes answer honest 501s (buckle.no_federation).
// One-directional: the overlay imports this contract; fleet never
// references the overlay.
import type { Database } from "bun:sqlite";
import type { UpstreamPool } from "../upstreams.ts";

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

/** Echo-menu row (W154): one hub-entitled model entry a spoke belt
 *  mirrors. */
export interface EntitlementModel {
	id: string;
	family: string | null;
	tier: string;
	locality: "cloud" | "hub-local";
	available: boolean;
}

/** W233.1: the hub entitlement-menu provider — the pool→menu mapping
 *  (buildModels) lives in the enterprise overlay (klh-remote
 *  buckle-remote); public solo posture runs provider-less and the
 *  entitlements route answers an honest 501. Team ceilings stay public
 *  (federation.ts reads the shared governance schema). */
export interface HubEntitlementsProvider {
	models(): EntitlementModel[];
}

/** Factory over the hub's live upstream pool + policy capability tags. */
export type HubEntitlementsFactory = (
	pool: UpstreamPool,
	tags: Record<string, string[]>,
) => HubEntitlementsProvider;
