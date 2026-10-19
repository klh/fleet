// hooks/board/iam-seam.ts — W844: the board-side IAM seam. The public board
// carries the CONTRACT only; the private overlay (klh-remote) provides the
// browser-SSO gate (OIDC authorization-code + PKCE, server-side sessions,
// per-request RBAC) and registers it at board boot. Gate-less = Core SKU:
// the board answers exactly as before (host-guard perimeter only). Mirror of
// ent-seam.ts; pattern: buckle src/gov/hub-seam.ts.
import type { Database } from "bun:sqlite";

/** The authenticated console principal — what every request is allowed to
 *  act as. `roles` are resolved SERVER-SIDE per request (role removal takes
 *  effect on the next request, never a stale session claim). */
export interface IamPrincipal {
	id: string;
	label: string;
	tenant: string;
	kind: "user" | "service";
	roles: string[];
	/** Audited break-glass session — full access, loudly marked. */
	breakglass: boolean;
}

/** Fixed-shape denial the gate returns for unauthenticated requests: a 302
 *  to the login route for browser navigations, a 401 JSON for API clients. */
export type IamAuthnResult =
	| { ok: true; principal: IamPrincipal }
	| { ok: false; response: Response };

/** Server-side authorization verdict (RBAC) for an authenticated request. */
export type IamAuthzResult =
	| { ok: true }
	| { ok: false; status: number; code: string; why: string };

/** The gate contract. `route()` owns the gate's public endpoints (login,
 *  callback, logout); `authn()` resolves the session cookie; `authorize()`
 *  is the per-request RBAC decision. All server-side. */
export interface IamGate {
	route(req: Request, url: URL): Promise<Response | null>;
	authn(req: Request, url: URL): Promise<IamAuthnResult>;
	authorize(p: IamPrincipal, req: Request, url: URL): IamAuthzResult;
}

/** Factory over the governor db — the overlay registers via the module it
 *  passes through KLH_OVERLAY_MODULE (optional `iamGate` export). */
export type IamGateFactory = (db: Database) => IamGate;

/** The gate's public prefix — endpoints under it are reachable
 *  unauthenticated (the gate still routes them). */
export const IAM_PUBLIC_PREFIX = "/iam/";

export const isIamPublicPath = (pathname: string): boolean =>
	pathname === "/iam" || pathname.startsWith(IAM_PUBLIC_PREFIX);

/** Build the fixed-shape unauthenticated denial: browsers navigating get a
 *  302 to the gate's login route; API clients get a 401 JSON. */
export function iamChallenge(req: Request, loginPath: string): Response {
	if ((req.headers.get("accept") ?? "").includes("text/html")) {
		return new Response(null, {
			status: 302,
			headers: { location: loginPath },
		});
	}
	return Response.json(
		{
			ok: false,
			code: "board.iam_unauthenticated",
			why: "browser SSO required — log in at the console",
		},
		{ status: 401, headers: { "www-authenticate": "openid-connect" } },
	);
}

/** Fixed-shape RBAC denial. */
export function iamForbidden(code: string, why: string): Response {
	return Response.json({ ok: false, code, why }, { status: 403 });
}

// ─── the gate slot ─────────────────────────────────────────────────────────

let slot: IamGate | null = null;

/** Register (or clear, null) the overlay's gate — the overlay owns exactly
 *  one; tests clear it to keep the slot process-local clean. */
export function setIamGate(g: IamGate | null): void {
	slot = g;
}

/** The registered gate, or null = Core SKU (perimeter unchanged). */
export function getIamGate(): IamGate | null {
	return slot;
}
