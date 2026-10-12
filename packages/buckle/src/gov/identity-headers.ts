// src/gov/identity-headers.ts — W235 signed identity headers
// (finding.w233-adaptation-review §3): SSO happens at the Caddy proxy
// (forward_auth + Entra via the enterprise SSO service); buckle trusts
// only SIGNED identity headers — an unsigned Remote-User is not identity,
// it is a string. The verifier + the reference signer live here; the
// enterprise overlay owns the real SSO service that signs
// after a successful forward_auth. Replay window on the claims' iat;
// constant-time signature compare.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SsoIdentity } from "./adaptation.ts";

/** Header names the signed identity rides on. */
export const IDENTITY_HEADER = "x-klh-identity";
export const IDENTITY_SIG_HEADER = "x-klh-identity-sig";

/** Signature domain-separation prefix. */
const SIG_PREFIX = "buckle-sso-v1:";

/** Replay window: claims older than this (± 30s skew) are stale. */
export const DEFAULT_IDENTITY_MAX_AGE_S = 300;

/** One internal clock-skew allowance (seconds). */
const SKEW_S = 30;

export interface IdentityHeaderOpts {
	/** Shared secret with the signing proxy (base64 or raw). */
	key: string;
	/** Replay window (seconds); default 300. */
	maxAgeS?: number;
}

/** Sign claims into the header pair — the REFERENCE signer (the SSO
 *  service's contract; tests + the enterprise overlay reuse it). */
export function signIdentityHeaders(
	claims: SsoIdentity,
	key: string,
): Record<string, string> {
	const body = Buffer.from(JSON.stringify(claims), "utf8").toString(
		"base64url",
	);
	const sig = createHmac("sha256", key)
		.update(SIG_PREFIX + body)
		.digest("base64url");
	return {
		[IDENTITY_HEADER]: body,
		[IDENTITY_SIG_HEADER]: sig,
	};
}

/** Verify the signed identity headers → claims, or null (any failure).
 *  Laws: both headers present; claims shape-checked; constant-time
 *  signature compare; iat inside the replay window (± skew). */
export function verifyIdentityHeaders(
	headers: Headers,
	opts: IdentityHeaderOpts,
): SsoIdentity | null {
	const body = headers.get(IDENTITY_HEADER);
	const sig = headers.get(IDENTITY_SIG_HEADER);
	if (body === null || sig === null) return null;
	const expected = createHmac("sha256", opts.key)
		.update(SIG_PREFIX + body)
		.digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	let claims: unknown;
	try {
		claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	const id = validClaims(claims);
	if (id === null) return null;
	const nowS = Math.floor(Date.now() / 1000);
	const maxAge = opts.maxAgeS ?? DEFAULT_IDENTITY_MAX_AGE_S;
	if (id.iat > nowS + SKEW_S || id.iat < nowS - maxAge - SKEW_S)
		return null;
	return id;
}

/** Shape-check claims (same law as validSsoIdentity; local shape law —
 *  the shapes must stay identical). */
function validClaims(v: unknown): SsoIdentity | null {
	if (typeof v !== "object" || v === null) return null;
	const c = v as Record<string, unknown>;
	if (c["v"] !== 1) return null;
	for (const k of ["subject", "team"] as const) {
		const s = c[k];
		if (typeof s !== "string" || s.length === 0 || s.length > 200)
			return null;
	}
	if (
		!Array.isArray(c["roles"]) ||
		c["roles"].some((r) => typeof r !== "string")
	)
		return null;
	if (typeof c["iat"] !== "number" || !Number.isFinite(c["iat"]))
		return null;
	return {
		v: 1,
		subject: c["subject"] as string,
		team: c["team"] as string,
		roles: c["roles"] as string[],
		iat: c["iat"] as number,
	};
}

/** The ready-made authenticate hook: signed identity headers →
 *  SsoIdentity (wire into adaptation.hooks.authenticate). */
export function identityHeaderAuthenticator(opts: IdentityHeaderOpts) {
	return (req: Request): SsoIdentity | null =>
		verifyIdentityHeaders(req.headers, opts);
}
