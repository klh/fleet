// src/gov/federation-spokes.ts — W173 spoke enrollment + fleet registry.
// The hub names its fleet: an admin mints a ONE-TIME enrollment code
// (benrl_, hashed at rest like keys, short TTL), the spoke redeems it for a
// hub-issued spoke token (buckle:spoke:READ_+WRITE_, KeyStore issue) and a
// registry row (id, version, policy version applied, last-seen). Every
// authenticated manifest pull is the heartbeat: last_seen + the policy
// version being applied move together on the pull.
import type { Database } from "bun:sqlite";
import { KeyStore } from "./keys.ts";
import { hashKey } from "./keys.ts";

export const ENROLLMENT_DEFAULT_TTL_S = 900;

/** Enrollment-code storage row (code_hash PK — raw material exists once,
 *  in the mint response). */
export interface EnrollCodeRow {
	code_hash: string;
	spoke_id: string;
	created_by: string;
	created_at: number;
	expires_at: number;
	redeemed_at: number | null;
	redeemed_key: string | null;
}

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

/** Mint a one-time enrollment code for `spokeId`: raw material returned
 *  ONCE (never stored), sha-256 at rest, TTL clamped ≥ 0 (0 = already
 *  expired, a deliberate seam). */
export function mintEnrollmentCode(
	db: Database,
	o: { spokeId: string; ttlS: number | null; actor: string },
): { code: string; expiresAt: number } {
	const ttl = Math.max(0, Math.floor(o.ttlS ?? ENROLLMENT_DEFAULT_TTL_S));
	const code = `benrl_${Bun.randomUUIDv7().replaceAll("-", "")}`;
	const now = Date.now();
	const expiresAt = now + ttl * 1000;
	db.query(
		"INSERT OR REPLACE INTO federation_enrollment_codes (code_hash, spoke_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
	).run(hashKey(code), o.spokeId, o.actor, now, expiresAt);
	return { code, expiresAt };
}

/** Redeem: hash lookup → expiry → one-time → mint the spoke token (spoke
 *  READ_+WRITE_ scopes) → bind the registry row. The code is the credential
 *  on this route; the issued key is the ONLY spoke capability minted here
 *  (scopes are hub-fixed, never caller-proposed). */
export function redeemEnrollmentCode(
	db: Database,
	o: { code: string; actor?: string },
): RedeemResult {
	const row = db
		.query("SELECT * FROM federation_enrollment_codes WHERE code_hash = ?")
		.get(hashKey(o.code)) as EnrollCodeRow | null;
	if (row === null)
		return {
			ok: false,
			code: "buckle.enroll_unknown",
			why: "unknown enrollment code",
		};
	if (row.expires_at <= Date.now())
		return {
			ok: false,
			code: "buckle.enroll_expired",
			why: `enrollment code for '${row.spoke_id}' expired`,
		};
	if (row.redeemed_at !== null)
		return {
			ok: false,
			code: "buckle.enroll_used",
			why: `enrollment code for '${row.spoke_id}' already redeemed`,
		};
	const keys = new KeyStore(db);
	const issued = keys.issue({
		name: `spoke:${row.spoke_id}`,
		scopes: ["buckle:spoke:READ_", "buckle:spoke:WRITE_"],
		team: null,
		rpmLimit: null,
		tpmLimit: null,
		expiresInS: null,
		actor: o.actor ?? "enrollment",
	});
	keys.recordAuthEvent(
		`spoke:${row.spoke_id}`,
		"issued",
		issued.row.jti,
		"api_key",
	);
	const now = Date.now();
	db.query(
		"UPDATE federation_enrollment_codes SET redeemed_at = ?, redeemed_key = ? WHERE code_hash = ?",
	).run(now, issued.keyId, row.code_hash);
	db.query(
		"INSERT INTO federation_spokes (spoke_id, key_id, enrolled_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(spoke_id) DO UPDATE SET key_id = excluded.key_id, enrolled_at = excluded.enrolled_at",
	).run(row.spoke_id, issued.keyId, now, now);
	return {
		ok: true,
		spokeId: row.spoke_id,
		keyId: issued.keyId,
		key: issued.key,
		expiresAt: issued.row.expires_at,
	};
}

/** The heartbeat seam: every authenticated manifest pull touches the fleet
 *  registry — last_seen moves, the spoke may report its own `version`, and
 *  policy_version = the manifest version just served (pull == apply). A pull
 *  from a key with no enrolled row self-registers under the key id, so the
 *  inventory shows every authentic spoke even before enrollment. */
export function touchSpoke(
	db: Database,
	o: { keyId: string; version: string | null; policyVersion: string | null },
): void {
	const enrolled = db
		.query("SELECT spoke_id FROM federation_spokes WHERE key_id = ?")
		.get(o.keyId) as { spoke_id: string } | null;
	const spokeId = enrolled?.spoke_id ?? o.keyId;
	db.query(
		"INSERT INTO federation_spokes (spoke_id, key_id, version, policy_version, enrolled_at, last_seen) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(spoke_id) DO UPDATE SET version = COALESCE(excluded.version, version), policy_version = COALESCE(excluded.policy_version, policy_version), last_seen = excluded.last_seen",
	).run(spokeId, o.keyId, o.version, o.policyVersion, Date.now());
}

/** The fleet inventory: every registered spoke, oldest enrollment first. */
export function listSpokes(db: Database): SpokeRow[] {
	return db
		.query("SELECT * FROM federation_spokes ORDER BY enrolled_at, spoke_id")
		.all() as SpokeRow[];
}
