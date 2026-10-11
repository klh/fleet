// src/gov/adaptation.ts — W235 adaptation surface v2
// (finding.w233-adaptation-review): FOUR typed hook points —
// authenticate / authorize / audit / budget — not generic middleware: SSO
// IS auth and cannot sit after gates. LAW: hooks may deny / refine /
// attribute — they can never bypass a core floor (scope check, budgets,
// residency, egress). SSO principals get scopes ONLY through the role→scope
// map pinned at registration (validated against ALL_SCOPES, fail-closed) —
// a hook cannot self-grant. Hook registration happens AFTER core auth is
// constructed (strict input validation at the seam, fail-closed at boot).
import { ALL_SCOPES, parseScope } from "./scopes.ts";
import type { Principal } from "./middleware.ts";

/** Wire-format version of the adaptation surface. Fail-closed handshake:
 *  an overlay built for another protocol version refuses to load (see
 *  gov/overlay-loader.ts). */
export const OVERLAY_PROTOCOL_VERSION = 1;

/** The signed-identity claims the SSO path resolves (verified signature —
 *  never an unsigned proxy header — see gov/identity-headers.ts). */
export interface SsoIdentity {
	v: 1;
	/** Stable IdP subject — the attribution id in budget/audit rows. */
	subject: string;
	/** Team the identity bills/audits under. */
	team: string;
	/** IdP-asserted roles; scopes come only from the pinned role map. */
	roles: string[];
	/** Issued-at (epoch seconds) — replay window enforced by the verifier. */
	iat: number;
}

/** A hook denial: the ONLY thing a hook can answer with besides null (no
 *  opinion). status is capped to 401/403/429; code must be buckle-shaped. */
export interface AdaptDeny {
	allow: false;
	status: 401 | 403 | 429;
	code: string;
	why: string;
}

/** authorize hook input — runs AFTER the core scope check passed. */
export interface AuthzInput {
	principal: Principal;
	route: string;
	action: "read" | "write";
	/** The core scope the route demanded (already satisfied). */
	scope: string;
}

/** audit hook input — one row per gate denial (the W136 denied-audits-too
 *  stream). The core row is always written first; the tap only ADDS. */
export interface AuditTapEvent {
	rid: string;
	ts: string;
	actor: string;
	route: string;
	dialect: string;
	code: string;
	status: number;
	why: string;
}

/** budget hook input — admission stage, before the core budget check. */
export interface BudgetInput {
	principal: Principal;
	route: string;
	/** Presented request size (content-length), when declared. */
	reqBytes: number;
}

/** The four typed hook points. Every member optional; absent = solo
 *  behavior. Hooks must be pure admissions — no Response building, no
 *  bypass of the core gate stages. */
export interface AdaptationHooks {
	/** SSO identity resolution: called ONLY when no credential was
	 *  presented (core says buckle.auth_missing) and the hook is
	 *  registered. Returns validated claims, or null (no opinion → the
	 *  core 401 stands). Presented-but-invalid credentials NEVER reach the
	 *  hook (never downgraded — W173 law). The implementation MUST verify
	 *  the signature itself; the gate never trusts unsigned headers. */
	authenticate?: (req: Request) => Promise<SsoIdentity | null> | SsoIdentity | null;
	/** RBAC/entitlement veto after the core scope check. */
	authorize?: (input: AuthzInput) => AdaptDeny | null;
	/** SIEM/export tap on the gate's denial stream. Throws are counted,
	 *  never surfaced to the caller. */
	audit?: (event: AuditTapEvent) => void;
	/** Billing/quota admission tap; may deny 429 or refine (null = pass). */
	budget?: (input: BudgetInput) => AdaptDeny | null;
}

/** Role→scope map pinned at registration: role → scopes (each validated
 *  against ALL_SCOPES). The SSO path maps roles through THIS table only. */
export type SsoRoleMap = Record<string, string[]>;

/** Registered adaptation surface: validated hooks + the pinned role map. */
export interface AdaptationConfig {
	hooks: AdaptationHooks;
	ssoRoles: SsoRoleMap;
}

const DENY_STATUS = new Set([401, 403, 429]);
const DENY_CODE_RE = /^buckle\.[a-z_]+$/;

/** Validate a hook denial verdict: null passes (no opinion); anything else
 *  must be a well-formed AdaptDeny or the verdict is discarded (fail
 *  closed — a malformed verdict never opens the gate). */
export function validDeny(v: unknown): AdaptDeny | null {
	if (v === null || v === undefined) return null;
	if (typeof v !== "object" || v === null) return null;
	const d = v as Record<string, unknown>;
	if (d["allow"] !== false) return null;
	if (typeof d["status"] !== "number" || !DENY_STATUS.has(d["status"]))
		return null;
	if (typeof d["code"] !== "string" || !DENY_CODE_RE.test(d["code"]))
		return null;
	if (typeof d["why"] !== "string" || d["why"].length === 0) return null;
	return {
		allow: false,
		status: d["status"] as 401 | 403 | 429,
		code: d["code"],
		why: d["why"].slice(0, 500),
	};
}

/** Strict registration-time validation (fail-closed at boot): hooks must be
 *  functions where present; the role map's scopes must all parse. Throws —
 *  a malformed surface refuses to register, it does not degrade to solo. */
export function validateAdaptation(raw: AdaptationConfig): AdaptationConfig {
	if (typeof raw !== "object" || raw === null)
		throw new Error("adaptation: config must be an object");
	const hooks = (raw as { hooks?: unknown }).hooks;
	if (typeof hooks !== "object" || hooks === null)
		throw new Error("adaptation: hooks must be an object");
	const h = hooks as Record<string, unknown>;
	for (const name of ["authenticate", "authorize", "audit", "budget"] as const) {
		const f = h[name];
		if (f !== undefined && typeof f !== "function")
			throw new Error(`adaptation: hook ${name} must be a function`);
	}
	const roles = (raw as { ssoRoles?: unknown }).ssoRoles;
	if (roles !== undefined && (typeof roles !== "object" || roles === null))
		throw new Error("adaptation: ssoRoles must be an object");
	const roleMap = (roles ?? {}) as Record<string, unknown>;
	for (const [role, scopes] of Object.entries(roleMap)) {
		if (typeof role !== "string" || role.length === 0)
			throw new Error("adaptation: ssoRoles keys must be non-empty");
		if (!Array.isArray(scopes))
			throw new Error(`adaptation: ssoRoles[${role}] must be a scope array`);
		for (const s of scopes) {
			if (typeof s !== "string" || parseScope(s) === null)
				throw new Error(
					`adaptation: ssoRoles[${role}] holds non-scope "${String(s)}"`,
				);
			if (!ALL_SCOPES.includes(s))
				throw new Error(
					`adaptation: ssoRoles[${role}] scope ${s} outside ALL_SCOPES`,
				);
		}
	}
	return { hooks: hooks as AdaptationHooks, ssoRoles: roleMap as SsoRoleMap };
}

/** Shape-check a hook-returned identity (strict, fail-closed): a malformed
 *  identity is treated as "no opinion" — the core 401 stands. */
export function validSsoIdentity(v: unknown): SsoIdentity | null {
	if (typeof v !== "object" || v === null) return null;
	const i = v as Record<string, unknown>;
	if (i["v"] !== 1) return null;
	for (const k of ["subject", "team"] as const) {
		const s = i[k];
		if (typeof s !== "string" || s.length === 0 || s.length > 200)
			return null;
	}
	if (
		!Array.isArray(i["roles"]) ||
		i["roles"].some((r) => typeof r !== "string")
	)
		return null;
	if (typeof i["iat"] !== "number" || !Number.isFinite(i["iat"])) return null;
	return {
		v: 1,
		subject: i["subject"] as string,
		team: i["team"] as string,
		roles: i["roles"] as string[],
		iat: i["iat"] as number,
	};
}

/** SSO identity → gate Principal. Scopes = union of the pinned role map
 *  entries for the asserted roles; an unknown role contributes nothing.
 *  keyId = `sso:<subject>` (budget attribution); team rides for ceilings. */
export function principalFromSso(
	id: SsoIdentity,
	roleMap: SsoRoleMap,
): Principal {
	const scopes = new Set<string>();
	for (const role of id.roles) {
		for (const s of roleMap[role] ?? []) scopes.add(s);
	}
	return {
		kind: "sso",
		keyId: `sso:${id.subject}`,
		team: id.team,
		actor: id.subject,
		scopes: [...scopes],
		jti: null,
		rpm: null,
		tpm: null,
	};
}
