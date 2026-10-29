// http-citizenship.ts — W155.3: belt's own endpoints code to the fleet HTTP
// citizenship standard (suspenders docs/design/http-citizenship.md):
// OPTIONS → 204 + Allow, 405 + Allow on known paths (problem+json bodies),
// strong ETag + 304 on GET-able JSON, and the rate-limit trio (IETF draft +
// de-facto families) on the authenticated /api/route. Pure helpers plus a
// method gate; dashboard.ts owns the routes and passes its method map in —
// one source of truth, no route table duplicated here.

// ─── problem+json (RFC 9457) — error bodies for the gate and the limiter ───
// W1081: every problem envelope names its emitter — x-klh-service is fixed
// (belt owns this module), callers pass more identity via `headers`.
import {
	stampHopHeaders,
	stampResponse,
} from "@klh/telemetry/src/http-trace.ts";

// W1471: belt's ONE citizenship stamp for the kernel servicemon `stamp`
// seam (model-store) — re-exported here so the telemetry edge stays single.
export { stampResponse };

/** The W2258 origin-qualified error prefix: `belt: <hub>.belt.<code> — `.
 *  Every belt-generated client-visible error detail starts with it (the
 *  router-shim's direct errors included). Hub rides BELT_HUB_ID; an
 *  unconfigured/degenerate hub label stays bounded ("local"). */
export const beltOriginPrefix = (code: string): string => {
	const configuredHub = process.env.BELT_HUB_ID;
	const hub =
		configuredHub && /^[A-Za-z0-9][\w.-]{0,63}$/.test(configuredHub)
			? configuredHub
			: "local";
	const safeCode = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(code)
		? code.replace(/^belt\./, "")
		: "problem";
	return `belt: ${hub}.belt.${safeCode} — `;
};

/** The router ladder's upstream-decline envelope: a provider/refusal status
 *  translated to the Anthropic wire with the origin-qualified detail prefix
 *  and the 429 Retry-After pass-through. Lives here (http citizenship, not
 *  router flow) — W2258's decomposition of router-shim.ts. */
export const upstreamDecline = (
	status: number,
	retryAfterMs: number | undefined,
	details: string[],
): Response => {
	const retrySeconds = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000));
	const rateLimited = status === 429;
	return Response.json(
		{
			type: "error",
			error: {
				type: rateLimited ? "overloaded_error" : "api_error",
				message: `${beltOriginPrefix("upstream_error")}router: upstream HTTP ${status} (${details.join("; ")})${rateLimited ? `; retry after ${retrySeconds}s` : ""}`,
			},
		},
		{
			status: rateLimited ? 429 : 502,
			headers: rateLimited ? { "retry-after": String(retrySeconds) } : {},
		},
	);
};

export const problem = (
	status: number,
	title: string,
	code: string,
	detail: string,
	instance: string,
	why?: string,
	headers?: Record<string, string>,
): Response => {
	const prefix = beltOriginPrefix(code);
	const res = new Response(
		JSON.stringify(
			{
				type: "about:blank",
				title,
				status,
				detail: `${prefix}${detail}`,
				instance,
				code,
				...(why ? { why: `${prefix}${why}` } : {}),
			},
			null,
			2,
		),
		{
			status,
			headers: {
				"content-type": "application/problem+json",
				...(headers ?? {}),
			},
		},
	);
	// W1081: refusal codes name the refusing belt face — the envelope is
	// attributable from headers alone (x-klh-refusal = the stable code).
	stampHopHeaders(res.headers, {
		service: "belt",
		hop: "ingress",
		refusal: code.split(".").pop(),
	});
	return res;
};

// ─── method introspection — OPTIONS 204+Allow, off-method 405+Allow ───
export type RouteMethods = Record<string, string[]>;

/** Allow value for a path: its methods plus OPTIONS itself. */
export const allowList = (methods: string[]): string =>
	[...new Set([...methods, "OPTIONS"])].join(", ");

/** 204 + Allow — introspection answers without auth, per the standard. */
export const optionsResponse = (methods: string[]): Response =>
	new Response(null, {
		status: 204,
		headers: { allow: allowList(methods) },
	});

/** 405 + Allow — problem+json body carries the allowed set in `detail`. */
export const methodNotAllowed = (path: string, methods: string[]): Response =>
	problem(
		405,
		"Method Not Allowed",
		"belt.method_not_allowed",
		`allowed: ${allowList(methods)}`,
		path,
		"the path exists but not for this method",
		{ allow: allowList(methods) },
	);

/** Method gate: run FIRST in fetch(). OPTIONS on a known path → 204+Allow;
 *  a known path with a method outside its set → 405+Allow; anything else
 *  (known method, unknown path) returns null = fall through to dispatch. */
export const citizenshipGate = (
	req: Request,
	routes: RouteMethods,
): Response | null => {
	const path = new URL(req.url).pathname;
	const methods = routes[path];
	if (!methods) return null; // unknown path → normal dispatch → 404
	if (req.method === "OPTIONS") return optionsResponse(methods);
	if (methods.includes(req.method)) return null;
	return methodNotAllowed(path, methods);
};

// ─── conditional GET — strong ETag (content hash), weak If-None-Match ───
export const etagOf = (body: string): string =>
	`"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`;

/** If-None-Match weak comparison (RFC 7232 §2.3): the W/ prefix is ignored
 *  and any list entry (or `*`) matches. */
export const ifNoneMatchHits = (
	header: string | null,
	etag: string,
): boolean => {
	if (header === null) return false;
	const bare = etag.replace(/^W\//, "");
	return header
		.split(",")
		.map((t) => t.trim().replace(/^W\//, ""))
		.some((t) => t === "*" || t === bare);
};

/** JSON response with a strong ETag; an If-None-Match hit answers 304 with
 *  the ETag echo and no body (the standard's conditional-GET row). */
export const etagJson = (req: Request, body: string): Response => {
	const etag = etagOf(body);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		etag,
	};
	if (ifNoneMatchHits(req.headers.get("if-none-match"), etag))
		return new Response(null, { status: 304, headers });
	return new Response(body, { status: 200, headers });
};

// ─── rate limiting — fixed 60s window per bearer token on /api/route.
// Budget name `rpm` mirrors the govdb budget shapes (W155 standard). ───
export const WINDOW_MS = 60_000;

export interface RateVerdict {
	ok: boolean;
	/** Both header families, always (the standard's rate-limit rows). */
	headers: Record<string, string>;
	/** Whole seconds until the window resets — set on 429. */
	retryAfter?: number;
}

/** Fixed-window rpm limiter keyed by bearer token. Counts every keyed
 *  request; the window resets lazily on first use after expiry. `now` is
 *  injectable so the window math is testable without sleeping. */
export const rateLimiter = (limit: number, now: () => number = Date.now) => {
	const windows = new Map<string, { count: number; resetAt: number }>();
	return (key: string): RateVerdict => {
		const t = now();
		let w = windows.get(key);
		if (w === undefined || w.resetAt <= t) {
			w = { count: 0, resetAt: t + WINDOW_MS };
			windows.set(key, w);
		}
		w.count += 1;
		const resetIn = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
		const remaining = Math.max(0, limit - w.count);
		const headers: Record<string, string> = {
			"ratelimit-limit": String(limit),
			"ratelimit-remaining": String(remaining),
			"ratelimit-reset": String(resetIn),
			"ratelimit-policy": `rpm;q=${limit}`,
			"x-ratelimit-limit": String(limit),
			"x-ratelimit-remaining": String(remaining),
			"x-ratelimit-reset": String(Math.ceil(w.resetAt / 1000)),
		};
		if (w.count > limit) {
			const retryAfter = resetIn + Math.floor(Math.random() * 3);
			return {
				ok: false,
				retryAfter,
				headers: {
					...headers,
					"ratelimit-remaining": "0",
					"x-ratelimit-remaining": "0",
				},
			};
		}
		return { ok: true, headers };
	};
};
