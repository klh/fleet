// src/account-policy.ts — W1265.1: the repo/workspace identity + account-tier
// policy engine at the Buckle ingress. The authenticated client/session key
// (bksk_, minted by the trusted installer/launcher) resolves ONE repo class;
// the class carries the allowed account tier + the compatible upstream set
// (provider host/adapter globs + model group globs). The client-supplied
// x-klh-repo header is a CLAIM verified against the binding — never trusted
// alone. Unknown key, spoofed claim, entitlement mismatch, wrong wire and a
// scoped-to-zero upstream set all fail closed with a typed local error
// BEFORE any outbound call; no fallback may close-cross the class boundary
// (the walked selection is scoped to entitled rows only).
//
// Config chain (config-over-code): explicit path → BUCKLE_REPO_TIER_POLICY
// → ~/.claude/local-llm/repo-tier-policy.yaml → none (policy inert). A
// CONFIGURED path that cannot load is startup fatal (the W1123 posture): a
// broken policy mount must never silently disable the boundary. Absent
// config = inert posture (the gateway behaves as before).
//
// Trust anchors: the governance gate + the operator's binding table. Root
// break-glass keys bypass the class lookup (installer-minted on-device; the
// W921 readiness synthetic rides root and must keep flowing).
//
// Tool identity (Claude Code, Codex desktop/CLI, …) rides the key NAME: the
// installer mints per-tool keys (name = tool or lane sid) and binds the
// class in this table; disabling the boundary = removing the file / unsetting
// the env (the simple disable the installer surfaces).
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { YAML } from "bun";
import type { CandidateRow } from "./candidates.ts";
import type { RouteSelection } from "./decide.ts";

/** One repo class: the tier + the compatible upstream set. */
export interface AccountClass {
	/** Stable class id — metering label, never renamed. */
	id: string;
	/** The allowed account tier ("work" / "personal" / …) — audit label. */
	tier: string;
	/** Key NAME globs bound to this class (the trusted mint name; `*` the
	 *  only wildcard). Absent = any key matches (catch-all class). */
	keys?: string[];
	/** Repo/workspace root globs the class covers — the verified identity.
	 *  A client claim must match one; absent = the key binding stands alone. */
	repos?: string[];
	/** Provider globs (matched against the deployment adapter name AND the
	 *  URL host). Absent = unrestricted on this axis. */
	providers?: string[];
	/** Model group globs (the wire id clients send). Absent = unrestricted. */
	groups?: string[];
}

/** The operator doc: `version: 1` + the class table. */
export interface AccountPolicyDoc {
	version?: number;
	classes: AccountClass[];
}

/** The resolved per-request context (null axes = unrestricted there). */
export interface AcctContext {
	/** Safe hash of the resolved repo identity (class + binding) — the audit
	 *  row carries this, never the raw path. */
	repoHash: string | null;
	/** The allowed account tier (audit label). */
	tier: string | null;
	/** The authenticated key's mint name (tool/lane identity). */
	keyName: string | null;
	/** The protocol-route provider pin (/zai/… routes) — an extra row filter. */
	pin: string | null;
	/** Class provider globs; null = unrestricted. */
	allowedHosts: string[] | null;
	/** Class group entitlement — refused pre-decide when the requested group
	 *  matches none. Null = unrestricted. */
	allowedGroups: string[] | null;
}

/** The ingress verdict: a resolved context or a typed fail-closed refusal. */
export type AcctResult =
	| { ok: true; acct?: AcctContext }
	| { ok: false; status: number; code: string; why: string };

/** The W1265 named protocol routes, parsed off the ingress path. */
export interface ProtocolRoute {
	/** The /w/<slug> lane attribution when composed. */
	lane: string;
	/** The provider pin (/zai/… routes); null = wire routes only. */
	pin: string | null;
	/** The route's wire (the dialect the subpath must speak). */
	wire: "anthropic" | "openai";
	/** The inner wire path (/v1/messages, …) — forwards verbatim. */
	inner: string;
}

export type ProtocolTarget =
	| { ok: true; dialect: "anthropic" | "openai"; inner: string }
	| { ok: false; status: number; code: string; why: string; allow?: string };

/** Repo-class lookup: the first class whose `keys` globs match the key
 *  name. No match = unknown key = fail closed. */
function classFor(
	doc: AccountPolicyDoc,
	keyName: string | null,
): { cls: AccountClass; keyGlob: string } | null {
	for (const cls of doc.classes) {
		const globs = cls.keys ?? ["*"];
		for (const g of globs) {
			if (globMatch(g, keyName ?? "", true)) return { cls, keyGlob: g };
		}
	}
	return null;
}

/** The claim the client may present (verified against the binding, never
 *  trusted alone). */
export const REPO_CLAIM_HEADER = "x-klh-repo";

/** Safe hash of the resolved repo identity — 16 hex chars, never the path. */
export function repoHashOf(classId: string, binding: string): string {
	return createHash("sha256")
		.update(`${classId} ${binding}`)
		.digest("hex")
		.slice(0, 16);
}

/** Anchored glob: `*` spans any run of chars (including `/`), everything
 *  else literal. Case-insensitive only where callers pass ci (hosts,
 *  adapters). A plain two-pointer walk — no regex, no escape soup. */
export function globMatch(pattern: string, value: string, ci = false): boolean {
	if (pattern === "*") return true;
	const p = ci ? pattern.toLowerCase() : pattern;
	const v = ci ? value.toLowerCase() : value;
	let starP = -1;
	let starV = 0;
	let i = 0;
	let j = 0;
	while (j < v.length) {
		if (i < p.length && p[i] === "*") {
			starP = i++;
			starV = j;
		} else if (i < p.length && p[i] === v[j]) {
			i++;
			j++;
		} else if (starP >= 0) {
			i = starP + 1;
			j = ++starV;
		} else {
			return false;
		}
	}
	while (i < p.length && p[i] === "*") i++;
	return i === p.length;
}

/** Ingress resolution (the one proxy() calls). doc = null (policy inert):
 *  the pin still scopes (the W1265 pinned routes enforce Z.ai-only delivery
 *  even without a class table); no pin → undefined (gateway behaves as
 *  before). doc present: root bypasses (break-glass), every other principal
 *  resolves its class or refuses — unknown key, unverified claim and an
 *  out-of-tier model group are typed 403 refusals before any routing. */
export function applyAccountPolicy(
	doc: AccountPolicyDoc | null | undefined,
	input: {
		kind?: string | null;
		keyName: string | null;
		claimRepo: string | null;
		pin: string | null;
		group: string;
	},
): AcctResult {
	if (doc === null || doc === undefined) {
		if (input.pin === null) return { ok: true };
		return { ok: true, acct: emptyAcct({ pin: input.pin }) };
	}
	if (input.kind === "root") {
		return { ok: true, acct: emptyAcct({ tier: "root", keyName: "root" }) };
	}
	return resolveClass(doc, input);
}

/** The doc-present branch: bind the class, verify the claim, check the
 *  tier entitlement, stamp the context. */
function resolveClass(
	doc: AccountPolicyDoc,
	input: {
		kind?: string | null;
		keyName: string | null;
		claimRepo: string | null;
		pin: string | null;
		group: string;
	},
): AcctResult {
	const hit = classFor(doc, input.keyName);
	if (hit === null)
		return {
			ok: false,
			status: 403,
			code: "buckle.repo_unknown",
			why: `key ${
				input.keyName === null ? "(unnamed)" : `'${input.keyName.slice(0, 48)}'`
			} binds no repo class — refused before routing`,
		};
	// Claim verification: a presented x-klh-repo must match the class's
	// verified roots; a class with no roots cannot verify any claim.
	if (input.claimRepo !== null) {
		const verified = (hit.cls.repos ?? []).some((p) =>
			globMatch(p, input.claimRepo),
		);
		if (!verified)
			return {
				ok: false,
				status: 403,
				code: "buckle.repo_claim_mismatch",
				why: "x-klh-repo claim does not match the key's bound repo class — refused (spoofed or stale claim)",
			};
	}
	// Entitlement: the requested model group must sit inside the tier.
	if (
		hit.cls.groups !== undefined &&
		!hit.cls.groups.some((g) => globMatch(g, input.group))
	)
		return {
			ok: false,
			status: 403,
			code: "buckle.tier_entitlement",
			why: `model '${input.group.slice(0, 96)}' is outside the '${hit.cls.id}' tier entitlement — refused before routing`,
		};
	return {
		ok: true,
		acct: {
			repoHash: repoHashOf(hit.cls.id, hit.keyGlob),
			tier: hit.cls.tier,
			keyName: input.keyName,
			pin: input.pin,
			allowedHosts: hit.cls.providers ?? null,
			allowedGroups: hit.cls.groups ?? null,
		},
	};
}

/** A context with no class axes (pin-only, root break-glass). */
function emptyAcct(parts: {
	pin?: string | null;
	tier?: string | null;
	keyName?: string | null;
}): AcctContext {
	return {
		repoHash: null,
		tier: parts.tier ?? null,
		keyName: parts.keyName ?? null,
		pin: parts.pin ?? null,
		allowedHosts: null,
		allowedGroups: null,
	};
}

function hostOf(row: CandidateRow): string {
	try {
		return new URL(row.dep.url).hostname;
	} catch {
		return "";
	}
}

/** Post-decision scoping: confine the walked selection to entitled rows —
 *  pin (zai routes) + class provider/group globs. The router walks
 *  sel.ordered, so a scoped list makes cross-boundary fallback structurally
 *  impossible; scoped to zero = typed refusal (missing upstream), never an
 *  entitled-set exit. */
export function scopeSelection(
	sel: RouteSelection,
	acct: AcctContext | undefined,
):
	| { ok: true; sel: RouteSelection }
	| { ok: false; status: number; code: string; why: string } {
	if (acct === undefined) return { ok: true, sel };
	const ordered = sel.ordered.filter((row) => rowInScope(row, acct));
	if (ordered.length === 0)
		return {
			ok: false,
			status: 503,
			code: "buckle.tier_no_upstream",
			why: `no entitled upstream for '${sel.head.group}' within the account boundary — refused, zero outbound`,
		};
	if (ordered.length === sel.ordered.length) return { ok: true, sel };
	return {
		ok: true,
		sel: {
			...sel,
			ordered,
			seen: ordered.length,
			top: ordered.slice(0, 3).map((c) => c.candidate_id),
			head: ordered[0],
		},
	};
}

/** One row vs the context: the pin (adapter exact or host contains), the
 *  class provider globs (adapter OR host), the class group globs. */
function rowInScope(row: CandidateRow, acct: AcctContext): boolean {
	const host = hostOf(row);
	if (acct.pin !== null && !pinMatches(row.dep.adapter, host, acct.pin))
		return false;
	if (
		acct.allowedHosts !== null &&
		!acct.allowedHosts.some(
			(g) =>
				globMatch(g, row.dep.adapter ?? "", true) || globMatch(g, host, true),
		)
	)
		return false;
	if (
		acct.allowedGroups !== null &&
		!acct.allowedGroups.some((g) => globMatch(g, row.group))
	)
		return false;
	return true;
}

/** The /zai pin: adapter named zai, or the host carries it. */
function pinMatches(
	adapter: string | undefined,
	host: string,
	pin: string,
): boolean {
	return adapter === pin || globMatch(`*${pin}*`, host, true);
}

/** The W1265 named protocol routes: [/w/<slug>]/{anthropic,openai[,/zai]}…
 *  Z.ai pins read /zai/anthropic and /zai/openai. Null = not a protocol
 *  route (bare/lane paths fall through to the existing dispatch). */
export function protocolRouteOf(path: string): ProtocolRoute | null {
	const m =
		/^\/(?:w\/(?<lane>[A-Za-z0-9][A-Za-z0-9._-]*)\/)?(?:zai\/)?(?<wire>anthropic|openai)(?<inner>\/v1\/.+)$/.exec(
			path,
		);
	if (m === null || m.groups === undefined) return null;
	const { lane = "", wire, inner } = m.groups;
	if (wire !== "anthropic" && wire !== "openai") return null;
	return {
		lane,
		pin: path.includes("/zai/") ? "zai" : null,
		wire: wire,
		inner: inner,
	};
}

const ANTHROPIC_PATHS = ["/v1/messages", "/v1/messages/count_tokens"];
const OPENAI_PATHS = ["/v1/chat/completions", "/v1/responses"];

/** Route target check: the subpath must speak the route's wire (typed 4xx,
 *  zero outbound on mismatch) and the method must match the path's table. */
export function protocolRouteTarget(
	pr: ProtocolRoute,
	method: string,
): ProtocolTarget {
	if (pr.inner === "/v1/models")
		return method === "GET"
			? { ok: true, dialect: pr.wire, inner: pr.inner }
			: notAllowed("GET, OPTIONS");
	if (pr.wire === "anthropic") return anthropicTarget(pr, method);
	return openaiTarget(pr, method);
}

/** The anthropic route's subpath table; wrong-wire paths name the fix. */
function anthropicTarget(pr: ProtocolRoute, method: string): ProtocolTarget {
	if (!ANTHROPIC_PATHS.includes(pr.inner)) {
		if (OPENAI_PATHS.includes(pr.inner))
			return {
				ok: false,
				status: 400,
				code: "buckle.wire_mismatch",
				why: `path ${pr.inner} speaks the openai wire — use /openai…`,
			};
		return {
			ok: false,
			status: 404,
			code: "buckle.no_route",
			why: `no route: ${method} /${pr.wire}${pr.inner}`,
		};
	}
	return post(pr, method);
}

/** The openai route's subpath table; wrong-wire paths name the fix. */
function openaiTarget(pr: ProtocolRoute, method: string): ProtocolTarget {
	if (!OPENAI_PATHS.includes(pr.inner)) {
		if (ANTHROPIC_PATHS.includes(pr.inner))
			return {
				ok: false,
				status: 400,
				code: "buckle.wire_mismatch",
				why: `path ${pr.inner} speaks the anthropic wire — use /anthropic…`,
			};
		return {
			ok: false,
			status: 404,
			code: "buckle.no_route",
			why: `no route: ${method} /${pr.wire}${pr.inner}`,
		};
	}
	return post(pr, method);
}

/** Known POST subpath, wrong method = 405 + Allow. */
function post(pr: ProtocolRoute, method: string): ProtocolTarget {
	if (method === "POST") return { ok: true, dialect: pr.wire, inner: pr.inner };
	return notAllowed("POST, OPTIONS");
}

function notAllowed(allow: string): ProtocolTarget {
	return {
		ok: false,
		status: 405,
		code: "buckle.method_not_allowed",
		why: `allows: ${allow}`,
		allow,
	};
}

/** Resolution chain: explicit → BUCKLE_REPO_TIER_POLICY → the runtime copy
 *  in ~/.claude/local-llm/ → none (inert). A CONFIGURED path that is missing
 *  or malformed is startup fatal (fail closed, never silently disabled). */
export function loadAccountPolicy(explicitPath?: string): {
	doc: AccountPolicyDoc | null;
	source: string;
} {
	const home = `${process.env.HOME ?? ""}/.claude/local-llm/repo-tier-policy.yaml`;
	const candidates = [explicitPath, process.env.BUCKLE_REPO_TIER_POLICY, home];
	for (const p of candidates) {
		if (typeof p !== "string" || p.length === 0) continue;
		if (!existsSync(p)) {
			if (p !== home)
				throw new Error(
					`account-policy: ${p} configured but missing — refusing to boot with the boundary disabled`,
				);
			continue;
		}
		return { doc: parseAccountPolicy(p), source: p };
	}
	return { doc: null, source: "none" };
}

function parseAccountPolicy(p: string): AccountPolicyDoc {
	const doc = YAML.parse(readFileSync(p, "utf8")) as AccountPolicyDoc | null;
	if (!doc || typeof doc !== "object" || !Array.isArray(doc.classes))
		throw new Error(`account-policy: ${p} has no classes list`);
	for (const cls of doc.classes) {
		if (typeof cls.id !== "string" || cls.id.length === 0)
			throw new Error(`account-policy: ${p}: a class is missing its id`);
		if (typeof cls.tier !== "string" || cls.tier.length === 0)
			throw new Error(
				`account-policy: ${p}: class '${cls.id}' is missing its tier`,
			);
	}
	return doc;
}
