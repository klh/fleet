// src/gov/hub-seam.ts — W233 enterprise-posture seam
// (finding.auth-posture-split): hub-only surfaces declare their contract
// here; the implementation lives in the private enterprise overlay
// (the private overlay repo). Public solo posture runs
// provider-less — the hub routes answer honest 501s (buckle.no_federation).
// One-directional: the overlay imports this contract; fleet never
// references the overlay.
import type { Database } from "bun:sqlite";
import type { GatewayPolicy } from "../policy.ts";
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

/** CR queue row (W154/W160/W193): the wire row both the manifest's
 *  cr_queue and the hub-admin CR read serve; payload/origin ride storage
 *  JSON — the parse lives at the public wire edge (federation.ts crOut). */
export interface CrRow {
	id: string;
	action: string;
	target: string;
	declared_at: string;
	state: string;
	note: string | null;
	updated_at: number | null;
	reported_at: number | null;
	payload: string | null;
	origin: string | null;
	verified_at: number | null;
	claimed_by: string | null;
	claimed_at: number | null;
}

/** The signed policy manifest the spoke pull serves (content-addressed
 *  version + rules + CR queue) — typed here so the public route keeps its
 *  wire contract; the content building lives in the overlay. */
export interface FedManifest {
	version: string;
	rules: Array<Record<string, unknown>>;
	cr_queue: CrRow[];
}

/** W160: the hub-side verification probe — before a CR may report
 *  `verified`, the hub re-reads the CR's target surface; spoke claims are
 *  never trusted alone. */
export type CrProbe = (cr: CrRow) => { ok: boolean; why: string | null };

/** W193 claim identity: the reporting principal's stable id plus whether it
 *  holds hub-admin capability (admins/root may move any CR; spokes only
 *  their own claims). */
export interface CrActor {
	id: string;
	admin: boolean;
}

/** Verdict shape both CR verbs return: ok carries the fresh row; !ok is
 *  the route's error envelope (400 bad body/origin · 403 claim binding ·
 *  404 unknown id · 409 state/probe · 422 private domain). */
export type CrVerdict =
	| { ok: true; row: CrRow }
	| { ok: false; status: number; code: string; why: string };

/** The policy manifest + CR queue hub provider: the content-addressed
 *  manifest a spoke pull reconciles (buildRules/manifestVersion), the CR
 *  origination + linear lifecycle store, and the verification-probe
 *  registry. The implementation lives in the enterprise overlay
 *  (private overlay repo); public solo posture runs provider-less —
 *  the manifest pull + CR routes answer honest 501s. */
export interface ManifestCrProvider {
	/** The manifest payload: content-addressed version + rules + CR queue. */
	manifest(): FedManifest;
	/** Hub-admin CR origination (W160): shape + origin + the structural
	 *  private-domain guard runs here, before any row exists. */
	declare(o: {
		id: string;
		action: string;
		target: string;
		payload: unknown;
		origin: Record<string, unknown>;
	}): CrVerdict;
	/** The CR queue a spoke must reconcile, oldest first (admin read). */
	list(): CrRow[];
	/** Spoke-reported lifecycle transition, enforced server-side; the
	 *  provider matches registered probes for applied→verified. */
	transition(o: {
		id: string;
		to: string;
		note: string | null;
		actor: CrActor;
	}): CrVerdict;
	/** Register a verification probe for targets with the given prefix
	 *  (longest match wins at verify time). */
	registerProbe(prefix: string, probe: CrProbe): void;
}

/** Factory over the federation db + policy (+ the routing-policy surface
 *  path for the built-in policy-revision probe). */
export type ManifestCrFactory = (
	db: Database,
	policy: GatewayPolicy,
	policyPath: string | undefined,
) => ManifestCrProvider;
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
 *  (buildModels) lives in the enterprise overlay;
 *  public solo posture runs provider-less and the
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
