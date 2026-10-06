// scripts/lib/lane-auth.ts — per-lane buckle keys. The buckle governance gate
// demands bksk_ keys; a lane riding the /w/<sid> front needs its own scoped
// key (buckle:proxy:WRITE_), minted at dispatch time by the admin key that
// lives in belt.env (0600, machine-level .env law). Lane keys are EPHEMERAL
// (W463): minted with a TTL backstop, recorded to a 0600 meta file, and
// revoked + lane files deleted when the lane retires (worktree.ts retire /
// fleet-loop retireMerged). Dispatch is FAIL-CLOSED (W463): a mint failure
// refuses the lane unless the operator passes --allow-ungoverned.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BELT_ENV_PATH =
	process.env.SUSPENDERS_BELT_ENV ??
	join(homedir(), ".claude", "local-llm", "belt.env");

/** The buckle front mint/revoke talk to (same env override lane.ts pins). */
export const BUCKLE_FRONT =
	process.env.SUSPENDERS_BUCKLE_FRONT ?? "http://127.0.0.1:4101";

/** Lane keys are ephemeral: revoke-on-retire is the primary lifecycle; the
 *  TTL is the backstop for lanes that die un-retired. 24h bounds every
 *  legitimate lane run — a lane that outlives it re-dispatches and re-mints. */
export const LANE_KEY_TTL_S = 24 * 60 * 60;

export type MintedLaneKey = { key: string; keyId: string };

/** KEY=VALUE line parser — no eval; quotes are literal (belt.env is ours). */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
		if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2];
	}
	return out;
}

/** The dispatch admin key: process env wins over belt.env; null when absent. */
export function adminKey(
	env: NodeJS.ProcessEnv = process.env,
	path: string = BELT_ENV_PATH,
): string | null {
	const fromFile = existsSync(path)
		? (parseEnvFile(readFileSync(path, "utf8")).BUCKLE_ADMIN_KEY ?? null)
		: null;
	return env.BUCKLE_ADMIN_KEY ?? fromFile;
}

/** Mint a per-lane proxy key (name=sid, scope buckle:proxy:WRITE_, TTL'd).
 *  Returns the raw key PLUS the key_id revocation needs; null when the mint
 *  fails or the answer lacks either field — a key we cannot revoke or audit
 *  is not worth holding. Exposed for tests — the fetch is injected. */
export async function mintLaneKey(
	sid: string,
	admin: string,
	fetchFn: typeof fetch = fetch,
	front: string = BUCKLE_FRONT,
): Promise<MintedLaneKey | null> {
	const r = await fetchFn(`${front}/v1/admin/keys`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${admin}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			name: sid,
			scopes: ["buckle:proxy:WRITE_"],
			expires_in_s: LANE_KEY_TTL_S,
		}),
	});
	const data = (await r.json().catch(() => null)) as {
		key?: string;
		apiKey?: string;
		key_id?: string;
	} | null;
	const k = data?.key ?? data?.apiKey;
	if (typeof k !== "string" || !k.startsWith("bksk_")) return null;
	if (typeof data?.key_id !== "string" || data.key_id.length === 0) return null;
	return { key: k, keyId: data.key_id };
}

/** Revoke one lane key by id (buckle admin API). True when the front answers
 *  ok; false on any rejection — the caller decides how loud that is. */
export async function revokeLaneKey(
	keyId: string,
	admin: string,
	fetchFn: typeof fetch = fetch,
	front: string = BUCKLE_FRONT,
): Promise<boolean> {
	const r = await fetchFn(`${front}/v1/admin/keys/${keyId}/revoke`, {
		method: "POST",
		headers: { authorization: `Bearer ${admin}` },
	});
	return r.ok;
}

export const laneKeyMetaPath = (fleet: string, sid: string): string =>
	`${fleet}/lane-key-${sid}.json`;
export const laneSettingsPath = (fleet: string, sid: string): string =>
	`${fleet}/lane-settings-${sid}.json`;

export type LaneKeyRetirement = {
	sid: string;
	/** The minted key id from the lane's meta file — null when the lane never
	 *  minted (or predates W463). Kept in the outcome so the retire log/event
	 *  can carry it for audit after the local files are gone. */
	keyId: string | null;
	revoked: boolean;
	removed: string[];
};

/** Terminal lane state (W463): revoke the lane's buckle key and delete its
 *  per-lane files (0600 key meta + the --settings file that carries the lane
 *  token). Called from the EXISTING retire hooks — worktree.ts retire (the
 *  `work done` path) and fleet-loop retireMerged — never a new daemon. Local
 *  files go even when the revoke call fails: the 24h TTL bounds an un-revoked
 *  key, and the returned keyId keeps the audit trail. */
export async function retireLaneKey(o: {
	fleet: string;
	sid: string;
	/** Defaults to the belt.env/env admin; explicit null skips the revoke. */
	admin?: string | null;
	fetchFn?: typeof fetch;
	front?: string;
}): Promise<LaneKeyRetirement> {
	const out: LaneKeyRetirement = {
		sid: o.sid,
		keyId: null,
		revoked: false,
		removed: [],
	};
	try {
		const meta = JSON.parse(
			readFileSync(laneKeyMetaPath(o.fleet, o.sid), "utf8"),
		) as { key_id?: string };
		if (typeof meta?.key_id === "string") out.keyId = meta.key_id;
	} catch {
		// no meta — the lane never minted (or predates W463); still cleans files
	}
	const admin = o.admin !== undefined ? o.admin : adminKey();
	if (out.keyId !== null && admin) {
		try {
			out.revoked = await revokeLaneKey(
				out.keyId,
				admin,
				o.fetchFn ?? fetch,
				o.front ?? BUCKLE_FRONT,
			);
		} catch {
			out.revoked = false;
		}
	}
	for (const f of [
		laneKeyMetaPath(o.fleet, o.sid),
		laneSettingsPath(o.fleet, o.sid),
	]) {
		try {
			unlinkSync(f);
			out.removed.push(f);
		} catch {
			// absent — nothing to clean
		}
	}
	return out;
}

/** Resolve a lane's buckle key: null when no admin key is configured or the
 *  mint fails — the caller (dispatch-next) then decides fail-closed vs the
 *  explicit --allow-ungoverned override. */
export async function ensureLaneKey(
	sid: string,
	front?: string,
): Promise<MintedLaneKey | null> {
	const admin = adminKey();
	if (!admin) return null;
	return mintLaneKey(sid, admin, fetch, front);
}
