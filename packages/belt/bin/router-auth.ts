// router-auth.ts — W1117.5: the /v1/messages ingress credential gate
// (owner law 2026-10-21, event #55681: first ingress via authenticated
// Buckle — the hop header alone is not auth, and a direct unauthenticated
// caller never reaches the ladder or mints a contract). The shared peer
// secret is machine config: buckle's belt deployment row presents it via
// api_key_env (adapters/types.ts bearerHeaders forwards `Bearer <value>`),
// belt verifies the same value from BELT_UPSTREAM_KEY. Fail-closed: the key
// unset answers 503 unconfigured — there is no open mode. Local-only
// convenience callers ride the Buckle spoke instead (that IS the law).
import { createHash, timingSafeEqual } from "node:crypto";

export type UpstreamAuth =
	| { verdict: "ok" }
	| { verdict: "unconfigured" }
	| { verdict: "denied" };

const configuredKey = (): string =>
	process.env.BELT_UPSTREAM_KEY?.trim() ?? "";

/** Constant-time compare of the presented credential against the configured
 *  peer secret — digests first so unequal lengths never leak via timing. */
const matches = (presented: string, configured: string): boolean => {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(configured).digest();
	return timingSafeEqual(a, b);
};

/** Bearer first, then the Anthropic-wire x-api-key — the same presentation
 *  order buckle's own tokenFromHeaders accepts from ITS callers. */
const presentedCredential = (req: Request): string | null => {
	const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
	if (m) return m[1]?.trim() ?? "";
	const apiKey = req.headers.get("x-api-key");
	return apiKey === null ? null : apiKey.trim();
};

export function verifyUpstreamAuth(req: Request): UpstreamAuth {
	const configured = configuredKey();
	if (!configured) return { verdict: "unconfigured" };
	const presented = presentedCredential(req);
	if (!presented || !matches(presented, configured))
		return { verdict: "denied" };
	return { verdict: "ok" };
}
