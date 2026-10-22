// scripts/lib/belt-upstream-key.ts — W1124.2: the authenticated
// Buckle→Belt peer secret, installer face. Mints ONE machine-level
// 0600 BELT_UPSTREAM_KEY in belt.env (the env file BOTH the belt-swarm
// router and the buckle spoke source via `set -ae`), names that var in
// the Buckle Belt-row (machine BUCKLE_UPSTREAMS override) via
// api_key_env, and exports BUCKLE_UPSTREAMS so the spoke actually loads
// the override. Idempotent (an existing nonempty key is kept), fail
// forward (a step failure fails the install — no open-mode fallback),
// and never logs the value (fingerprint = sha256 prefix only).
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export const BELT_UPSTREAM_KEY_VAR = "BELT_UPSTREAM_KEY";
export const BELT_GROUP_NAME = "belt";
export const BELT_ROW_URL = "http://127.0.0.1:4000";
export const BUCKLE_OVERRIDE_VAR = "BUCKLE_UPSTREAMS";

export type EnsureStatus = "kept" | "wired" | "minted";

export interface EnsureResult {
	status: EnsureStatus | "failed";
	note: string;
	/** sha256(value) prefix — correlation without disclosure. */
	fingerprint?: string;
}

const fingerprint = (value: string): string =>
	createHash("sha256").update(value).digest("hex").slice(0, 12);

const is0600 = (path: string): boolean => {
	try {
		return (statSync(path).mode & 0o777) === 0o600;
	} catch {
		return false;
	}
};

/** Lines assigning exactly `name=` (export prefix allowed). */
const assignments = (body: string, name: string): string[] =>
	body
		.split(/\r?\n/)
		.filter((l) => new RegExp(`^\\s*(?:export\\s+)?${name}=`).test(l));

/** Read a single-valued env var from belt.env; undefined = absent or
 *  ambiguous (two assignments = fail closed, never guess). */
export const readBeltEnvVar = (
	path: string,
	name: string,
): string | undefined => {
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const hits = assignments(body, name);
	if (hits.length !== 1) return undefined;
	return hits[0]?.slice(hits[0].indexOf("=") + 1);
};

type KeyAction =
	| { action: "kept"; value: string }
	| { action: "minted"; value: string; line?: string }
	| { action: "failed"; reason: string };

/** Pure mint decision for a belt.env body — kept / minted / failed.
 *  `line` carries the assignment being replaced (empty-value backfill). */
const beltKeyAction = (body: string, mint: () => string): KeyAction => {
	const hits = assignments(body, BELT_UPSTREAM_KEY_VAR);
	if (hits.length > 1)
		return {
			action: "failed",
			reason: `${BELT_UPSTREAM_KEY_VAR} assigned more than once in belt.env — fix the file, mint refused`,
		};
	const existing = hits[0];
	const value = existing?.slice(existing.indexOf("=") + 1);
	if (existing !== undefined && value !== "") return { action: "kept", value };
	const fresh = mint();
	if (!/^[0-9a-f]{48}$/.test(fresh))
		return {
			action: "failed",
			reason: "minted key failed the 48-hex shape check — refusing to write",
		};
	return { action: "minted", value: fresh, line: existing };
};

/** Mint/keep the peer key in belt.env (0600, idempotent, fail closed).
 *  The value never appears in the result — the fingerprint does. */
export function ensureBeltUpstreamKey(
	beltEnvPath: string,
	opts: { mint?: () => string } = {},
): EnsureResult {
	let body: string;
	try {
		body = readFileSync(beltEnvPath, "utf8");
	} catch {
		return {
			status: "failed",
			note: `${beltEnvPath} is missing or unreadable — peer key mint refused`,
		};
	}
	const mint = opts.mint ?? ((): string => randomBytes(24).toString("hex"));
	const decided = beltKeyAction(body, mint);
	if (decided.action === "failed")
		return { status: "failed", note: decided.reason };
	if (decided.action === "kept")
		return {
			status: "kept",
			note: `${BELT_UPSTREAM_KEY_VAR} kept (${fingerprint(decided.value)})`,
			fingerprint: fingerprint(decided.value),
		};
	const value = decided.value;
	const next =
		decided.line !== undefined
			? body.replace(decided.line, `${BELT_UPSTREAM_KEY_VAR}=${value}`)
			: `${body.replace(/\n*$/, "\n")}${BELT_UPSTREAM_KEY_VAR}=${value}\n`;
	writeFileSync(beltEnvPath, next, { mode: 0o600 });
	if (!is0600(beltEnvPath)) chmodSync(beltEnvPath, 0o600);
	return {
		status: "minted",
		note: `${BELT_UPSTREAM_KEY_VAR} minted (${fingerprint(value)})`,
		fingerprint: fingerprint(value),
	};
}
