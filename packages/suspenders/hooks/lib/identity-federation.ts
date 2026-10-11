// hooks/lib/identity-federation.ts — W262: the authentik-first claims mapper.
// Maps an external IdP token's claims onto the local principal shape
// (actor/team/scopes) so resource servers scope-check federated tokens like
// local ones. Config-only mapping — the mapping rides the issuer entry in the
// auth config; verify time touches only discovery/JWKS, never IdP APIs.
//
// Verdict lineage: W151 picked authentik (docs/research — commit 257b6d6);
// W175 (parked) proved the OIDC login leg. W262 lands the resource-server
// side: claims → principal, group → scope mapping, team from claims.
//
// KEY MATERIAL LAW (inherited): no key material or real host values here —
// the issuer entry is config-over-code; repos carry placeholders only.
export interface ClaimsMapConfig {
	// claim carrying group membership; authentik's default is "groups"
	groups_claim?: string;
	// group name/DN → scopes/roles granted to members. Authentik property
	// mappings can emit scopes directly instead — either shape feeds the same
	// mapper. Absent map = roles-only trust (verifyJwt skips scope checks).
	group_scope_map?: Record<string, string[]>;
	// claim carrying the team id (the W141 budget-ceiling container);
	// absent/missing claim → team null
	team_claim?: string;
}

export interface MappedClaims {
	actor: string;
	team: string | null;
	scopes: string[];
}

const DEFAULT_GROUPS_CLAIM = "groups";

// authentik groups are strings (names or DNs); tolerate a single-string
// claim shape. Unknown groups map to nothing — allow-list mapping.
export function mapIdpClaims(
	cfg: ClaimsMapConfig,
	payload: Record<string, unknown>,
): MappedClaims {
	const gc = cfg.groups_claim ?? DEFAULT_GROUPS_CLAIM;
	const raw = payload[gc];
	const groups = Array.isArray(raw)
		? raw.filter((g): g is string => typeof g === "string")
		: typeof raw === "string"
			? [raw]
			: [];
	const seen = new Set<string>();
	for (const g of groups)
		for (const s of cfg.group_scope_map?.[g] ?? []) seen.add(s);
	const sub = payload.sub;
	const teamClaim = cfg.team_claim ? payload[cfg.team_claim] : undefined;
	return {
		actor: typeof sub === "string" ? sub : "",
		team: typeof teamClaim === "string" ? teamClaim : null,
		scopes: [...seen],
	};
}

// true when the config federates to an external issuer — the W149 delegated
// surface refuses new human tokens under federation (the IdP owns users).
export function hasFederation(cfg: { issuers: { type: string }[] }): boolean {
	return cfg.issuers.some((i) => i.type === "oidc");
}
