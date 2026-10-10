// src/gov/admin.ts — the W141 governance API under /v1/admin/*: key
// issue/list/verify/revoke, teams with budget ceilings, budget window
// readback + flush. Scope enforcement happened at the gate (buckle:admin:
// READ_ for GET, WRITE_ for mutations); raw key material appears exactly
// once — the issue response — and verify answers valid/revoked/expired
// without echoing hashes.
import { allowOf, methodNotAllowed, problem } from "../citizenship.ts";
import type { Database } from "bun:sqlite";
import type { Governance, Principal } from "./middleware.ts";
import { parseScope, scopesFromStorage } from "./scopes.ts";
import { listSpokes, mintEnrollmentCode } from "./federation-spokes.ts";

const JSON_HEADERS = { "content-type": "application/json" };

function ok(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function bad(
	status: number,
	code: string,
	why: string,
	path?: string,
): Response {
	return problem({
		status,
		code,
		why: `belt: ${code} — ${why}`,
		instance: path,
	});
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function scopeFilter(scopes: string[]): {
	scopes: string[];
	dropped: string[];
} {
	const valid: string[] = [];
	const dropped: string[] = [];
	for (const s of scopes) {
		const v = parseScope(s);
		if (v === null) dropped.push(s);
		else valid.push(v);
	}
	return { scopes: valid, dropped };
}

async function verifyKey(req: Request, gov: Governance): Promise<Response> {
	const body = (await req.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
	const key = str(body.key);
	if (key === null) return bad(400, "buckle.bad_body", "missing key");
	const v = gov.keys.verify(key);
	if (!v.ok) return ok({ valid: false, code: v.code });
	return ok({
		valid: true,
		key_id: v.key.key_id,
		team: v.key.team,
		scopes: scopesFromStorage(v.key.scopes).scopes,
		revoked: false,
	});
}

export async function handleAdmin(
	req: Request,
	p: Principal,
	gov: Governance,
): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	const method = req.method;
	if (method === "POST" && path === "/v1/admin/keys") {
		return issueKey(req, p, gov);
	}
	if (method === "GET" && path === "/v1/admin/keys") {
		return ok({ keys: gov.keys.listKeys() });
	}
	if (method === "POST" && path === "/v1/admin/keys/verify") {
		return verifyKey(req, gov);
	}
	const revoke = /^\/v1\/admin\/keys\/([0-9a-f]{12})\/revoke$/.exec(path);
	if (method === "POST" && revoke !== null) {
		return revokeKey(req, revoke[1] ?? "", p, gov);
	}
	if (method === "POST" && path === "/v1/admin/teams") {
		return upsertTeam(req, gov);
	}
	if (method === "GET" && path === "/v1/admin/teams") {
		return ok({ teams: gov.keys.listTeams() });
	}
	if (method === "GET" && path === "/v1/admin/budgets") {
		return ok({ windows: gov.budgets.snapshot() });
	}
	if (method === "GET" && path === "/v1/admin/slots") {
		return ok({ held: gov.slots.held() });
	}
	// W173 spoke enrollment + fleet registry: the hub names its fleet — mint
	// a one-time enrollment code (admin-only by gate class), read the
	// inventory (id, version, policy version applied, last-seen).
	if (method === "POST" && path === "/v1/admin/spokes/enroll") {
		return mintEnrollCode(req, p, gov);
	}
	if (method === "GET" && path === "/v1/admin/spokes") {
		return listSpokesRoute(gov);
	}
	// W468: the /v1/admin/budgets/flush endpoint is gone with the W141
	// flush — writes land at the DB authority the moment they are known.
	// known path, wrong method → 405 + Allow (this runs post-auth)
	if (allowOf(path) !== null) return methodNotAllowed(path);
	return bad(404, "buckle.no_route", `no admin route: ${method} ${path}`, path);
}

async function issueKey(
	req: Request,
	p: Principal,
	gov: Governance,
): Promise<Response> {
	const body = (await req.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
	const name = str(body.name);
	if (name === null) return bad(400, "buckle.bad_body", "missing name");
	const scopes = Array.isArray(body.scopes)
		? body.scopes.filter((s): s is string => typeof s === "string")
		: [];
	const { scopes: valid, dropped } = scopeFilter(scopes);
	if (valid.length === 0)
		return bad(
			400,
			"buckle.bad_scopes",
			`no valid buckle: scopes (dropped: ${dropped.join(",") || "none"})`,
		);
	const issued = gov.keys.issue({
		name,
		team: str(body.team),
		scopes: valid,
		rpmLimit: num(body.rpm_limit),
		tpmLimit: num(body.tpm_limit),
		expiresInS: num(body.expires_in_s),
		actor: p.actor ?? p.keyId,
	});
	gov.keys.recordAuthEvent(
		p.actor ?? p.keyId,
		"issued",
		issued.row.jti,
		"api_key",
	);
	return ok(
		{
			key_id: issued.keyId,
			key: issued.key,
			name,
			team: issued.row.team,
			scopes: valid,
			rpm_limit: issued.row.rpm_limit,
			tpm_limit: issued.row.tpm_limit,
			expires_at: issued.row.expires_at,
		},
		201,
	);
}

async function revokeKey(
	_req: Request,
	keyId: string,
	p: Principal,
	gov: Governance,
): Promise<Response> {
	if (!gov.keys.revoke(keyId))
		return bad(404, "buckle.no_route", `no such key: ${keyId}`);
	gov.keys.recordAuthEvent(p.actor ?? keyId, "revoked", null, "api_key");
	return ok({ revoked: keyId });
}

/** W173: the federation surface this deployment must hold for the spoke
 *  routes; honest 501 when a gate runs federation-less. */
function federationDb(gov: Governance): Database | null {
	return gov.federation?.db ?? null;
}

/** W173 enrollment-code mint: {spoke_id, ttl_s?} → one-time code. The code
 *  is raw material — exists exactly once, in this response. */
async function mintEnrollCode(
	req: Request,
	p: Principal,
	gov: Governance,
): Promise<Response> {
	const db = federationDb(gov);
	if (db === null)
		return bad(
			501,
			"buckle.no_federation",
			"no federation surface on this gate",
		);
	const body = (await req.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
	const spokeId = str(body.spoke_id);
	if (spokeId === null) return bad(400, "buckle.bad_body", "missing spoke_id");
	const out = mintEnrollmentCode(db, {
		spokeId,
		ttlS: num(body.ttl_s),
		actor: p.actor ?? p.keyId,
	});
	return ok(
		{ spoke_id: spokeId, code: out.code, expires_at: out.expiresAt },
		201,
	);
}

/** W173 fleet inventory: the registry the hub can finally read. */
function listSpokesRoute(gov: Governance): Response {
	const db = federationDb(gov);
	if (db === null)
		return bad(
			501,
			"buckle.no_federation",
			"no federation surface on this gate",
		);
	return ok({ spokes: listSpokes(db) });
}

async function upsertTeam(req: Request, gov: Governance): Promise<Response> {
	const body = (await req.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
	const teamId = str(body.team_id);
	if (teamId === null) return bad(400, "buckle.bad_body", "missing team_id");
	gov.keys.upsertTeam({
		teamId,
		name: str(body.name) ?? teamId,
		department: str(body.department),
		rpmCeiling: num(body.rpm_ceiling),
		tpmCeiling: num(body.tpm_ceiling),
	});
	return ok({
		team_id: teamId,
		rpm_ceiling: num(body.rpm_ceiling),
		tpm_ceiling: num(body.tpm_ceiling),
	});
}
