// auth.ts — W2327: the dataplane's key gate. Bearer bksk_ keys verified at
// the buckle gate's own /v1/admin/keys/verify (the knowledge-face posture,
// W1141): no key / non-bksk_ / invalid = 401; valid key without the
// dataplane scope = 403; a verify leg that cannot answer = 503 (fail
// closed). Every request re-verifies — nothing cached, revocation immediate.
export const DATAPLANE_READ_SCOPE = "buckle:dataplane:READ_";
export const DATAPLANE_WRITE_SCOPE = "buckle:dataplane:WRITE_";

export interface AuthConf {
	/** buckle front base (default the Mac spoke loopback). */
	front: string;
	/** admin-scoped credential for the verify call; null = 503 fail-closed. */
	admin: string | null;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
}

const envStr = (v: string | undefined): string | null => {
	const t = (v ?? "").trim();
	return t.length > 0 ? t : null;
};

/** Boot-time resolution (env-first; machine conf carries real values). */
export function dataplaneAuthConf(
	env: NodeJS.ProcessEnv = process.env,
): AuthConf {
	return {
		front:
			envStr(env.SUSPENDERS_DATAPLANE_VERIFY_URL) ?? "http://127.0.0.1:4101",
		admin:
			envStr(env.SUSPENDERS_DATAPLANE_VERIFY_TOKEN) ??
			envStr(env.BUCKLE_ADMIN_KEY),
		timeoutMs: Number(env.SUSPENDERS_DATAPLANE_VERIFY_TIMEOUT_MS) || 3_000,
	};
}

export type AuthCode =
	| "invalid_argument"
	| "unauthenticated"
	| "permission_denied"
	| "internal";

export interface AuthVerdict {
	ok: boolean;
	/** 401 missing/invalid · 403 wrong scope · 503 backend unreachable */
	status: number;
	code: AuthCode;
	detail: string;
	keyId: string | null;
	scopes: string[];
}

/** Verify the presented key holds `needed` (WRITE_ implies READ_ — the
 *  scopes.ts role law). Fail-closed on any backend non-answer. */
export async function verifyDataplaneKey(
	key: string | null,
	needed: string,
	conf: AuthConf,
): Promise<AuthVerdict> {
	const refused = (
		status: number,
		code: AuthCode,
		detail: string,
	): AuthVerdict => ({
		ok: false,
		status,
		code,
		detail,
		keyId: null,
		scopes: [],
	});
	if (!key?.startsWith("bksk_"))
		return refused(401, "unauthenticated", "Bearer bksk_ key required");
	if (!conf.admin)
		return refused(503, "internal", "dataplane auth backend unconfigured");
	const fetchFn = conf.fetchFn ?? fetch;
	try {
		const r = await fetchFn(`${conf.front}/v1/admin/keys/verify`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${conf.admin}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ key }),
			signal: AbortSignal.timeout(conf.timeoutMs ?? 3_000),
		});
		if (!r.ok)
			return refused(
				503,
				"internal",
				`dataplane auth backend unreachable (${r.status})`,
			);
		const v = (await r.json().catch(() => null)) as {
			valid?: boolean;
			key_id?: string;
			scopes?: string[];
		} | null;
		if (v?.valid !== true)
			return refused(401, "unauthenticated", "invalid bksk_ key");
		const scopes = v.scopes ?? [];
		const implies =
			scopes.includes(needed) ||
			(needed === DATAPLANE_READ_SCOPE &&
				scopes.includes(DATAPLANE_WRITE_SCOPE));
		if (!implies)
			return refused(403, "permission_denied", `key lacks ${needed}`);
		return {
			ok: true,
			status: 200,
			code: "internal",
			detail: "",
			keyId: v.key_id ?? null,
			scopes,
		};
	} catch {
		return refused(503, "internal", "dataplane auth backend unreachable");
	}
}
