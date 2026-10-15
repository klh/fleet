// src/gov/oidc-env.ts — W372 hub auth wiring: the gate's JWT validator built
// from env, so a hub flips to Entra by config alone (stack.yaml auth.oidc →
// hubctl .env → compose → BUCKLE_OIDC_*). Programmatic opts.auth?.jwt wins —
// env is the deployment channel; opts is the embedder/test override. Partial
// env (any OIDC var set without the required trio) throws: auth config is
// load-bearing, fail closed (the loadAuthConfig precedent).
import type { JwtOpts } from "./jwt.ts";

/** Entra/OIDC gate config from env; null = base posture (no OIDC vars). */
export function oidcGateOptsFromEnv(
	env: Record<string, string | undefined> = process.env,
): JwtOpts | null {
	// empty string counts as unset (the W147 empty-env lesson)
	const v = (k: string): string | undefined => env[k]?.trim() || undefined;
	const issuer = v("BUCKLE_OIDC_ISSUER");
	const jwksUri = v("BUCKLE_OIDC_JWKS_URI");
	const audience = v("BUCKLE_OIDC_AUDIENCE");
	if (!issuer && !jwksUri && !audience) return null;
	const missing: string[] = [];
	if (!issuer) missing.push("BUCKLE_OIDC_ISSUER");
	if (!jwksUri) missing.push("BUCKLE_OIDC_JWKS_URI");
	if (!audience) missing.push("BUCKLE_OIDC_AUDIENCE");
	if (missing.length > 0)
		throw new Error(
			`OIDC gate env incomplete: ${missing.join(", ")} — set all three in stack.yaml auth.oidc`,
		);
	return {
		issuers: [{ issuer, jwksUri }],
		audience,
		requiredScope: v("BUCKLE_OIDC_REQUIRED_SCOPE"),
	};
}
