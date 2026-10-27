// src/aids-routes.ts — W142 aid endpoints on the :4101 shadow. Buckle is
// the enforcement point: it validates, verifies, caps, logs, and skips
// honestly (aids are garnish — an outage must never block a dispatch).
// POST /aids/preseed  {domain, focus?, repo_root, sid?, work_item?}
// GET  /aids/status   — meter totals for dashboards
// GET  /aids/rollup   — hourly govdb-shaped rollup rows (harvest seam)
// Wire path (LLM requests): the x-belt-aids header declares aids per
// request; cache-align runs when declared, AND (W768) the gate emits it
// post-selection for upstreams that honor cache_control — anthropic-family
// rows only; `aids.cache-align.default: "off"` is the operator kill switch.
import { type AidsLedger, parseAids, tokensEstimate } from "./aids.ts";
import { alignBody, alignForUpstream } from "./align.ts";
import { type DietStore, pruneOptsOf, pruneTrajectory } from "./diet.ts";
import type { Expander } from "./expand.ts";
import { RouteTable } from "./http-kit.ts";
import { readBoundedJson } from "./ingress-body.ts";
import type { AidsPolicy } from "./policy.ts";
import type { Preseeder } from "./preseed.ts";
import type { Servicemon } from "./servicemon.ts";
import type { Dialect } from "./upstreams.ts";

export interface AidsDeps {
	aids: AidsLedger;
	preseeder: Preseeder;
	aidsPolicy: AidsPolicy;
	sm: Servicemon;
	/** W4 intent expansion — optional so bare aids deps (tests, dev) skip
	 *  honestly (garnish law) instead of failing the route. */
	expander?: Expander;
	/** W207 diet: the rid-keyed tombstone store. Optional — bare deps skip
	 *  honestly (garnish law) instead of failing the route. */
	diet?: DietStore;
}

type AnyRec = Record<string, unknown>;

/** Meter one decision: ledger row + servicemon counters (an aid that
 *  cannot log does not fire — the counters are the live face of the law). */
function meter(
	deps: AidsDeps,
	ev: {
		aid: string;
		decision: "injected" | "skipped" | "rebuilt";
		skip_reason?: string | null;
		domain?: string;
		repo_root?: string | null;
		sid?: string | null;
		work_item?: string | null;
		packet_id?: string | null;
		served_model?: string;
		tokens_injected?: number;
	},
): void {
	deps.aids.record({ ...ev, ts: Date.now(), basis: undefined });
	deps.sm
		.counter("buckle_aids_decisions_total", "Aid decisions by aid + outcome.")
		.inc({
			aid: ev.aid,
			decision: ev.decision,
			...(ev.skip_reason ? { reason: ev.skip_reason } : {}),
		});
	deps.sm
		.counter(
			"buckle_aids_tokens_injected_total",
			"Estimated tokens injected by aids.",
		)
		.inc({ aid: ev.aid }, ev.tokens_injected ?? 0);
}

function parsePreseedBody(raw: AnyRec): {
	ok: boolean;
	error?: string;
	req?: {
		domain: string;
		focus: string[];
		repo_root: string;
		sid: string | null;
		work_item: string | null;
	};
} {
	const domain = typeof raw.domain === "string" ? raw.domain.trim() : "";
	const repo_root = typeof raw.repo_root === "string" ? raw.repo_root : "";
	if (!domain || !repo_root)
		return { ok: false, error: "domain and repo_root are required" };
	const focus = Array.isArray(raw.focus)
		? raw.focus.filter((f): f is string => typeof f === "string")
		: [];
	return {
		ok: true,
		req: {
			domain,
			focus,
			repo_root,
			sid: typeof raw.sid === "string" ? raw.sid : null,
			work_item: typeof raw.work_item === "string" ? raw.work_item : null,
		},
	};
}

/** POST /aids/preseed — belt calls this at dispatch. Policy is buckle's;
 *  the aids stanza lives in the brief (belt is the policy point). */
export async function aidsPreseed(
	deps: AidsDeps,
	req: Request,
): Promise<Response> {
	const read = await readBoundedJson(req);
	if (!read.ok)
		return Response.json(
			{ ok: false, error: read.why },
			{ status: read.status },
		);
	const raw = read.body as AnyRec;
	const parsed = parsePreseedBody(raw);
	if (!parsed.ok || !parsed.req)
		return Response.json(
			{ ok: false, error: parsed.error ?? "invalid" },
			{ status: 400 },
		);
	const out = await deps.preseeder.preseed(parsed.req);
	meter(deps, {
		aid: "preseed",
		decision: out.decision,
		skip_reason: out.skip_reason ?? null,
		domain: parsed.req.domain,
		repo_root: parsed.req.repo_root,
		sid: parsed.req.sid,
		work_item: parsed.req.work_item,
		packet_id: out.packet_id ?? null,
		tokens_injected: out.bytes ? tokensEstimate(out.bytes) : 0,
	});
	return Response.json({ ok: true, ...out });
}

/** POST /aids/expand — belt's orchestrate-enhance calls this with a goal
 *  (+ optional single-string context) and gets the architectural-wants
 *  digest back, served by the local direct tier (the W288 retarget). */
export async function aidsExpand(
	deps: AidsDeps,
	req: Request,
): Promise<Response> {
	const expander = deps.expander;
	if (!expander)
		return Response.json(
			{ ok: false, error: "expander not configured" },
			{ status: 501 },
		);
	const read = await readBoundedJson(req);
	if (!read.ok)
		return Response.json(
			{ ok: false, error: read.why },
			{ status: read.status },
		);
	const raw = read.body as AnyRec;
	const goal = typeof raw.goal === "string" ? raw.goal : "";
	if (!goal.trim())
		return Response.json(
			{ ok: false, error: "goal is required" },
			{ status: 400 },
		);

	const outcome = await expander.expand({
		goal,
		context: typeof raw.context === "string" ? raw.context : undefined,
		sid: typeof raw.sid === "string" ? raw.sid : null,
		work_item: typeof raw.work_item === "string" ? raw.work_item : null,
	});
	meter(deps, {
		aid: "expand",
		decision: outcome.decision,
		skip_reason: outcome.skip_reason ?? null,
		served_model: outcome.served_model,
		tokens_injected: outcome.bytes ? tokensEstimate(outcome.bytes) : 0,
	});
	return Response.json({ ok: true, ...outcome });
}

/** GET /aids/status — meter totals (the honest immediate metrics: tokens
 *  injected + decision counts; est saved is A/B-derived at dashboard time). */
export function aidsStatus(deps: AidsDeps): Response {
	const s = deps.aids.status();
	deps.aids.rollup(24);
	return Response.json({
		ok: true,
		events: s.n ?? 0,
		injected: s.injected ?? 0,
		skipped: s.skipped ?? 0,
		tok_injected: s.tok_injected ?? 0,
		last_ts: s.last_ts ?? null,
		rollup_rows: deps.aids.rollupRows(24).length,
	});
}

/** GET /aids/rollup?hours=N — govdb-shaped hourly rows. The pull seam for
 *  the suspenders-side harvest (aid-harvest.ts → governor.db aid_rollup). */
export function aidsRollup(deps: AidsDeps, hours: number): Response {
	deps.aids.rollup(24);
	const h = Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 24;
	return Response.json({ ok: true, rows: deps.aids.rollupRows(h) });
}

/** W207: run the `prune` wire aid — DEFAULT-OFF in policy (W137 economics:
 *  a prefix rewrite costs provider KV-cache re-reads; prove ROI on
 *  cache-miss traffic before an operator flips it on). Every outcome is
 *  metered; the pruned body is what rides OUT. */
function applyPrune(
	deps: AidsDeps,
	body: AnyRec,
	dialect: Dialect,
	rid?: string,
): AnyRec {
	const on = deps.aidsPolicy.prune?.default === "on";
	if (!on) {
		meter(deps, { aid: "prune", decision: "skipped", skip_reason: "policy" });
		return body;
	}
	if (!deps.diet) {
		meter(deps, {
			aid: "prune",
			decision: "skipped",
			skip_reason: "unavailable",
		});
		return body;
	}
	const out = pruneTrajectory(body, dialect, pruneOptsOf(deps.aidsPolicy));
	if (out.events.length === 0) {
		meter(deps, { aid: "prune", decision: "skipped", skip_reason: "no_gain" });
		return body;
	}
	body = out.body;
	if (rid) deps.diet.put(rid, dialect, out.events);
	deps.sm
		.counter("buckle_diet_bytes_total", "Bytes elided by diet.")
		.inc({ dialect }, out.bytes_before - out.bytes_after);
	meter(deps, { aid: "prune", decision: "injected", tokens_injected: 0 });
	return body;
}

/** Wire-path aids: called on every proxied request (await it). No
 *  x-belt-aids header → zero touch (pass-through doctrine). The expand
 *  branch (W4) runs the intent expansion pre-routing when declared AND the
 *  policy gate is open — the expanded body is what rides OUT. W207 prune
 *  tombstones stale tool results pre-routing the same way. Returns the
 *  (possibly pruned/aligned) body plus whether W5 inbound condense was
 *  declared (handled sideband on the response — applyWireAids itself never
 *  touches it). */
export async function applyWireAids(
	deps: AidsDeps,
	header: string | null,
	body: AnyRec,
	dialect: Dialect,
	rid?: string,
): Promise<{ body: AnyRec; aligned: boolean; condenseIn: boolean }> {
	const stanza = parseAids(header);
	if (stanza.unknown.length > 0) {
		for (const u of stanza.unknown)
			meter(deps, {
				aid: u,
				decision: "skipped",
				skip_reason: "policy",
			});
	}
	if (stanza.off) return { body, aligned: false, condenseIn: false };
	if (stanza.prune) body = applyPrune(deps, body, dialect, rid);
	if (stanza.expand) {
		// W4 intent expansion: the local direct tier expands the goal before
		// routing; a missing expander is an honest policy skip (garnish law).
		const outcome = deps.expander
			? await deps.expander.expandBody(body, dialect)
			: { decision: "skipped" as const, skip_reason: "policy" as const };
		meter(deps, {
			aid: "expand",
			decision: outcome.decision,
			skip_reason: outcome.skip_reason ?? null,
			served_model: outcome.served_model,
			tokens_injected: outcome.bytes ? tokensEstimate(outcome.bytes) : 0,
		});
	}
	if (stanza.compress) {
		// wired, DEFAULT-OFF (W137 economics): policy forbids → skip, metered
		const on = deps.aidsPolicy.compress?.default === "on";
		meter(deps, {
			aid: "compress",
			decision: "skipped",
			skip_reason: on ? "invalid" : "policy",
		});
	}
	const ca = stanza["cache-align"];
	if (ca && dialect === "anthropic") {
		const aligned = alignBody(body, dialect);
		meter(deps, {
			aid: "cache-align",
			decision: aligned ? "injected" : "skipped",
			skip_reason: aligned ? null : "unsupported",
		});
		if (aligned?.body) {
			return {
				body: aligned.body,
				aligned: true,
				condenseIn: stanza["condense-in"] === true,
			};
		}
	}
	return { body, aligned: false, condenseIn: stanza["condense-in"] === true };
}

/** W768 gate-side cache emission: when the SELECTED upstream honors
 *  cache_control (anthropic-native rows — native prompt caching), the gate
 *  aligns the body without a client declaration; pass-through doctrine yields
 *  exactly where the carrier pays for the markers. openai-compat rows never
 *  receive markers (ZAI context caching is prefix-implicit; copilot unknown);
 *  bridged hops strip them in the body rebuild. `aids.cache-align.default:
 *  "off"` is the operator kill switch; client-declared alignment above still
 *  runs pre-routing. */
export function gateCacheAlign(
	deps: AidsDeps,
	body: AnyRec,
	honors: boolean,
): AnyRec | null {
	if (!honors) return null;
	if (deps.aidsPolicy["cache-align"]?.default === "off") return null;
	const aligned = alignForUpstream(body);
	meter(deps, {
		aid: "cache-align",
		decision: aligned ? "injected" : "skipped",
		skip_reason: aligned ? null : "unsupported",
	});
	return aligned?.body ?? null;
}

// W1303.2: the family dispatch rides the shared kit RouteTable (URLPattern
// matching, automatic HEAD/OPTIONS, 404-vs-405 decided structurally, wrong
// method → 405 problem + Allow). Responses keep the family's ok:true json
// shape — adoption changes the routing law, not the payload grammar.
// Compiled once per deps instance (URLPattern construction is the cost).
const aidsTables = new WeakMap<AidsDeps, RouteTable>();

function aidsTableOf(deps: AidsDeps): RouteTable {
	let t = aidsTables.get(deps);
	if (t !== undefined) return t;
	t = new RouteTable(
		[
			{
				method: "POST",
				pattern: "/aids/preseed",
				handler: ({ req }) => aidsPreseed(deps, req),
			},
			{
				method: "POST",
				pattern: "/aids/expand",
				// bare deps (no expander) 404 honestly — the AppDeps contract
				handler: ({ req }) => (deps.expander ? aidsExpand(deps, req) : null),
			},
			{
				method: "GET",
				pattern: "/aids/status",
				handler: () => aidsStatus(deps),
			},
			{
				method: "GET",
				pattern: "/aids/rollup",
				handler: ({ url }) =>
					aidsRollup(deps, Number(url.searchParams.get("hours") ?? "24")),
			},
			{
				method: "GET",
				pattern: "/aids/events",
				handler: ({ url }) =>
					aidsEvents(deps, Number(url.searchParams.get("since") ?? "0")),
			},
		],
		{ service: "buckle" },
	);
	aidsTables.set(deps, t);
	return t;
}

/** The aids route table, dispatched from createApp (W1303.2: rides the kit
 *  RouteTable). Unknown /aids/* paths fall through (404 from the main
 *  dispatch). */
export async function aidsRoutes(
	deps: AidsDeps,
	req: Request,
): Promise<Response | null> {
	return aidsTableOf(deps).serve(req);
}

/** GET /aids/events?since=MS — raw event pull for the suspenders-side
 *  harvest (governor.db aid_events join seam: sid → sessions → actor). */
function aidsEvents(deps: AidsDeps, since: number): Response {
	const sinceMs = Number.isFinite(since) && since > 0 ? since : 0;
	return Response.json({
		ok: true,
		events: deps.aids.eventsSince(sinceMs),
	});
}
