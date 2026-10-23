// http-citizenship.ts — belt's face of the shared HTTP-citizenship kit
// (packages/telemetry/src/http-kit.ts, W1238.5): problem+json via the kit's
// ONE builder (belt identity: service belt, hop ingress), conditional GET
// re-exported from the kit, and the rate-limit trio on the authenticated
// /api/route with the kit's capped Retry-After. The method gate stays local
// — dashboard.ts owns the routes and passes its method map in.

// ─── problem+json (RFC 9457) — error bodies for the gate and the limiter ───
// W1081: every problem envelope names its emitter — x-klh-service is fixed
// (belt owns this module), callers pass more identity via `headers`.
import {
	capRetryAfterS,
	problem as kitProblem,
} from "../../telemetry/src/http-kit.ts";

export const problem = (
	status: number,
	title: string,
	code: string,
	detail: string,
	instance: string,
	why?: string,
	headers?: Record<string, string>,
): Response => {
	const res = kitProblem({
		service: "belt",
		hop: "ingress",
		status,
		code,
		why: why ?? detail,
		detail,
		instance,
		title,
		headers,
	});
	// W1081: refusal codes name the refusing belt face — the kit stamps
	// x-klh-refusal = the stable code's suffix.
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
// W1238.5: the kit owns these now; belt re-exports for its callers.
export {
	etagJson,
	etagOf,
	ifNoneMatchHits,
} from "../../telemetry/src/http-kit.ts";

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
			// the kit's ONE cap rule bounds the jittered reset remainder
			const retryAfter =
				capRetryAfterS(resetIn + Math.floor(Math.random() * 3)) ?? 1;
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
