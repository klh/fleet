// src/ingress-routes.ts — W1265 named-base ingress contract. Additive over
// the legacy bare /v1 paths: wire-named bases /anthropic (Claude Messages)
// and /openai (OpenAI Chat Completions + Responses), each optionally
// provider-pinned (/zai/anthropic, /zai/openai — GLM Coding Plan) and
// composed with the W1 /w/<slug> lane prefix. The guard answers a typed
// local problem+json on method+wire mismatch BEFORE any outbound call; the
// provider pin scopes routing to that catalog provider (dep.adapter) only —
// a pinned route never bridges dialects and never substitutes a foreign
// provider behind the client's back.
import type { AppDeps } from "./handlers.ts";
import type { Dialect } from "./upstreams.ts";
import { lanePrefixOf } from "./citizenship.ts";

/** proxy's shape, passed in from handlers.ts (keeps this module's imports
 *  type-only — no runtime cycle with the handlers module). */
export type IngressProxy = (
	req: Request,
	dialect: Dialect,
	path: string,
	deps: AppDeps,
	lane?: string,
	providerPin?: string,
) => Promise<Response>;

/** Dispatch one parsed named-base request: the guard answers locally first
 *  (typed 4xx, zero outbound), then the standard proxy rides the wire with
 *  the lane slug and the provider pin. */
export async function handleNamedIngress(
	named: NamedIngress,
	req: Request,
	method: string,
	deps: AppDeps,
	proxy: IngressProxy,
): Promise<Response> {
	const guard = namedIngressGuard(named, method);
	if (guard !== null) return guard;
	return proxy(
		req,
		named.wire,
		named.rest,
		deps,
		named.lane,
		named.provider ?? undefined,
	);
}

/** Providers with a pinned named-base face. Data over code: adding one is a
 *  row here plus the pin filter at the decide seam. */
export const INGRESS_PROVIDERS = ["zai"] as const;
export type IngressProvider = (typeof INGRESS_PROVIDERS)[number];

/** A parsed named-base ingress path. lane "" = unprefixed. */
export interface NamedIngress {
	lane: string;
	/** Catalog-provider pin, null = any provider (wire-only named base). */
	provider: IngressProvider | null;
	/** The wire the base name promises — mismatch is a typed 4xx. */
	wire: Dialect;
	/** Path after the named base ("" = bare base root). */
	rest: string;
}

/** /{w/<lane>/}?(zai/)?(anthropic|openai)/… — provider segment BEFORE the
 *  wire segment (the installer's base URLs read provider-then-wire). */
const NAMED_BASE = /^\/(?:(zai)\/)?(anthropic|openai)(\/.*)?$/;

/** Parse a named-base ingress path; null = not a named-base shape (the
 *  legacy route table decides what happens next). */
export function namedIngressOf(path: string): NamedIngress | null {
	const { lane, path: inner } = lanePrefixOf(path);
	const m = NAMED_BASE.exec(inner);
	if (m === null) return null;
	const provider = m[1] === undefined ? null : "zai";
	const wire: Dialect = m[2] === "anthropic" ? "anthropic" : "openai";
	return { lane, provider, wire, rest: m[3] ?? "" };
}

/** The wire paths each named base accepts, with their method sets. Anything
 *  else is a typed local 4xx — a named base never leaks other surfaces. */
export const NAMED_WIRE_PATHS: Record<Dialect, Record<string, string>> = {
	anthropic: {
		"/v1/messages": "POST",
		"/v1/messages/count_tokens": "POST",
		"/v1/models": "GET, HEAD",
	},
	openai: {
		"/v1/chat/completions": "POST",
		"/v1/responses": "POST",
		"/v1/models": "GET, HEAD",
	},
};

/** Method+wire guard for one parsed named-base path: a problem+json Response
 *  on mismatch (404 unknown path / 405 known path wrong method), null = the
 *  request may proxy. Local answers only — zero outbound by construction. */
export function namedIngressGuard(
	named: NamedIngress,
	method: string,
): Response | null {
	const allow = NAMED_WIRE_PATHS[named.wire][named.rest];
	if (allow === undefined) {
		return problem4xx({
			status: 404,
			code: "buckle.wire_mismatch",
			why: `${baseName(named)} serves the ${named.wire} wire only — ${method} ${named.rest || "/"} is not a ${named.wire} path`,
			next: [
				`send ${Object.keys(NAMED_WIRE_PATHS[named.wire]).filter((p) => NAMED_WIRE_PATHS[named.wire][p] === "POST").join(" or ")} on this base`,
				`other wires: use the matching named base (/anthropic, /openai)`,
			],
		});
	}
	if (!allow.split(", ").includes(method)) {
		return problem4xx({
			status: 405,
			code: "buckle.method_not_allowed",
			why: `${baseName(named)} allows: ${allow}`,
			headers: { allow },
		});
	}
	return null;
}

const baseName = (named: NamedIngress): string =>
	`${named.provider === null ? "" : `/${named.provider}`}/${named.wire}`;

/** Minimal problem+json builder for the guard (mirrors citizenship.problem's
 *  shape without importing the admin-facing header stamping). */
function problem4xx(input: {
	status: 404 | 405;
	code: string;
	why: string;
	next?: string[];
	headers?: Record<string, string>;
}): Response {
	const h = new Headers({ "content-type": "application/problem+json" });
	for (const [k, v] of Object.entries(input.headers ?? {})) h.set(k, v);
	return new Response(
		JSON.stringify({
			type: `/problems/${input.status === 404 ? "not_found" : "method_not_allowed"}`,
			title: input.status === 404 ? "Not Found" : "Method Not Allowed",
			status: input.status,
			detail: input.why,
			code: input.code,
			why: input.why,
			...(input.next === undefined ? {} : { agent_next_steps: input.next }),
		}),
		{ status: input.status, headers: h },
	);
}
