// src/outbound-guard.ts — W1257.1 configurable outbound egress guard. A
// deployment may declare outbound URL paths its credential must never fetch
// (config-over-code: the Z.ai Coding Plan seat blocks the general
// /api/paas/v4 inference endpoint while a general key keeps it — never a
// hardcoded all-keys ban). The guard runs in defaultFetch AFTER the
// adapter-built URL (post path_rewrite) and BEFORE fetch: a blocked attempt
// throws OutboundBlockedError before any network side effect, naming the
// Coding Plan destination for the request's actual wire — the ingress POST
// path decides the wire, never request headers.
import { RouterError } from "./adapters/errors.ts";
import type { Deployment } from "./upstreams.ts";

/** The ingress wires a refusal can name, keyed by POST path (handlers.ts
 *  routes /v1/messages* → anthropic; /v1/chat/completions and
 *  /v1/responses → openai). */
export type GuardWire = "anthropic" | "openai" | "responses";

/** adapter_config.blocked_outbound key. */
export type GuardCorrections = Partial<Record<GuardWire, string>>;

/** adapter_config.blocked_outbound — operator data, never code. */
export interface BlockedOutboundConfig {
	/** Blocked outbound URL-path prefixes, matched against the BUILT
	 *  outbound pathname (after path_rewrite). */
	paths: string[];
	/** Destination URL the refusal names per wire — full URLs, so the error
	 *  URL always matches the actual wire. */
	corrections: GuardCorrections;
}

const WIRE_OF_PATH: ReadonlyArray<readonly [string, GuardWire]> = [
	["/v1/messages", "anthropic"],
	["/v1/responses", "responses"],
	["/v1/chat/completions", "openai"],
] as const;

const WIRE_LABEL: Record<GuardWire, string> = {
	anthropic: "Anthropic Messages",
	openai: "OpenAI Chat Completions",
	responses: "OpenAI Responses",
};

/** The wire a refusal must name, from the ingress POST path. */
export function guardWireOfPath(path: string): GuardWire {
	for (const [prefix, wire] of WIRE_OF_PATH) {
		if (path === prefix || path.startsWith(`${prefix}/`)) return wire;
	}
	return "openai";
}

/** A blocked outbound attempt: thrown before any network call. kind
 *  bad_request is non-retryable — the ladder benches the rung and walks on
 *  instead of retrying the blocked endpoint. */
export class OutboundBlockedError extends RouterError {
	readonly builtUrl: string;
	readonly wire: GuardWire;
	/** This wire's Coding Plan destination (null when the operator declared
	 *  no correction for it). */
	readonly correction: string | null;

	constructor(
		group: string,
		builtUrl: string,
		wire: GuardWire,
		correction: string | null,
		corrections: GuardCorrections,
	) {
		super(
			"bad_request",
			400,
			renderGuardMessage(group, builtUrl, wire, correction, corrections),
		);
		this.builtUrl = builtUrl;
		this.wire = wire;
		this.correction = correction;
	}
}

function renderGuardMessage(
	group: string,
	builtUrl: string,
	wire: GuardWire,
	correction: string | null,
	corrections: GuardCorrections,
): string {
	const lead = correction
		? `${WIRE_LABEL[wire]} requests belong on ${correction}`
		: `no correction configured for the ${WIRE_LABEL[wire]} wire`;
	const others = (Object.entries(corrections) as Array<[GuardWire, string]>)
		.filter(([w]) => w !== wire)
		.map(([w, url]) => `${WIRE_LABEL[w]}: ${url}`)
		.join(" · ");
	const tail = others.length > 0 ? `; other wires: ${others}` : "";
	return `buckle outbound guard: ${builtUrl} is blocked for this credential (group ${group}) — ${lead}${tail}`;
}

/** The configured guard on one deployment, defensively narrowed (the shape
 *  is validated at pool load; a permissive read keeps odd mounts inert). */
function guardConfigOf(dep: Deployment): BlockedOutboundConfig | null {
	const raw = dep.adapter_config?.blocked_outbound;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const paths = (raw as { paths?: unknown }).paths;
	const corrections = (raw as { corrections?: unknown }).corrections;
	if (
		!Array.isArray(paths) ||
		paths.some((p) => typeof p !== "string") ||
		!corrections ||
		typeof corrections !== "object"
	)
		return null;
	return {
		paths: paths as string[],
		corrections: corrections as GuardCorrections,
	};
}

/** Check the BUILT outbound URL (post path_rewrite) against the
 *  deployment's blocked paths. Returns the typed error to throw, or null
 *  when the attempt may proceed. `path` = the ingress POST path. */
export function outboundBlockOf(
	dep: Deployment,
	path: string,
	builtUrl: string,
): OutboundBlockedError | null {
	const cfg = guardConfigOf(dep);
	if (!cfg || cfg.paths.length === 0) return null;
	let u: URL;
	try {
		u = new URL(builtUrl);
	} catch {
		return null;
	}
	const hit = cfg.paths.some(
		(prefix) =>
			u.pathname === prefix ||
			(prefix.endsWith("/") && u.pathname.startsWith(prefix)) ||
			(!prefix.endsWith("/") && u.pathname.startsWith(`${prefix}/`)),
	);
	if (!hit) return null;
	const wire = guardWireOfPath(path);
	const correction = cfg.corrections[wire] ?? null;
	return new OutboundBlockedError(
		dep.group,
		builtUrl,
		wire,
		correction,
		cfg.corrections,
	);
}

/** Startup-fatal guard-config validation (pool load): malformed rows fail
 *  closed naming the group, like the egress law before it. */
export function validateOutboundGuardConfig(
	adapter_config?: Record<string, unknown>,
): void {
	const raw = adapter_config?.blocked_outbound;
	if (raw === undefined) return;
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("blocked_outbound must be an object (paths + corrections)");
	const { paths, corrections } = raw as {
		paths?: unknown;
		corrections?: unknown;
	};
	if (
		!Array.isArray(paths) ||
		paths.length === 0 ||
		paths.some((p) => typeof p !== "string" || !p.startsWith("/") || !p.trim())
	)
		throw new Error(
			"blocked_outbound.paths must be a non-empty array of absolute path prefixes",
		);
	if (
		!corrections ||
		typeof corrections !== "object" ||
		Array.isArray(corrections)
	)
		throw new Error(
			"blocked_outbound.corrections must be an object keyed by wire",
		);
	for (const [wire, url] of Object.entries(corrections)) {
		if (!(wire in WIRE_LABEL) || typeof url !== "string")
			throw new Error(
				`blocked_outbound.corrections.${wire}: key must be anthropic|openai|responses with a URL string value`,
			);
		try {
			const u = new URL(url);
			if (u.protocol !== "https:" && u.protocol !== "http:")
				throw new Error("scheme");
		} catch {
			throw new Error(
				`blocked_outbound.corrections.${wire} must be an absolute http(s) URL`,
			);
		}
	}
}
