// scripts/lib/lane-auth.ts — per-lane buckle keys. The buckle governance gate
// demands bksk_ keys; a lane riding the /w/<sid> front needs its own scoped
// key (buckle:proxy:WRITE_), minted at dispatch time by the admin key that
// lives in belt.env (0600, machine-level .env law). Lane keys are EPHEMERAL
// (W463): minted with a TTL backstop, recorded to a 0600 meta file, and
// revoked + lane files deleted when the lane retires (worktree.ts retire /
// fleet-loop retireMerged). Dispatch is FAIL-CLOSED (W463): a mint failure
// refuses the lane unless the operator passes --allow-ungoverned.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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

// ---- W422.17.1: interactive-session enrollment — the session shape of the
// per-lane key lifecycle. Same mint, same 0600 files, same retire; the
// difference is failure posture: a lane is refused at dispatch, a session
// cannot be, so every buckle miss folds belt-direct with a loud,
// mode-rendered note — the GOVERNANCE line the bootstrap injects.

/** Bootstraps re-fire on resume/clear/compact: a meta younger than TTL
 *  minus this slack reuses the minted key instead of churning a new one
 *  per SessionStart event. */
export const SESSION_KEY_REUSE_SLACK_S = 5 * 60;

export type SessionEnrollment =
	| {
			mode: "enrolled";
			front: string;
			key: string;
			keyId: string;
			note: string;
	  }
	| { mode: "belt-direct"; note: string };

/** One loud belt-direct line — why + mode-rendered governance tail. */
const beltDirectNote = (why: string, govMode: "strict" | "solo"): string =>
	govMode === "solo"
		? `GOVERNANCE: belt-direct — ${why} (governance:solo): session rides belt direct ungoverned`
		: `GOVERNANCE: belt-direct — ${why} (governance:strict): session ungoverned; LANE DISPATCH STILL REFUSES (solo relents: coord governance solo)`;

/** Pure outcome matrix (unit-testable): front probe × mint × admin × mode.
 *  Sessions never refuse — the owner keeps working; belt-direct stays loud. */
export const sessionEnrollDecision = (o: {
	sid: string;
	front: string;
	frontUp: boolean;
	minted: MintedLaneKey | null;
	hasAdmin: boolean;
	govMode: "strict" | "solo";
}): SessionEnrollment => {
	if (o.frontUp && o.minted)
		return {
			mode: "enrolled",
			front: o.front,
			key: o.minted.key,
			keyId: o.minted.keyId,
			note: `GOVERNANCE: enrolled — session rides the buckle front /w/${o.sid.slice(0, 8)} (scoped key, ttl ${LANE_KEY_TTL_S}s)`,
		};
	if (!o.hasAdmin)
		return {
			mode: "belt-direct",
			note: beltDirectNote("no BUCKLE_ADMIN_KEY (belt.env)", o.govMode),
		};
	if (!o.frontUp)
		return {
			mode: "belt-direct",
			note: beltDirectNote("buckle front unreachable", o.govMode),
		};
	return {
		mode: "belt-direct",
		note: beltDirectNote("buckle key mint failed", o.govMode),
	};
};

/** The 0600 enrollment files — same names/lifecycle as lanes, one retire
 *  path (retireLaneKey cleans both): key meta {sid, key_id, mintedAt} plus
 *  the settings env file. Grammar = the lane-settings env WITHOUT model
 *  pins: an interactive session keeps the owner's model choice; only
 *  routing + token enroll. */
export const writeSessionEnrollmentFiles = (
	fleet: string,
	sid: string,
	minted: MintedLaneKey,
	front: string,
): string => {
	const root = `${front}/w/${sid}`;
	mkdirSync(fleet, { recursive: true });
	writeFileSync(
		laneKeyMetaPath(fleet, sid),
		`${JSON.stringify({ sid, key_id: minted.keyId, mintedAt: Date.now() }, null, 2)}\n`,
	);
	chmodSync(laneKeyMetaPath(fleet, sid), 0o600);
	writeFileSync(
		laneSettingsPath(fleet, sid),
		JSON.stringify(
			{
				env: {
					ANTHROPIC_BASE_URL: root,
					OPENAI_BASE_URL: `${root}/v1`,
					OPENAI_API_BASE: `${root}/v1`,
					GOOGLE_GEMINI_BASE_URL: root,
					ANTHROPIC_AUTH_TOKEN: minted.key,
				},
			},
			null,
			2,
		),
	);
	chmodSync(laneSettingsPath(fleet, sid), 0o600);
	return laneSettingsPath(fleet, sid);
};

/** A fresh enrollment (meta inside the reuse window AND its settings token)
 *  — reused instead of a re-mint when bootstrap re-fires on resume/clear/
 *  compact. The 5-min slack keeps the local window strictly inside the
 *  server-side 24h TTL. null = mint fresh. */
export const readSessionEnrollment = (
	fleet: string,
	sid: string,
	now = Date.now(),
): MintedLaneKey | null => {
	try {
		const m = JSON.parse(readFileSync(laneKeyMetaPath(fleet, sid), "utf8")) as {
			sid?: string;
			key_id?: string;
			mintedAt?: number;
		};
		if (
			m?.sid !== sid ||
			typeof m.key_id !== "string" ||
			typeof m.mintedAt !== "number" ||
			now - m.mintedAt > (LANE_KEY_TTL_S - SESSION_KEY_REUSE_SLACK_S) * 1000
		)
			return null;
		const s = JSON.parse(
			readFileSync(laneSettingsPath(fleet, sid), "utf8"),
		) as { env?: { ANTHROPIC_AUTH_TOKEN?: string } };
		const t = s?.env?.ANTHROPIC_AUTH_TOKEN;
		if (typeof t !== "string" || !t.startsWith("bksk_")) return null;
		return { key: t, keyId: m.key_id };
	} catch {
		return null;
	}
};

/** Enroll one interactive session: reuse-or-mint the per-session key and
 *  write the 0600 files on a fresh mint. Probe result comes in; the hook
 *  stays thin and every branch is unit-testable. Reuse never rewrites the
 *  meta — a refreshed mintedAt would extend the local window past the
 *  server-side TTL. */
export const enrollSessionKey = async (o: {
	fleet: string;
	sid: string;
	front: string;
	frontUp: boolean;
	govMode: "strict" | "solo";
	admin?: string | null;
	fetchFn?: typeof fetch;
}): Promise<SessionEnrollment> => {
	const admin = o.admin !== undefined ? o.admin : adminKey();
	if (!o.frontUp || !admin)
		return sessionEnrollDecision({ ...o, minted: null, hasAdmin: !!admin });
	const minted =
		readSessionEnrollment(o.fleet, o.sid) ??
		(await (async () => {
			const m = await mintLaneKey(o.sid, admin, o.fetchFn ?? fetch, o.front);
			if (m) writeSessionEnrollmentFiles(o.fleet, o.sid, m, o.front);
			return m;
		})());
	return sessionEnrollDecision({ ...o, minted, hasAdmin: true });
};
