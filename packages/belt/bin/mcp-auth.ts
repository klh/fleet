// mcp-auth.ts — W260: Entra ID bearer-token validation for the belt MCP
// server. Copilot Studio's MCP Toolkit presents an Entra access token as
// `Authorization: Bearer <jwt>`; this module verifies it against the tenant's
// published JWKS (RS256 via WebCrypto) and checks iss/aud/exp/nbf + optional
// scope. Keys are cached per JWKS URI (1h TTL, refreshed on unknown kid —
// Entra rotates). Config is env-only (config-over-code): BELT_MCP_TENANT,
// BELT_MCP_AUDIENCE, BELT_MCP_REQUIRED_SCOPE, BELT_MCP_AUTHORITY; the
// placeholders live in machine-level config, never in this repo.
const JWKS_TTL_MS = 3_600_000;
const CLOCK_LEEWAY_S = 60;

export interface McpAuthConfig {
	tenant: string;
	audience: string;
	requiredScope: string | null;
	issuer: string;
	jwksUri: string;
}

export interface TokenVerdict {
	ok: boolean;
	reason?: string;
	claims?: Record<string, unknown>;
}

export function loadMcpAuthConfig(
	env: Record<string, string | undefined> = process.env,
): McpAuthConfig | null {
	const tenant = env.BELT_MCP_TENANT;
	const audience = env.BELT_MCP_AUDIENCE;
	if (!tenant || !audience) return null;
	const authority = env.BELT_MCP_AUTHORITY ?? "login.microsoftonline.com";
	return {
		tenant,
		audience,
		requiredScope: env.BELT_MCP_REQUIRED_SCOPE ?? null,
		issuer: `https://${authority}/${tenant}/v2.0`,
		jwksUri:
			env.BELT_MCP_JWKS_URI ??
			`https://${authority}/${tenant}/discovery/v2.0/keys`,
	};
}

const b64urlDecode = (s: string): Uint8Array => {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + pad;
	const buf = atob(b64);
	const out = new Uint8Array(buf.length);
	for (let i = 0; i < buf.length; i++) out[i] = buf.charCodeAt(i);
	return out;
};

const decodeSegment = (seg: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(new TextDecoder().decode(b64urlDecode(seg)));
	} catch {
		return null;
	}
};

interface Jwk {
	kid?: string;
	kty?: string;
	n?: string;
	e?: string;
	alg?: string;
	use?: string;
}

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

async function fetchJwks(uri: string, force = false): Promise<Jwk[]> {
	const cached = jwksCache.get(uri);
	if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS)
		return cached.keys;
	const res = await fetch(uri, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`jwks fetch ${res.status}`);
	const body = (await res.json()) as { keys?: Jwk[] };
	const keys = body.keys ?? [];
	jwksCache.set(uri, { keys, fetchedAt: Date.now() });
	return keys;
}

async function verifySignature(
	signedPart: string,
	sig: Uint8Array,
	jwk: Jwk,
): Promise<boolean> {
	if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return false;
	const key = await crypto.subtle.importKey(
		"jwk",
		{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" },
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		sig as BufferSource,
		new TextEncoder().encode(signedPart) as BufferSource,
	);
}

const tenantMatches = (iss: string, tenant: string): boolean =>
	iss === `https://login.microsoftonline.com/${tenant}/v2.0` ||
	iss === `https://sts.windows.net/${tenant}/`;

const hasRequiredScope = (claims: Record<string, unknown>, scope: string) => {
	const scp = claims.scp;
	if (typeof scp === "string") return scp.split(" ").includes(scope);
	const roles = claims.roles;
	if (Array.isArray(roles)) return roles.includes(scope);
	return false;
};

// Verify one bearer token. `now` is injectable for tests. Unknown kid forces
// exactly one JWKS refresh (Entra rotation); stale JWKS then fails honestly.
export async function verifyEntraToken(
	token: string,
	cfg: McpAuthConfig,
	now: () => number = Date.now,
): Promise<TokenVerdict> {
	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, reason: "malformed token" };
	const header = decodeSegment(parts[0]);
	const payload = decodeSegment(parts[1]);
	if (!header || !payload) return { ok: false, reason: "undecodable token" };
	if (header.alg !== "RS256") return { ok: false, reason: "alg not RS256" };
	const kid = typeof header.kid === "string" ? header.kid : null;
	if (!kid) return { ok: false, reason: "missing kid" };

	let keys = await fetchJwks(cfg.jwksUri);
	let jwk = keys.find((k) => k.kid === kid);
	if (!jwk) {
		keys = await fetchJwks(cfg.jwksUri, true);
		jwk = keys.find((k) => k.kid === kid);
	}
	if (!jwk) return { ok: false, reason: "unknown kid" };

	const sig = b64urlDecode(parts[2]);
	const good = await verifySignature(`${parts[0]}.${parts[1]}`, sig, jwk);
	if (!good) return { ok: false, reason: "bad signature" };

	if (typeof payload.iss !== "string" || !tenantMatches(payload.iss, cfg.tenant))
		return { ok: false, reason: "issuer mismatch" };
	if (payload.aud !== cfg.audience && !String(payload.aud).includes(cfg.audience))
		return { ok: false, reason: "audience mismatch" };
	const nowS = Math.floor(now() / 1000);
	if (typeof payload.exp !== "number" || payload.exp < nowS - CLOCK_LEEWAY_S)
		return { ok: false, reason: "token expired" };
	if (typeof payload.nbf === "number" && payload.nbf > nowS + CLOCK_LEEWAY_S)
		return { ok: false, reason: "token not yet valid" };
	if (cfg.requiredScope && !hasRequiredScope(payload, cfg.requiredScope))
		return { ok: false, reason: "missing scope" };
	return { ok: true, claims: payload };
}

/** Extract the bearer token from an Authorization header value. */
export const bearerOf = (header: string | null): string | null => {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m ? (m[1] ?? null) : null;
};

// test-only: drop the JWKS cache between suites (exported honestly, guarded
// by name so production code has no reason to call it).
export const _resetJwksCache = (): void => jwksCache.clear();
