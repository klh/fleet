// src/trace-url.ts — W2268 clickable error traces. The bounded
// trace_id/error-hop contract gains one client affordance: a details URL the
// Fleet console serves. The base is operator config (BUCKLE_TRACE_URL_BASE),
// provider-neutral, HTTPS or loopback HTTP only — never a provider URL, never
// a fabricated page. Encoding is deterministic: percent-encoding comes from
// the URL API itself and the trace id is charset-checked, so no client can
// steer path or query content.
const TRACE_ID = /^[0-9a-f]{32}$/;
const MAX_BASE_BYTES = 512;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const isLoopbackHostname = (host: string): boolean =>
	LOOPBACK_HOSTS.has(
		host
			.trim()
			.toLowerCase()
			.replace(/^\[(.*)\]$/, "$1"),
	);

/** True when the origin is an acceptable details-page host: HTTPS anywhere,
 * plain HTTP only on loopback (the console perimeter guards the page). */
function acceptableOrigin(url: URL): boolean {
	if (url.protocol === "https:") return true;
	if (url.protocol !== "http:") return false;
	return isLoopbackHostname(url.hostname);
}

/** The configured base URL or null when unconfigured/invalid — inert by
 *  default, exactly like the other provider-neutral knobs. */
export function traceUrlBase(env: NodeJS.ProcessEnv = process.env): URL | null {
	const raw = env.BUCKLE_TRACE_URL_BASE;
	if (!raw || raw.length === 0) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (raw.length > MAX_BASE_BYTES || !acceptableOrigin(url)) return null;
	if (url.username || url.password || url.search || url.hash) return null;
	return url;
}

/** The deep link for a trace, or null when no base is configured. */
export function traceUrl(
	traceId: string,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (!TRACE_ID.test(traceId)) return null;
	const base = traceUrlBase(env);
	if (!base) return null;
	// Deterministic: fixed pathname, the id as the only query param, both
	// produced by the URL API's own encoding — no hand-built concatenation.
	const url = new URL(base);
	url.pathname = `${base.pathname.replace(/\/+$/, "")}/console/trace`;
	url.searchParams.set("trace_id", traceId);
	return url.toString();
}
