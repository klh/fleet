// topology-scope.ts — W858.7.33 (design slice 4, docs/design/hub-topology-overview.md):
// the enterprise scope engine for the belt map API. Design law: "Enterprise
// viewers receive only hub summaries and permitted routes by default. Local
// model names and lanes require the corresponding scope. The server filters
// before aggregation and before deltas; hiding labels in the browser is not
// an authorization boundary."
//
// Config-over-code (W1253 JSON law): BELT_TOPOLOGY_POLICY names a JSON policy
// file. Absent/unset = INERT — Core SKU byte-for-byte (no filtering, detail
// feeds answer as before). A CONFIGURED path that load fails on is startup
// fatal (fail closed — mirrors the W1265.1 account-policy law).
//
// Viewer authority arrives ONLY as a verified stamp: base64url(payload) +
// "." + base64url(HMAC-SHA256(secret, payloadB64)) in x-klh-topology-authority,
// written by the edge that authenticated the viewer (the board's IAM overlay),
// accepted only from policy.trustedStampers peers. The proxy chain forwards no
// client headers (board buckle-read-proxy), so a browser cannot inject the
// stamp. No stamp = summaries-only authority (fail closed): unattributed hubs
// stay visible (shared infrastructure), attributed hubs require tenant +
// team/project membership, and detail denies with the fixed
// `topology.scope_denied` shape.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** The detail scopes the design names: models = local model names, lanes =
 *  lane/local process detail (the supervisor doc). */
export const DETAIL_SCOPES = ["topology.models", "topology.lanes"] as const;
export type DetailScope = (typeof DETAIL_SCOPES)[number];

export const TOPOLOGY_STAMP_HEADER = "x-klh-topology-authority";

/** One hub's enterprise attribution — machine policy, never client data. */
export interface TopologyHubAttribution {
	tenant: string;
	teams: string[];
	projects: string[];
}

export interface TopologyPolicy {
	/** Hub label → attribution. Unlisted hubs are unattributed (shared). */
	hubs: Record<string, TopologyHubAttribution>;
	/** 0600 secret shared with the stamping edge; stamps verify against it. */
	stampSecretPath: string | null;
	/** Peers whose stamps are honored — the edge that authenticated the viewer. */
	trustedStampers: string[];
}

export interface TopologyAuthority {
	tenant: string | null;
	/** null = unrestricted (inert policy). [] = no membership. */
	teams: string[] | null;
	projects: string[] | null;
	scopes: DetailScope[];
	/** Inert policy — Core SKU byte-for-byte, no filtering anywhere. */
	full: boolean;
}

/** The fixed-shape scope denial every gated surface answers with. */
export interface ScopeDenial {
	ok: false;
	status: 403;
	code: "topology.scope_denied";
	why: string;
}

export const scopeDenial = (scope: DetailScope): ScopeDenial => ({
	ok: false,
	status: 403,
	code: "topology.scope_denied",
	why: `topology detail withheld — this viewer holds no ${scope} scope`,
});

// ─── policy load ────────────────────────────────────────────────────────────

const stringList = (value: unknown, hub: string, axis: string): string[] => {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || !item.trim())
	)
		throw new Error(
			`topology policy: hub '${hub}' ${axis} must be an array of strings`,
		);
	return value as string[];
};

const expandHome = (path: string): string =>
	path.startsWith("~/") ? homedir() + path.slice(1) : path;

/** Parse + validate the policy JSON. Throws on any shape fault — the caller
 *  turns a configured-but-broken policy into startup failure (fail closed). */
export function parseTopologyPolicy(raw: string): TopologyPolicy {
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("topology policy: top level must be an object");
	const root = parsed as Record<string, unknown>;
	const hubsRaw = root.hubs;
	if (!hubsRaw || typeof hubsRaw !== "object" || Array.isArray(hubsRaw))
		throw new Error("topology policy: 'hubs' object is required");
	const hubs: Record<string, TopologyHubAttribution> = {};
	for (const [label, entry] of Object.entries(
		hubsRaw as Record<string, unknown>,
	)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`topology policy: hub '${label}' must be an object`);
		const attr = entry as Record<string, unknown>;
		if (typeof attr.tenant !== "string" || !attr.tenant.trim())
			throw new Error(`topology policy: hub '${label}' needs a tenant`);
		hubs[label] = {
			tenant: attr.tenant,
			teams: stringList(attr.teams, label, "teams"),
			projects: stringList(attr.projects, label, "projects"),
		};
	}
	return {
		hubs,
		stampSecretPath:
			typeof root.stampSecretPath === "string" && root.stampSecretPath.trim()
				? expandHome(root.stampSecretPath)
				: null,
		trustedStampers: (Array.isArray(root.trustedStampers)
			? root.trustedStampers
			: []
		).filter((s): s is string => typeof s === "string" && s.length > 0),
	};
}

/** Load the policy from BELT_TOPOLOGY_POLICY. Returns null when unset/empty
 *  (inert). Throws when configured but broken (caller = startup fatal). */
export function loadTopologyPolicy(
	env: Record<string, string | undefined> = process.env,
): TopologyPolicy | null {
	const path = env.BELT_TOPOLOGY_POLICY?.trim();
	if (!path) return null;
	return parseTopologyPolicy(readFileSync(expandHome(path), "utf8"));
}

/** The authority a verified stamp payload describes (null = reject). */
const authorityFromStamp = (
	stamp: Record<string, unknown>,
): TopologyAuthority | null => {
	const scopes = Array.isArray(stamp.scopes) ? stamp.scopes : [];
	return {
		tenant: typeof stamp.tenant === "string" ? stamp.tenant : null,
		teams: stringList(stamp.teams, "stamp", "teams"),
		projects: stringList(stamp.projects, "stamp", "projects"),
		scopes: scopes.filter((scope): scope is DetailScope =>
			DETAIL_SCOPES.includes(scope as DetailScope),
		),
		full: false,
	};
};

/** Verify one stamp value (secret + trusted peers); null = unverified. */
const verifyStamp = (
	value: string,
	policy: TopologyPolicy,
	peerAddress: string | null,
): TopologyAuthority | null => {
	if (!policy.stampSecretPath) return null;
	if (!policy.trustedStampers.includes(peerAddress ?? "")) return null;
	try {
		const [payloadB64, sigB64] = value.split(".");
		if (!payloadB64 || !sigB64) return null;
		const expected = createHmac("sha256", readFileSync(policy.stampSecretPath))
			.update(payloadB64)
			.digest();
		const got = Buffer.from(sigB64, "base64url");
		if (got.length !== expected.length || !timingSafeEqual(got, expected))
			return null;
		const payload: unknown = JSON.parse(
			Buffer.from(payloadB64, "base64url").toString("utf8"),
		);
		if (!payload || typeof payload !== "object") return null;
		return authorityFromStamp(payload as Record<string, unknown>);
	} catch {
		return null;
	}
};

/** Inert authority — everything visible, every detail permitted (Core SKU). */
export const FULL_AUTHORITY: TopologyAuthority = {
	tenant: null,
	teams: null,
	projects: null,
	scopes: [...DETAIL_SCOPES],
	full: true,
};

/** Fail-closed default: summaries only, no detail, no membership. */
export const DEFAULT_AUTHORITY: TopologyAuthority = {
	tenant: null,
	teams: [],
	projects: [],
	scopes: [],
	full: false,
};

/** Resolve the viewer authority for one request. Policy absent → full access
 *  (inert); policy present → verified stamp or summaries-only default. */
export function resolveTopologyAuthority(
	req: Request,
	policy: TopologyPolicy | null,
	peerAddress: string | null,
): TopologyAuthority {
	if (!policy) return FULL_AUTHORITY;
	const stamp = req.headers.get(TOPOLOGY_STAMP_HEADER);
	if (!stamp) return DEFAULT_AUTHORITY;
	return verifyStamp(stamp, policy, peerAddress) ?? DEFAULT_AUTHORITY;
}

/** Boolean face of verifyStamp for callers that only need the verdict. */
export const verifyTopologyStamp = (
	value: string,
	policy: TopologyPolicy,
	peerAddress: string | null,
): boolean => verifyStamp(value, policy, peerAddress) !== null;

/** Mint a stamp for an authority — the edge side of the seam (the board's
 *  IAM overlay mints it; tests mint with the same shared secret). */
export const mintTopologyStamp = (
	authority: {
		tenant: string | null;
		teams?: string[];
		projects?: string[];
		scopes?: string[];
	},
	secret: string | Buffer,
): string => {
	const payload = Buffer.from(
		JSON.stringify({
			v: 1,
			tenant: authority.tenant,
			teams: authority.teams ?? [],
			projects: authority.projects ?? [],
			scopes: authority.scopes ?? [],
		}),
	).toString("base64url");
	return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
};

// ─── the scope engine ───────────────────────────────────────────────────────

/** Loose view of the wire snapshot the scope engine filters. */
export interface ScopeGraphSnapshot {
	ok?: boolean;
	schemaVersion?: number;
	hubs?: Array<Record<string, unknown>>;
	targets?: Array<Record<string, unknown>>;
	edges?: Array<Record<string, unknown>>;
	traces?: Array<Record<string, unknown>>;
	totals?: Record<string, unknown> | null;
	coverage?: Record<string, unknown> | null;
	[x: string]: unknown;
}

export interface ScopeOutcome {
	snapshot: ScopeGraphSnapshot;
	dropped: { hubs: number; targets: number; edges: number; traces: number };
}

/** A hub is visible when unattributed (shared infrastructure) or when the
 *  viewer's authority covers its tenant, teams and projects axes. */
export const hubPermitted = (
	node: Record<string, unknown>,
	authority: TopologyAuthority,
	policy: TopologyPolicy,
): boolean => {
	const attr = policy.hubs[String(node.name ?? "")];
	if (!attr) return true;
	if (authority.tenant !== attr.tenant) return false;
	const viewerTeams = authority.teams ?? [];
	const viewerProjects = authority.projects ?? [];
	if (attr.teams.length && !attr.teams.some((t) => viewerTeams.includes(t)))
		return false;
	if (
		attr.projects.length &&
		!attr.projects.some((p) => viewerProjects.includes(p))
	)
		return false;
	return true;
};

/** Detail gate: the scope-required verdict for one detail feed. */
export const detailAccess = (
	authority: TopologyAuthority,
	scope: DetailScope,
): { ok: true } | ScopeDenial =>
	authority.full || authority.scopes.includes(scope)
		? { ok: true }
		: scopeDenial(scope);

/** Filter the wire snapshot to the authority BEFORE any client aggregation:
 *  permitted hubs carry their attribution for the GUI filters, endpoints and
 *  edges survive only when attached to a permitted hub, a trace survives only
 *  when every hop is permitted. Estate totals null out (full-estate sums
 *  would leak foreign traffic — the viewer's estate recomputes honestly from
 *  the survivors). Coverage flags the filtering. */
export function scopeTopologySnapshot(
	snapshot: ScopeGraphSnapshot,
	authority: TopologyAuthority,
	policy: TopologyPolicy,
): ScopeOutcome {
	if (authority.full)
		return {
			snapshot,
			dropped: { hubs: 0, targets: 0, edges: 0, traces: 0 },
		};
	const dropped = { hubs: 0, targets: 0, edges: 0, traces: 0 };
	const hubs = (snapshot.hubs ?? []).filter((node) => {
		const keep = hubPermitted(node, authority, policy);
		if (keep) {
			const attr = policy.hubs[String(node.name ?? "")];
			if (attr) {
				node.tenant = attr.tenant;
				node.teams = attr.teams;
				node.projects = attr.projects;
			}
		}
		if (!keep) dropped.hubs++;
		return keep;
	});
	const hubIds = new Set(hubs.map((node) => String(node.id)));
	const edges = (snapshot.edges ?? []).filter((edge) => {
		const keep =
			hubIds.has(String(edge.from)) &&
			(hubIds.has(String(edge.to)) ||
				(snapshot.targets ?? []).some(
					(target) => String(target.id) === String(edge.to),
				));
		if (!keep) dropped.edges++;
		return keep;
	});
	const keptEdgeIds = new Set(edges.map((edge) => String(edge.id)));
	const targets = (snapshot.targets ?? []).filter((target) =>
		edges.some(
			(edge) =>
				keptEdgeIds.has(String(edge.id)) &&
				String(edge.to) === String(target.id),
		),
	);
	dropped.targets = (snapshot.targets ?? []).length - targets.length;
	const traces = (snapshot.traces ?? []).filter((trace) => {
		const hops = Array.isArray(trace.hops) ? trace.hops : [];
		const keep =
			hops.length > 0 && hops.every((hop) => hubIds.has(`hub:${String(hop)}`));
		if (!keep) dropped.traces++;
		return keep;
	});
	return {
		snapshot: {
			...snapshot,
			hubs,
			targets,
			edges,
			traces,
			totals: {
				requests: null,
				failed: null,
				active: null,
				inputTokens: null,
				outputTokens: null,
			},
			coverage: {
				...(snapshot.coverage ?? {}),
				scopeFiltering: "active",
				scopeDropped: dropped,
			},
		},
		dropped,
	};
}
