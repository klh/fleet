// hooks/lib/auth/hub-tokens.ts — W231 hub admin plane: the masked token
// inventory + GUI-driven issue/revoke for the /console/hub surface.
// lib/auth.ts owns signing and rotation; this is the admin lens over the
// same api_keys rows — listings are masked (never key_hash, never raw
// material; key_id shows as an 8-char prefix) and every GUI-driven
// mutation lands in admin_audit (governor.db).
import { adminAudit } from "../admin-audit.ts";
import {
	type IssuedPair,
	issueTokens,
	metaOf,
	type RevokeSelector,
	revoke,
	type TokenClass,
} from "./auth.ts";
import type { GovernorStore, IdentityStore } from "../govdb/govdb.ts";

export type HubTokenState = "active" | "rotated" | "revoked" | "expired";

export interface HubTokenRow {
	/** 8-char masked join id — the full key_id never leaves the plane. */
	key_id: string;
	actor: string | null;
	team: string | null;
	token_type: string;
	class: TokenClass;
	label: string | null;
	scopes: string[];
	expires_at: number | null;
	rotated_at: number | null;
	revoked_at: number | null;
	created_at: number;
	state: HubTokenState;
}

interface RawKeyRow {
	key_id: string;
	jti: string | null;
	actor: string | null;
	team: string | null;
	token_type: string;
	scopes: string | null;
	name: string | null;
	expires_at: number | null;
	rotated_at: number | null;
	revoked_at: number | null;
	created_at: number;
}

/** Masked token inventory, newest first. Includes revoked/rotated/expired
 *  rows so the GUI can show the full trail; `state` is derived. */
export function listTokens(
	idb: IdentityStore,
	opts: { actor?: string; limit?: number } = {},
): HubTokenRow[] {
	const actor = opts.actor?.trim();
	const where = actor ? "WHERE actor = ?" : "";
	const rows = idb
		.query(
			`SELECT key_id, jti, actor, team, token_type, scopes, name, expires_at, rotated_at, revoked_at, created_at FROM api_keys ${where} ORDER BY created_at DESC LIMIT ?`,
		)
		.all(...(actor ? [actor] : []), opts.limit ?? 100) as RawKeyRow[];
	const now = Date.now();
	return rows.map((r) => {
		const meta = metaOf(r);
		const state: HubTokenState = r.revoked_at
			? "revoked"
			: r.rotated_at
				? "rotated"
				: r.expires_at !== null && r.expires_at <= now
					? "expired"
					: "active";
		let scopes: string[] = [];
		try {
			const parsed: unknown = JSON.parse(r.scopes ?? "[]");
			if (Array.isArray(parsed))
				scopes = parsed.filter((s): s is string => typeof s === "string");
		} catch {
			// plain scope string (legacy rows) — split on space
			scopes = (r.scopes ?? "").split(/\s+/).filter(Boolean);
		}
		return {
			key_id: r.key_id.slice(0, 8),
			actor: r.actor,
			team: r.team,
			token_type: r.token_type,
			class: meta.class,
			label: meta.label,
			scopes,
			expires_at: r.expires_at,
			rotated_at: r.rotated_at,
			revoked_at: r.revoked_at,
			created_at: r.created_at,
			state,
		};
	});
}

export interface IssueHubTokenSpec {
	actor: string;
	team?: string | null;
	token_class: TokenClass;
	scopes: string[];
	label?: string | null;
	/** ms; null/0 = forever */
	accessTtlMs?: number | null;
	refreshTtlMs?: number | null;
}

/** GUI-driven issue: mints via the identity layer (raw pair exists exactly
 *  once, in this response) and lands an admin_audit row — the who/when
 *  trail the console audit section reads back. */
export function issueHubToken(
	idb: IdentityStore,
	gov: GovernorStore,
	spec: IssueHubTokenSpec,
	by: string,
): IssuedPair {
	const pair = issueTokens(idb, {
		actor: spec.actor,
		team: spec.team ?? null,
		token_class: spec.token_class,
		scopes: spec.scopes,
		name: spec.label ?? null,
		accessTtlMs: spec.accessTtlMs ?? null,
		refreshTtlMs: spec.refreshTtlMs ?? null,
		via: "board:/console/hub",
	});
	adminAudit(gov, {
		actor: by,
		action: "hub.token.issue",
		target: `jti=${pair.jti}`,
		detail: `${spec.token_class} token for ${spec.actor}${spec.team ? ` (team ${spec.team})` : ""} — scopes ${spec.scopes.join(",")}${spec.accessTtlMs ? `, ttl ${spec.accessTtlMs}ms` : ", forever"}`,
	});
	return pair;
}

/** GUI-driven revoke: delegates to the identity layer (which already
 *  records auth_events + admin_audit keys.revoke) and adds the explicit
 *  hub-plane audit row. The GUI selects by actor (the listing is masked —
 *  a per-row id would revoke one row of a pair and strand its sibling). */
export function revokeHubToken(
	idb: IdentityStore,
	gov: GovernorStore,
	sel: RevokeSelector,
	by: string,
): { changes: number; selector: RevokeSelector } {
	const out = revoke(idb, sel, "board:/console/hub", by, gov);
	adminAudit(gov, {
		actor: by,
		action: "hub.token.revoke",
		target: `${sel.jti ? `jti=${sel.jti}` : sel.actor ? `actor=${sel.actor}` : `team=${sel.team ?? ""}`}`,
		detail: `${out.changes} token row(s) revoked from /console/hub`,
	});
	return out;
}
