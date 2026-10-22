// src/gov/admin.ts — the W141 governance API under /v1/admin/*: key
// issue/list/verify/revoke, teams with budget ceilings, budget window
// readback + flush. Scope enforcement happened at the gate (buckle:admin:
// READ_ for GET, WRITE_ for mutations); raw key material appears exactly
// once — the issue response — and verify answers valid/revoked/expired
// without echoing hashes.
import { beginDrain, drainInfo } from "../drain.ts";
import { allowOf, methodNotAllowed, problem } from "../citizenship.ts";
import { readBoundedJson } from "../ingress-body.ts";
import { readBeltTrace } from "../../../telemetry/src/trace-log.ts";
import { readRemoteTraces } from "../../../telemetry/src/remote-traces.ts";
import type { RequestReadQuery } from "../ledger.ts";
import { exportObservations } from "../observation-export.ts";
import { verifyAuthChain } from "./audit-chain.ts";
import type { Governance, Principal } from "./middleware.ts";
import { parseScope, scopesFromStorage } from "./scopes.ts";

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

/** W1156 POST /v1/admin/drain — the ONE arming surface for a planned
 *  deployment drain: beginDrain fires every in-flight stream's dialect
 *  gateway_restarting terminal immediately and arms the bounded force-exit
 *  backstop. First intent wins: a second signal is refused 409 with the
 *  ACTIVE drain, never a silent overwrite. */
async function drainGateway(req: Request, gov: Governance): Promise<Response> {
	const read = await readBoundedJson(req, gov.ingressBodyTimeoutMs);
	if (!read.ok) return bad(read.status, read.code, read.why);
	const body = read.body as Record<string, unknown> | null;
	const reason = str(body?.reason);
	if (reason === null) return bad(400, "buckle.bad_body", "missing reason");
	const grace = Math.min(Math.max(num(body?.grace_ms) ?? 3000, 0), 60_000);
	const info = beginDrain(reason, grace);
	if (info === null) {
		const active = drainInfo();
		return bad(
			409,
			"buckle.already_draining",
			`drain already active since ${active?.sinceMs} (${active?.reason})`,
			"/v1/admin/drain",
		);
	}
	return ok({
		draining: true,
		reason: info.reason,
		since_ms: info.sinceMs,
		deadline_ms: info.deadlineMs,
	});
}

async function verifyKey(req: Request, gov: Governance): Promise<Response> {
	const read = await readBoundedJson(req, gov.ingressBodyTimeoutMs);
	if (!read.ok) return bad(read.status, read.code, read.why);
	const body = read.body as Record<string, unknown> | null;
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
	// W1156: THE arming surface — explicit deploy intent marks the process
	// positively draining (a bare SIGTERM is never proof, root #57093). The
	// gate already demanded buckle:admin:WRITE_ for this POST.
	if (method === "POST" && path === "/v1/admin/drain") {
		return drainGateway(req, gov);
	}
	// W703: walk the auth_events hash chain; ?head=<hex> pins the tail
	if (method === "GET" && path === "/v1/admin/audit/verify") {
		const head = url.searchParams.get("head") ?? undefined;
		return ok(verifyAuthChain(gov.db, { expectHead: head }));
	}
	if (method === "POST" && path === "/v1/admin/teams") {
		return upsertTeam(req, gov);
	}
	if (method === "GET" && path === "/v1/admin/teams") {
		return ok({ teams: gov.keys.listTeams() });
	}
	// W843 readable per-team report: ceilings + members + minute windows +
	// the lifetime spend book, one object per team (spend null when the
	// team carries no ceiling — the book is capped-team scoped).
	if (method === "GET" && path === "/v1/admin/teams/report") {
		return ok({ teams: teamReport(gov) });
	}
	if (method === "GET" && path === "/v1/admin/budgets") {
		return ok({ windows: gov.budgets.snapshot() });
	}
	if (method === "GET" && path === "/v1/admin/slots") {
		return ok({ held: gov.slots.held(), provider_pools: gov.providerPools() });
	}
	// W824 per-request inspection over the usage ledger: capped, filtered,
	// read-only (gate class enforces buckle:admin:READ_); key NAME/team join
	// from api_keys (key material never leaves the store).
	if (method === "GET" && path === "/v1/admin/requests") {
		return listRequests(gov, url);
	}
	if (method === "GET" && path === "/v1/admin/metrics") {
		return gov.metrics();
	}
	if (method === "GET" && path === "/v1/admin/traces") {
		const traceId = url.searchParams.get("trace_id") ?? "";
		if (!/^[0-9a-f]{32}$/.test(traceId))
			return bad(
				400,
				"buckle.bad_trace_id",
				"trace_id must be 32 lowercase hex characters",
			);
		return ok({
			trace_id: traceId,
			requests: gov.ledger.requestsRead({ trace_id: traceId, limit: 500 }),
			attempts: gov.ledger.traceAttempts(traceId),
			belt: readBeltTrace(
				process.env.BUCKLE_BELT_ROUTING_LOG ??
					`${process.env.HOME ?? ""}/.claude-insights/swarm-routing.log`,
				traceId,
			),
			remote: await readRemoteTraces(
				process.env.BUCKLE_TRACE_PEERS_FILE,
				traceId,
			),
		});
	}
	if (method === "GET" && path === "/v1/admin/observations") {
		const path =
			process.env.BUCKLE_OBSERVATIONS_DB ??
			(process.env.BUCKLE_OBSERVATIONS_PATH
				? `${process.env.BUCKLE_OBSERVATIONS_PATH}.db`
				: null);
		if (!path)
			return bad(
				503,
				"buckle.observations_unavailable",
				"observation projection not configured",
			);
		const rawCursor = url.searchParams.get("cursor") ?? "0";
		const rawLimit = url.searchParams.get("limit") ?? "64";
		if (!/^\d+$/.test(rawCursor) || !/^\d+$/.test(rawLimit))
			return bad(
				400,
				"buckle.bad_query",
				"cursor and limit must be nonnegative integers",
			);
		try {
			return ok(exportObservations(path, Number(rawCursor), Number(rawLimit)));
		} catch {
			return bad(
				503,
				"buckle.observations_unavailable",
				"observation export unavailable",
			);
		}
	}
	// W173 spoke enrollment + fleet registry: the hub names its fleet — mint
	// a one-time enrollment code (admin-only by gate class), read the
	// inventory (id, version, policy version applied, last-seen). W233:
	// both ride the injected SpokeEnrollmentProvider (enterprise overlay);
	// absent in solo posture → honest 501.
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
	const read = await readBoundedJson(req, gov.ingressBodyTimeoutMs);
	if (!read.ok) return bad(read.status, read.code, read.why);
	const body = read.body as Record<string, unknown> | null;
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

/** W173 enrollment-code mint: {spoke_id, ttl_s?} → one-time code. The code
 *  is raw material — exists exactly once, in this response. */
async function mintEnrollCode(
	req: Request,
	p: Principal,
	gov: Governance,
): Promise<Response> {
	const sp = gov.federation?.spokes ?? null;
	if (sp === null)
		return bad(
			501,
			"buckle.no_federation",
			"no enrollment surface on this gate (solo posture)",
		);
	const read = await readBoundedJson(req, gov.ingressBodyTimeoutMs);
	if (!read.ok) return bad(read.status, read.code, read.why);
	const body = read.body as Record<string, unknown> | null;
	const spokeId = str(body.spoke_id);
	if (spokeId === null) return bad(400, "buckle.bad_body", "missing spoke_id");
	const out = sp.mint({
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
	const sp = gov.federation?.spokes ?? null;
	if (sp === null)
		return bad(
			501,
			"buckle.no_federation",
			"no enrollment surface on this gate (solo posture)",
		);
	return ok({ spokes: sp.list() });
}

/** W824 limit param: absent → 50; positive integer → clamp 500; anything
 *  else → null (the caller 400s). */
function parseLimit(raw: string | null): number | null {
	if (raw === null) return 50;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 ? Math.min(n, 500) : null;
}

/** W824 since/until: validate ISO-parseable, write into the read query.
 *  null = ok; a Response = the 400 to return instead. */
function isoWindow(sp: URLSearchParams, q: RequestReadQuery): Response | null {
	for (const name of ["since", "until"] as const) {
		const raw = sp.get(name);
		if (raw === null || raw.length === 0) continue;
		if (Number.isNaN(Date.parse(raw)))
			return bad(400, "buckle.bad_window", `${name} must be an ISO timestamp`);
		q[name] = raw;
	}
	return null;
}

/** W824 GET /v1/admin/requests — per-request inspection rows (newest
 *  first): ts, key name/team join (NEVER key material), model, upstream
 *  chosen + ladder walk, status, tokens, latency, cache telemetry.
 *  Filters: limit (default 50, max 500), since/until (ISO), key, lane,
 *  model, errors=true, inference=true (model-selected requests only). */
function listRequests(gov: Governance, url: URL): Response {
	const sp = url.searchParams;
	const limit = parseLimit(sp.get("limit"));
	if (limit === null)
		return bad(400, "buckle.bad_limit", "limit must be a positive integer");
	const q: RequestReadQuery = { limit };
	const w = isoWindow(sp, q);
	if (w !== null) return w;
	if (sp.get("key")) q.key = sp.get("key");
	if (sp.get("lane")) q.lane = sp.get("lane");
	if (sp.has("trace_id")) {
		const traceId = sp.get("trace_id") ?? "";
		if (!/^[0-9a-f]{32}$/.test(traceId))
			return bad(
				400,
				"buckle.bad_trace_id",
				"trace_id must be 32 lowercase hex characters",
			);
		q.trace_id = traceId;
	}
	if (sp.get("model")) q.model = sp.get("model");
	q.errors = sp.get("errors") === "true";
	q.inference = sp.get("inference") === "true";
	const rows = gov.ledger.requestsRead(q);
	const byId = new Map(gov.keys.listKeys().map((k) => [k.key_id, k]));
	return ok({
		requests: rows.map((r) => {
			const k = byId.get(r.actor);
			return { ...r, key_name: k?.name ?? null, key_team: k?.team ?? null };
		}),
	});
}

async function upsertTeam(req: Request, gov: Governance): Promise<Response> {
	const read = await readBoundedJson(req, gov.ingressBodyTimeoutMs);
	if (!read.ok) return bad(read.status, read.code, read.why);
	const body = read.body as Record<string, unknown> | null;
	const teamId = str(body.team_id);
	if (teamId === null) return bad(400, "buckle.bad_body", "missing team_id");
	gov.keys.upsertTeam({
		teamId,
		name: str(body.name) ?? teamId,
		department: str(body.department),
		rpmCeiling: num(body.rpm_ceiling),
		tpmCeiling: num(body.tpm_ceiling),
		spendCeiling: num(body.spend_ceiling),
	});
	return ok({
		team_id: teamId,
		rpm_ceiling: num(body.rpm_ceiling),
		tpm_ceiling: num(body.tpm_ceiling),
		spend_ceiling: num(body.spend_ceiling),
	});
}

/** W843 the per-team report: one readable object per team joining the
 *  teams row, live key count, the minute-window aggregates and the
 *  lifetime spend book (`team:<id>` subject). */
function teamReport(gov: Governance): Array<Record<string, unknown>> {
	const rows = new Map<string, Record<string, unknown>>();
	for (const t of gov.keys.listTeams())
		rows.set(String(t.team_id), {
			...t,
			members: 0,
			windows: [] as Array<Record<string, unknown>>,
			spend_used_tok: null as number | null,
		});
	joinMembers(gov, rows);
	joinWindows(gov, rows);
	joinSpend(gov, rows);
	return [...rows.values()];
}

/** Members: non-revoked keys per team (join on api_keys.team). */
function joinMembers(
	gov: Governance,
	rows: Map<string, Record<string, unknown>>,
): void {
	for (const k of gov.keys.listKeys()) {
		if (k.team === null || k.revoked_at !== null) continue;
		const r = rows.get(k.team);
		if (r) r.members = (Number(r.members) || 0) + 1;
	}
}

/** Minute windows: the durable team_budget_state rows, newest last. */
function joinWindows(
	gov: Governance,
	rows: Map<string, Record<string, unknown>>,
): void {
	for (const w of gov.budgets.snapshotTeams()) {
		const r = rows.get(w.teamId);
		if (!r) continue;
		(r.windows as Array<Record<string, unknown>>).push({
			window: w.window,
			used_rpm: w.reqs,
			used_tpm: w.tks,
		});
	}
}

/** The lifetime spend book (`team:<id>` subjects only); null when the
 *  team carries no spend ceiling — the book is capped-team scoped. */
function joinSpend(
	gov: Governance,
	rows: Map<string, Record<string, unknown>>,
): void {
	for (const s of gov.budgets.snapshotSpends()) {
		if (!s.subject.startsWith("team:")) continue;
		const r = rows.get(s.subject.slice("team:".length));
		if (r) r.spend_used_tok = s.usedTok;
	}
}
