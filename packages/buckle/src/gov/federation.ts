// src/gov/federation.ts — W154 federation phase 1: hub policy distribution +
// spoke pull. W193: NO anonymous pulls — every federation request
// authenticates (GETs demand buckle:spoke:READ_); presented credentials are
// always validated (invalid bearer = 401, never downgraded); POST requires
// buckle:spoke:WRITE_. The manifest is SIGNED (W193): the hub's RS256
// identity signs the exact response bytes (detached JWS in
// x-buckle-manifest-signature); spokes verify via /.well-known/jwks.json —
// authenticity never rests on transport auth. Visibility law: spoke-private
// models never appear —
// structural (hub cannot see them) + defensive `visibility: spoke-private`.
import { Database } from "bun:sqlite";
import type { GatewayPolicy } from "../policy.ts";
import type { UpstreamPool } from "../upstreams.ts";

import { applyGovernanceSchema } from "./schema.ts";
import { authError, type Principal } from "./middleware.ts";
import { hasScope } from "./scopes.ts";
import type {
	CrProbe,
	CrRow,
	FedManifest,
	HubEntitlementsFactory,
	HubEntitlementsProvider,
	ManifestCrFactory,
	ManifestCrProvider,
	RedeemResult,
	SpokeEnrollmentFactory,
	SpokeEnrollmentProvider,
	UsageIngestFactory,
	UsageIngestProvider,
} from "./hub-seam.ts";
import { buildCapabilities } from "./hub-seam.ts";
import type { ManifestSigner } from "./federation-signing.ts";

export interface FederationOpts {
	dbPath: string;
	policy: GatewayPolicy;
	pool: UpstreamPool;
	/** W160: the routing-policy.yaml path — the verification probe re-reads
	 *  this surface from disk before a CR may report `verified`. */
	policyPath?: string;
	/** W193: RS256 manifest-signing identity — JWKS serve + detached-JWS
	 *  signature over the exact manifest bytes (null = serve unsigned). */
	signer?: ManifestSigner;
	/** W233 enterprise-posture seam: the spoke-enrollment + fleet-registry
	 *  provider factory (implementation lives in the private
	 *  enterprise overlay repo). Unset in solo posture — the enrollment
	 *  routes answer honest 501s and the pull heartbeat is a no-op. */
	spokeEnrollment?: SpokeEnrollmentFactory;
	/** W233.2: the usage-ingest seam — same posture law. Unset in solo
	 *  posture: /federation/usage answers honest 501s (no rollup store). */
	usageIngest?: UsageIngestFactory;
	/** W233.1 seam: the hub entitlement-menu provider factory (enterprise
	 *  overlay). Unset in solo posture — the entitlements route answers an
	 *  honest 501. */
	hubEntitlements?: HubEntitlementsFactory;
	/** W233.3: the manifest + CR seam — same posture law. Unset in solo
	 *  posture: the manifest pull + CR routes answer honest 501s. */
	manifestCr?: ManifestCrFactory;
	/** W165: which variant this gateway runs — the manifest advertises it
	 *  (hub = full: identity, issuance, admin; default). */
	profile?: "hub" | "spoke";
}

/** The principal a gate-authenticated request carries (WeakMap stash — no
 *  request mutation, nothing leaks into headers). */
const PRINCIPALS = new WeakMap<Request, Principal>();

export function stashPrincipal(req: Request, p: Principal): void {
	PRINCIPALS.set(req, p);
}

export function principalOf(req: Request): Principal | null {
	return PRINCIPALS.get(req) ?? null;
}

/** Non-auth error envelope (same shape as the admin API's bad()). */
function bad(status: number, code: string, why: string): Response {
	return Response.json(
		{ error: { code, message: `belt: ${code} — ${why}` } },
		{ status },
	);
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

export class Federation {
	readonly db: Database;
	private readonly policy: GatewayPolicy;
	private readonly pool: UpstreamPool;
	/** W165: the hub's own profile — manifest capability flags ride it. */
	readonly profile: "hub" | "spoke";
	/** W193: the hub signing identity (JWKS + manifest signatures). */
	readonly signer: ManifestSigner | null;
	/** W233 seam: spoke enrollment + fleet registry — provider-less in solo
	 *  posture (honest 501s; the pull heartbeat is a no-op). */
	readonly spokes: SpokeEnrollmentProvider | null;
	/** W233.2 seam: the aggregate self-report hub ingest + rollup read —
	 *  provider-less in solo posture (honest 501s, no rollup store). */
	readonly usage: UsageIngestProvider | null;
	/** W233.1 seam: the hub entitlement menu (enterprise overlay) —
	 *  provider-less in solo posture (honest 501). */
	readonly entitlementsMenu: HubEntitlementsProvider | null;
	/** W233.3 seam: the policy manifest + CR queue hub serving —
	 *  provider-less in solo posture (honest 501s). */
	readonly cr: ManifestCrProvider | null;

	constructor(opts: FederationOpts) {
		this.db = new Database(opts.dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		applyGovernanceSchema(this.db);
		this.policy = opts.policy;
		this.pool = opts.pool;
		this.profile = opts.profile ?? "hub";
		this.signer = opts.signer ?? null;
		this.spokes = opts.spokeEnrollment?.(this.db) ?? null;
		this.usage = opts.usageIngest?.(this.db, this.policy) ?? null;
		this.entitlementsMenu =
			opts.hubEntitlements?.(this.pool, this.policy.tags ?? {}) ?? null;
		this.cr = opts.manifestCr?.(this.db, this.policy, opts.policyPath) ?? null;
	}

	/** Register a verification probe — rides the W233.3 seam; no-op in solo
	 *  posture (nothing verifies against a provider-less CR store). */
	registerProbe(prefix: string, probe: CrProbe): void {
		this.cr?.registerProbe(prefix, probe);
	}

	/** Echo-menu entitlements: hub menu only, team ceilings when the pull
	 *  presents a team-carrying principal. W233.1: the menu rides the
	 *  injected HubEntitlementsProvider (enterprise overlay); absent in solo
	 *  posture → honest 501. */
	private entitlementsRoute(p: Principal | null): Response {
		if (this.entitlementsMenu === null)
			return bad(
				501,
				"buckle.no_federation",
				"no entitlements surface on this gate (solo posture)",
			);
		const ceilings = p?.team ? this.teamCeilings(p.team) : null;
		return Response.json({
			models: this.entitlementsMenu.models(),
			ceilings,
		});
	}

	/** W141 team ceilings read through this handle (teams table is in the
	 *  shared governance schema). */
	private teamCeilings(
		teamId: string,
	): { rpm: number | null; tpm: number | null } | null {
		const r = this.db
			.query("SELECT rpm_ceiling, tpm_ceiling FROM teams WHERE team_id = ?")
			.get(teamId) as {
			rpm_ceiling: number | null;
			tpm_ceiling: number | null;
		} | null;
		if (r === null) return null;
		return { rpm: r.rpm_ceiling, tpm: r.tpm_ceiling };
	}

	/** W193: the manifest response — the hub signs the EXACT response bytes
	 *  (detached JWS in x-buckle-manifest-signature). Unsigned only when no
	 *  signing identity is wired (spokes degrade honestly). Accepts a
	 *  precomputed manifest so the W173 heartbeat touches the registry with
	 *  the exact version it serves. */
	private manifestResponse(m: FedManifest): Response {
		const body = JSON.stringify(m);
		const headers: Record<string, string> = {
			"content-type": "application/json; charset=utf-8",
		};
		if (this.signer !== null)
			headers["x-buckle-manifest-signature"] = this.signer.sign(
				new TextEncoder().encode(body),
			);
		return new Response(body, { headers });
	}

	/** W173 heartbeat: the pull IS the heartbeat — registry last_seen moves,
	 *  the spoke may report its version header, policy_version = the exact
	 *  manifest version being served (pull == apply). W233.3: the manifest
	 *  content rides the ManifestCrProvider (honest 501 provider-less —
	 *  solo posture serves no fleet policy). */
	private pullHeartbeat(req: Request, p: Principal | null): Response {
		if (this.cr === null)
			return bad(
				501,
				"buckle.no_federation",
				"no manifest serving surface on this gate (solo posture)",
			);
		const m = {
			...this.cr.manifest(),
			capabilities: buildCapabilities(this.profile),
		};
		if (p !== null)
			this.spokes?.touch({
				keyId: p.keyId,
				version: str(req.headers.get("x-buckle-spoke-version")),
				policyVersion: m.version,
			});
		return this.manifestResponse(m);
	}

	/** Route dispatch. CR delivery confirmation POST carries the spoke's
	 *  principal (gate enforces buckle:spoke:WRITE_; auth-off dev refuses
	 *  honestly when no principal ever got stashed). */
	async handle(req: Request, p: Principal | null): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/federation/policy-manifest")
			return this.pullHeartbeat(req, p);
		if (req.method === "GET" && url.pathname === "/federation/entitlements")
			return this.entitlementsRoute(p);
		if (req.method === "POST" && url.pathname === "/federation/enroll")
			return this.enroll(req);
		if (req.method === "POST" && url.pathname === "/federation/usage")
			return this.usageIngest(req, p);
		if (req.method === "GET" && url.pathname === "/federation/usage")
			return this.usageRead(url, p);
		if (req.method === "POST" && url.pathname === "/federation/cr")
			return this.crDeclare(req, p);
		if (req.method === "GET" && url.pathname === "/federation/cr")
			return this.crList(p);
		const cr = /^\/federation\/cr\/([^/]+)\/status$/.exec(url.pathname);
		if (req.method === "POST" && cr !== null)
			return this.crStatus(req, decodeURIComponent(cr[1] ?? ""), p);
		return this.notFound(`${req.method} ${url.pathname}`);
	}

	/** W173 enrollment redeem — the code IS the credential on this route (the
	 *  gate lets POST /federation/enroll through bearer-optional; a presented
	 *  bearer is still validated). W233: redemption rides the injected
	 *  SpokeEnrollmentProvider — absent in solo posture → honest 501.
	 *  Unknown/expired → 401, already-redeemed → 409, bad body → 400;
	 *  success 201 {spoke_id, key_id, key, scopes, expires_at}. Raw key
	 *  material exists exactly once — this response. */
	private async enroll(req: Request): Promise<Response> {
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
		const code = str(body.code);
		if (code === null) return bad(400, "buckle.bad_body", "missing code");
		if (this.spokes === null)
			return bad(
				501,
				"buckle.no_federation",
				"no enrollment surface on this gate (solo posture)",
			);
		const out: RedeemResult = this.spokes.redeem({ code });
		if (!out.ok) {
			const status = out.code === "buckle.enroll_used" ? 409 : 401;
			return bad(status, out.code, out.why);
		}
		return Response.json(
			{
				spoke_id: out.spokeId,
				key_id: out.keyId,
				key: out.key,
				scopes: ["buckle:spoke:READ_", "buckle:spoke:WRITE_"],
				expires_at: out.expiresAt,
			},
			{ status: 201 },
		);
	}

	/** Spoke-reported CR transition: {state, note?} body → lifecycle-enforced
	 *  update. 401 no principal · 400 bad body · 404 unknown id · 409 illegal
	 *  transition · 200 row. */
	private async crStatus(
		req: Request,
		id: string,
		p: Principal | null,
	): Promise<Response> {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
		const state = typeof body.state === "string" ? body.state : "";
		const note = typeof body.note === "string" ? body.note : null;
		if (this.cr === null)
			return bad(
				501,
				"buckle.no_federation",
				"no CR surface on this gate (solo posture)",
			);
		const out = this.cr.transition({
			id,
			to: state,
			note,
			actor: {
				id: p.keyId,
				admin: p.kind === "root" || hasScope(p.scopes, "buckle:admin:WRITE_"),
			},
		});
		if (!out.ok) return bad(out.status, out.code, out.why);
		return Response.json({
			id,
			state: out.row.state,
			reported_at: out.row.reported_at,
		});
	}

	/** W160 CR declare guard: HUB-ADMIN-ONLY — buckle:admin:WRITE_ is demanded
	 *  at the gate AND here; the re-check is the structural
	 *  spoke-cannot-declare guard. Returns the rejection or null. */
	private crDeclareGuard(p: Principal | null): Response | null {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		if (!hasScope(p.scopes, "buckle:admin:WRITE_"))
			return authError(
				403,
				"buckle.insufficient_scope",
				"declaring CRs requires buckle:admin:WRITE_ (hub-admin capability; spokes report status only)",
			);
		return null;
	}

	/** W160 CR declare: guard (401/403) → 501 provider-less → body → seam;
	 *  the provider owns the structural private-domain guard (422) and
	 *  shape validation (400). */
	private async crDeclare(
		req: Request,
		p: Principal | null,
	): Promise<Response> {
		const guard = this.crDeclareGuard(p);
		if (guard !== null) return guard;
		if (this.cr === null)
			return bad(
				501,
				"buckle.no_federation",
				"no CR surface on this gate (solo posture)",
			);
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (body === null) return bad(400, "buckle.bad_body", "invalid JSON body");
		const action = str(body.action);
		const target = str(body.target);
		if (action === null || target === null)
			return bad(400, "buckle.bad_body", "action and target are required");
		const id =
			str(body.id) ??
			`cr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const o = body.origin as Record<string, unknown> | null | undefined;
		const hasOrigin = o !== null && typeof o === "object" && !Array.isArray(o);
		const out = this.cr.declare({
			id,
			action,
			target,
			payload: body.payload,
			origin: {
				system:
					(hasOrigin && typeof o.system === "string" ? o.system : null) ??
					"belt",
				actor:
					(hasOrigin && typeof o.actor === "string" ? o.actor : null) ??
					p?.actor ??
					p?.keyId ??
					"unknown",
				// pass the declared origin through VERBATIM so the structural
				// domain guard sees private markers carried on it too
				...(hasOrigin ? o : {}),
			} as { system: string; actor: string },
		});
		if (!out.ok) return bad(out.status, out.code, out.why);
		return Response.json(this.crOut(out.row), { status: 201 });
	}

	/** W160 CR list: hub-admin read (buckle:admin:READ_; WRITE_ implies);
	 *  W233.3: rides the seam — honest 501 provider-less. */
	private crList(p: Principal | null): Response {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		if (!hasScope(p.scopes, "buckle:admin:READ_"))
			return authError(
				403,
				"buckle.insufficient_scope",
				"requires buckle:admin:READ_",
			);
		if (this.cr === null)
			return bad(
				501,
				"buckle.no_federation",
				"no CR surface on this gate (solo posture)",
			);
		return Response.json({
			cr_queue: this.cr.list().map((r) => this.crOut(r)),
		});
	}

	/** Wire-format row: payload/origin storage JSON → objects. */
	private crOut(r: CrRow): Record<string, unknown> {
		const parse = (s: string | null): unknown => {
			if (s === null) return null;
			try {
				return JSON.parse(s) as unknown;
			} catch {
				return s;
			}
		};
		return {
			id: r.id,
			action: r.action,
			target: r.target,
			declared_at: r.declared_at,
			state: r.state,
			note: r.note,
			payload: parse(r.payload),
			origin: parse(r.origin),
			updated_at: r.updated_at,
			reported_at: r.reported_at,
			verified_at: r.verified_at,
			claimed_by: r.claimed_by,
			claimed_at: r.claimed_at,
		};
	}

	/** W171 spoke aggregate self-report ingest, riding the W233.2
	 *  usage-ingest seam: 401 → 501 provider-less (solo posture) → the
	 *  provider owns validate (400) → per-team opt-in (403, default OFF is
	 *  structural) → private-domain guard (422) → store. spoke identity =
	 *  the presenting key, never a body field. */
	private async usageIngest(
		req: Request,
		p: Principal | null,
	): Promise<Response> {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		if (this.usage === null)
			return bad(
				501,
				"buckle.no_federation",
				"no usage ingest surface on this gate (solo posture)",
			);
		const body = (await req.json().catch(() => null)) as unknown;
		// spoke label = the minted key's name (operator infrastructure
		// naming, readable on the dashboard); opaque keyId fallback.
		const keyRow = this.db
			.query("SELECT name FROM api_keys WHERE key_id = ?")
			.get(p.keyId) as { name: string | null } | null;
		const out = this.usage.ingest({
			body,
			spoke: keyRow?.name ?? p.keyId,
		});
		if (!out.ok) return bad(out.status, out.code, out.why);
		return Response.json({ ok: true, spoke: keyRow?.name ?? p.keyId, ...out });
	}

	/** W171 hub-admin read over the stored rollups, riding the W233.2 seam:
	 *  401 → 403 scope → 501 provider-less. ?days=N clamps 1..90. */
	private usageRead(url: URL, p: Principal | null): Response {
		if (p === null)
			return authError(401, "buckle.auth_missing", "missing bearer token");
		if (!hasScope(p.scopes, "buckle:admin:READ_"))
			return authError(
				403,
				"buckle.insufficient_scope",
				"requires buckle:admin:READ_",
			);
		if (this.usage === null)
			return bad(
				501,
				"buckle.no_federation",
				"no usage read surface on this gate (solo posture)",
			);
		const d = Number(url.searchParams.get("days") ?? 28) || 28;
		return Response.json({
			ok: true,
			...this.usage.read(Math.min(90, Math.max(1, d))),
		});
	}

	/** 404 envelope in the admin API's shape. */
	private notFound(what: string): Response {
		return Response.json(
			{
				error: {
					code: "buckle.no_route",
					message: `no federation route: ${what}`,
				},
			},
			{ status: 404 },
		);
	}
}
