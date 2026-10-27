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
import { hintFit, hintTotal, type RouteHint } from "./hints.ts";
import type { CandidateRow } from "./candidates.ts";
import type { RouteSelection } from "./decide.ts";

/** One repo class: the tier + the compatible upstream set. */
export interface AccountClass {
	/** Stable class id — metering label, never renamed. */
	id: string;
	/** The allowed account tier ("work" / "personal" / …) — audit label. */
	tier: string;
	/** Key NAME globs bound to this class (the trusted mint name; `*` the
	 *  only wildcard). Absent = the class matches NO key — the general-work
	 *  catch-all must be declared explicitly (W1265.2: a nameless key never
	 *  resolves a class, and silence never grants one). */
	keys?: string[];
	/** Explicit general-work profile: true = no repo claim is required (the
	 *  class stands alone). Absent/false = a declared `repos` list makes the
	 *  verified x-klh-repo claim MANDATORY (missing claim = refusal). */
	general?: boolean;
	/** Provider globs this class must never reach (matched against the
	 *  deployment adapter AND the URL host). The general default denies the
	 *  enterprise adapter — no IKEA/personal crossover on general traffic. */
	denyProviders?: string[];
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

/** The W1265 named protocol routes are parsed at the ingress seam
 *  (src/ingress-routes.ts, the parent item's contract); the provider pin
 *  arrives here as `pin` — never re-parsed in this module. */

/** The ingress verdict: a resolved context or a typed fail-closed refusal. */
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
	/** Class provider globs that must never be reached (W1265.2: the general
	 *  default denies the enterprise adapter); null = no deny axis. */
	deniedHosts: string[] | null;
	/** The VERIFIED repo claim path (null = none presented / general). */
	claimRepo: string | null;
	/** Class group entitlement — refused pre-decide when the requested group
	 *  matches none. Null = unrestricted. */
	allowedGroups: string[] | null;
}

/** The ingress verdict: a resolved context or a typed fail-closed refusal.
 *  A refusal carries whatever binding identity was proven before the refusal
 *  (W1265.2) — the audit row still shows repo hash + tier + key name. */
export type AcctResult =
	| { ok: true; acct?: AcctContext }
	| {
			ok: false;
			status: number;
			code: string;
			why: string;
			/** Partial proven identity for the audit row (never the raw path). */
			audit?: Partial<AcctContext>;
	  };

/** Repo-class lookup: the first class whose `keys` globs match the key
 *  name. W1265.2: an unnamed (anonymous) principal never resolves a class —
 *  a catch-all must be declared explicitly (`keys: ["*"]`) and still only
 *  ever matches a NAMED key. No match = unknown key = fail closed. */
function classFor(
	doc: AccountPolicyDoc,
	keyName: string | null,
): { cls: AccountClass; keyGlob: string } | null {
	if (keyName === null) return null;
	for (const cls of doc.classes) {
		for (const g of cls.keys ?? []) {
			if (globMatch(g, keyName, true)) return { cls, keyGlob: g };
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
		lane: string | null;
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
		lane: string | null;
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
			audit: { keyName: input.keyName },
		};
	// Binding-derived identity — the class + the key GLOB mint it; a caller
	// claim can never move it (a forged in-glob repo proves membership only).
	const hash = repoHashOf(hit.cls.id, hit.keyGlob);
	const audit = {
		repoHash: hash,
		tier: hit.cls.tier,
		keyName: input.keyName,
	};
	// Session binding: riding /w/<sid> requires sid === key name (no relax
	// globs — a trusted launcher binding a lane mints the key UNDER that sid).
	if (input.lane !== null && input.lane !== "" && input.lane !== input.keyName)
		return {
			ok: false,
			status: 403,
			code: "buckle.lane_bind_mismatch",
			why: `lane slug '${input.lane.slice(0, 64)}' does not match the authenticated session key — refused before routing`,
			audit,
		};
	// Membership evidence: a non-general class with declared repos demands
	// the claim header — the glob proves CLASS MEMBERSHIP only, never the
	// exact session↔repo identity (that proof lives in the trusted mint /
	// binding table that created the key, not in a caller header).
	if (
		hit.cls.general !== true &&
		(hit.cls.repos ?? []).length > 0 &&
		input.claimRepo === null
	)
		return {
			ok: false,
			status: 403,
			code: "buckle.repo_unverified",
			why: `class '${hit.cls.id}' is repo-bound — a verified x-klh-repo claim (or the explicit general profile) is required — refused`,
			audit,
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
				audit,
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
			audit,
		};
	return {
		ok: true,
		acct: {
			repoHash: hash,
			tier: hit.cls.tier,
			keyName: input.keyName,
			pin: input.pin,
			allowedHosts: hit.cls.providers ?? null,
			deniedHosts: hit.cls.denyProviders ?? null,
			allowedGroups: hit.cls.groups ?? null,
			claimRepo: input.claimRepo,
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
		deniedHosts: null,
		allowedGroups: null,
		claimRepo: null,
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
	if (ordered.length === sel.ordered.length)
		// nothing filtered, but the boundary is LIVE: mark the selection so the
		// router's ladder rungs stay inside the entitled domain too.
		return { ok: true, sel: { ...sel, accountScoped: true } };
	return {
		ok: true,
		sel: {
			...sel,
			ordered,
			seen: ordered.length,
			top: ordered.slice(0, 3).map((c) => c.candidate_id),
			head: ordered[0],
			accountScoped: true,
		},
	};
}

/** One row vs the context: the pin (adapter exact or host contains), the
 *  class provider globs (adapter OR host), the class group globs. */
function rowInScope(row: CandidateRow, acct: AcctContext): boolean {
	const host = hostOf(row);
	if (acct.pin !== null && !pinMatches(row.dep.adapter, host, acct.pin))
		return false;
	// Allowlist = ADAPTER axis only (W1265.2): a loopback host must never
	// smuggle an enterprise row past a personal allowlist — unknown adapter
	// rows refuse. The deny axis stays broad (adapter OR host).
	if (
		acct.allowedHosts !== null &&
		!acct.allowedHosts.some((g) => globMatch(g, row.dep.adapter ?? "", true))
	)
		return false;
	// W1265.2 deny axis: the class must never reach these providers (the
	// general default denies the enterprise adapter — no crossover).
	if (
		acct.deniedHosts?.some(
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

/** W1265.2 discovery binding (GET/HEAD /v1/models): resolveClass's key→class
 *  + lane-slug + verified-claim contract minus the group entitlement (a
 *  listing is not an inference request); groups = the caller's listing
 *  filter (null = unrestricted). Inert doc or root = unfiltered. */
export function discoveryFilter(
	doc: AccountPolicyDoc | null | undefined,
	input: {
		kind?: string | null;
		keyName: string | null;
		claimRepo: string | null;
		lane: string | null;
	},
): { ok: true; groups: string[] | null } | { ok: false; status: 403; code: string; why: string } {
	if (doc === null || doc === undefined) return { ok: true, groups: null };
	if (input.kind === "root") return { ok: true, groups: null };
	const key = input.keyName;
	if (key === null)
		return { ok: false, status: 403, code: "buckle.repo_unknown", why: "key (unnamed) binds no repo class — refused before listing" };
	const hit = classFor(doc, key);
	if (hit === null)
		return { ok: false, status: 403, code: "buckle.repo_unknown", why: `key '${key.slice(0, 48)}' binds no repo class — refused before listing` };
	if (input.lane !== null && input.lane !== "" && input.lane !== key)
		return { ok: false, status: 403, code: "buckle.lane_bind_mismatch", why: `lane slug '${input.lane.slice(0, 64)}' does not match the authenticated session key — refused before listing` };
	if (
		hit.cls.general !== true &&
		(hit.cls.repos ?? []).length > 0 &&
		input.claimRepo === null
	)
		return { ok: false, status: 403, code: "buckle.repo_unverified", why: `class '${hit.cls.id}' is repo-bound — a verified x-klh-repo claim is required before listing` };
	if (
		input.claimRepo !== null &&
		!(hit.cls.repos ?? []).some((p) => globMatch(p, input.claimRepo))
	)
		return { ok: false, status: 403, code: "buckle.repo_claim_mismatch", why: "x-klh-repo claim does not match the key's bound repo class — refused (spoofed or stale claim)" };
	return { ok: true, groups: hit.cls.groups ?? null };
}

/** W1265.2 prefer precedence: the soft ranking may only ever NAME a
 *  permitted candidate. scopeSelection confines ordered to the entitled
 *  domain (stable order — the ranking survives) but the decide-time audit
 *  (head/fit/decision/why) describes the UNSCOPED head, which the boundary
 *  may have filtered — refresh it so the audit never advertises a forbidden
 *  candidate. must= needs no pass: its ordered holds full fits only, so the
 *  scope filter preserves must semantics (unsatisfiable = scoped-to-zero
 *  refusal, zero outbound). */
export function preferAfterScope(sel: RouteSelection, hint: RouteHint | null): RouteSelection {
	if (sel.accountScoped !== true || hint === null || sel.verb !== "prefer")
		return sel;
	const head = sel.ordered[0];
	if (head === undefined) return sel;
	const total = hintTotal(hint);
	const fit = hintFit(
		{
			kind: head.kind,
			machine: head.host,
			model: head.model,
			tags: head.capability_text,
		},
		hint,
	);
	return {
		...sel,
		head,
		fit,
		decision: fit < total ? "degraded" : sel.decision,
		why: `hint (account-scoped): ${head.candidate_id} (${head.kind}) fit ${String(fit)}/${String(total)} — ranked within the entitled domain only`,
	};
}

/** The W1265.2 mandatory default: absent operator config still gives a
 *  SAFE explicit general-work class — any NAMED key rides the personal/
 *  local ALLOWLIST only (zai, openrouter, loopback/.local swarm rows);
 *  unknown and enterprise rows refuse. Anonymous traffic refuses. Never a
 *  silent inert posture. */
export function defaultAccountPolicy(): {
	doc: AccountPolicyDoc;
	source: string;
} {
	return {
		doc: {
			version: 1,
			classes: [
				{
					id: "general",
					tier: "general",
					general: true,
					keys: ["*"],
					// adapter-axis allowlist — personal providers only; unknown
					// and enterprise adapters refuse (no crossover, no
					// implicit provider switch on general traffic)
					providers: ["zai", "openrouter"],
				},
			],
		},
		source: "default:general",
	};
}

/** Resolution chain: explicit → BUCKLE_REPO_TIER_POLICY → the runtime copy
 *  in ~/.claude/local-llm/ → the MANDATORY general default (W1265.2 — never
 *  inert). `BUCKLE_REPO_TIER_POLICY=off` is the one explicit disable. A
 *  CONFIGURED path that is missing or malformed is startup fatal (fail
 *  closed, never silently disabled). */
export function loadAccountPolicy(explicitPath?: string): {
	doc: AccountPolicyDoc | null;
	source: string;
} {
	if (process.env.BUCKLE_REPO_TIER_POLICY === "off")
		return { doc: null, source: "off" };
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
	return defaultAccountPolicy();
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
