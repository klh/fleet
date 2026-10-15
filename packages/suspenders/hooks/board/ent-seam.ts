// hooks/board/ent-seam.ts — W775.1: the board-side enterprise seam. The
// public board carries the CONTRACT only; the private overlay (klh-remote)
// provides the implementation (the W233.x gov surfaces) and registers it at
// board boot. Provider-less = Core SKU: the enterprise routes answer honest
// 501s and the GUI zone stays hidden. One-directional: the overlay imports
// this contract; fleet never references the overlay. Pattern: buckle
// src/gov/hub-seam.ts.
import type { Database } from "bun:sqlite";

// ─── wire shapes — the contract the GUI renders ────────────────────────────

/** A provider slot may reject a panel slice for a named, honest reason. */
export interface FailedSlice {
	ok: false;
	why: string;
}

/** Identity Governance — entitlements + OIDC (users, roles,
 *  contractor/employee tags, MFA posture). */
export interface IdentitySlice {
	ok: true;
	users: Array<{
		id: string;
		label: string;
		kind: "employee" | "contractor";
		roles: string[];
		mfa: "enforced" | "off" | "unknown";
		entitled: boolean;
	}>;
	roles: Array<{
		id: string;
		members: number;
		scopes: string[];
	}>;
	oidc: { issuer: string | null; enforced: boolean } | null;
}

/** Federation Topology — route_audit + spoke enrollment (peers, spoke
 *  health, residency region). */
export interface FederationSlice {
	ok: true;
	peers: Array<{
		spoke_id: string;
		state: "enrolled" | "stale" | "revoked";
		version: string | null;
		policy_version: string | null;
		region: string | null;
		last_seen: number | null;
	}>;
}

/** Audit & Compliance — events + admin_audit (policy changes, key
 *  rotations, failed auth, consent flags). */
export interface AuditSlice {
	ok: true;
	entries: Array<{
		ts: number;
		actor: string;
		action: string;
		target: string;
		outcome: "ok" | "denied" | "error";
	}>;
}

/** Usage & Quotas — usage ingest + teams/ceilings (per-department spend
 *  vs caps, anomalies). */
export interface UsageSlice {
	ok: true;
	departments: Array<{
		id: string;
		label: string;
		spend_tok: number;
		cap_tok: number | null;
		anomaly: boolean;
	}>;
}

/** Policy Manifest — policy manifest + CR queue (active versions,
 *  rollout, signed integrity, overrides). */
export interface PolicySlice {
	ok: true;
	versions: Array<{
		version: string;
		rollout: "active" | "canary" | "retired";
		signed: boolean;
		pinned_by: number | null;
	}>;
	cr_queue: number;
	overrides: string[];
}

/** Secrets Vault — KV/vault (rotation schedules, freshness, access
 *  patterns). */
export interface VaultSlice {
	ok: true;
	secrets: Array<{
		name: string;
		rotated_at: number | null;
		age_days: number | null;
		next_rotation: number | null;
		accesses_24h: number;
	}>;
}

/** M&A Operations — entitlements + ledger (department transfers,
 *  revocation lists). */
export interface MaSlice {
	ok: true;
	transfers: Array<{
		ts: number;
		dept: string;
		spoke_id: string;
		outcome: "done" | "pending" | "denied";
	}>;
	revocations: Array<{
		id: string;
		dept: string;
		at: number;
	}>;
}

/** Panel keys, render order = contract order. */
export const ENT_PANEL_KEYS = [
	"identity",
	"federation",
	"audit",
	"usage",
	"policy",
	"vault",
	"ma",
] as const;
export type EntPanelKey = (typeof ENT_PANEL_KEYS)[number];

/** The entitlements payload: sku posture + entitled panel ids. `panels`
 *  is a subset of ENT_PANEL_KEYS; the GUI renders only listed panels. */
export interface EntitlementsPayload {
	ok: true;
	sku: "enterprise";
	tenant: string | null;
	panels: EntPanelKey[];
}

/** The panels payload: one slice per entitled panel. */
export interface EnterprisePayload {
	ok: true;
	ts: number;
	panels: Partial<Record<EntPanelKey, IdentitySlice | FederationSlice | AuditSlice | UsageSlice | PolicySlice | VaultSlice | MaSlice | FailedSlice>>;
}

// ─── the provider contract ─────────────────────────────────────────────────

/** The enterprise provider — the overlay's gov read-model. Entitlements
 *  answer the posture; panels answer the data. Both may throw: the routes
 *  answer a 503 with the error's message (honest, never a fake 200). */
export interface EnterpriseProvider {
	entitlements(): EntitlementsPayload;
	panels(): EnterprisePayload;
}

/** Factory over the governor db — the overlay passes this at board boot
 *  (the KLH_OVERLAY_* wiring, W688). */
export type EnterpriseFactory = (db: Database) => EnterpriseProvider;

// ─── the provider slot ─────────────────────────────────────────────────────

let slot: EnterpriseProvider | null = null;

/** Register (or clear, null) the overlay's provider — the overlay owns
 *  exactly one; tests clear it to keep the slot process-local clean. */
export function setEnterpriseProvider(p: EnterpriseProvider | null): void {
	slot = p;
}

/** The registered provider, or null = Core SKU (provider-less). */
export function getEnterpriseProvider(): EnterpriseProvider | null {
	return slot;
}

/** The honest 501 body — Core SKU / overlay not wired. */
export const ENT_NO_OVERLAY = {
	ok: false,
	code: "board.no_enterprise_overlay",
	why: "enterprise overlay not active on this board (Core SKU)",
} as const;
