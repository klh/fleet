// src/trace.ts — W3C Trace Context helpers (W461 stage 1): traceparent
// parse/build plus the Fleet baggage allowlist. Correlation only — a trace
// id is never identity, authz or a credential (upstream-observability-
// architecture.md §1). Baggage is allowlisted at ingress and NEVER leaves
// the trust boundary: redaction at external-provider egress is by
// construction in wire.ts (only the traceparent rides the upstream leg).
import { randomBytes } from "node:crypto";

/** A valid W3C traceparent in canonical lowercase wire form. */
const TRACEPARENT_RE = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

/** Fleet extension keys — the only baggage entries that may ride a trusted
 *  hop (doc §1: allowlisted baggage carries non-sensitive correlation
 *  hints; never permissions, never credentials). */
export const FLEET_BAGGAGE_ALLOWLIST: readonly string[] = [
	"fleet.lane.id",
	"fleet.project.id",
	"fleet.hub.id",
	"fleet.origin.hub.id",
	"fleet.peer.hub.id",
];

/** The request-scoped trace context threaded from ingress to each outbound
 *  attempt. `traceparent` is the inbound (or root) traceparent; `baggage`
 *  the allowlisted subset (null = none). */
export interface TraceContext {
	traceparent: string;
	baggage: string | null;
}

/** Valid traceparent → canonical lowercase; anything else (garbage, all-zero
 *  ids, forbidden version ff) → null. Malformed input NEVER propagates. */
export function parseTraceparent(v: string | null | undefined): string | null {
	if (!v) return null;
	const s = v.trim().toLowerCase();
	if (!TRACEPARENT_RE.test(s)) return null;
	const [, trace, parent] = s.split("-");
	if (/^0+$/.test(trace) || /^0+$/.test(parent)) return null;
	if (s.startsWith("ff-")) return null;
	return s;
}

function randomHex(n: number): string {
	return randomBytes(n).toString("hex");
}

/** Fresh root traceparent (16-byte trace id, 8-byte span id, sampled flag). */
export function newTraceparent(): string {
	return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** One child attempt of `parent`: same trace id, FRESH span id — per-hop
 *  and per-outbound-attempt identities are distinct (OTel HTTP resend
 *  ordinals). Invalid/absent parent roots a fresh trace. */
export function childSpanOf(parent: string | null | undefined): string {
	const p = parseTraceparent(parent);
	if (!p) return newTraceparent();
	const [version, trace, , flags] = p.split("-");
	return `${version}-${trace}-${randomHex(8)}-${flags}`;
}

/** Parse a baggage header value and keep only allowlisted fleet.* keys.
 *  Value text rides verbatim (correlation hints, length-bounded); anything
 *  unparseable is dropped whole. null = nothing to carry. */
export function allowlistedBaggage(
	v: string | null | undefined,
): string | null {
	if (!v) return null;
	const kept: string[] = [];
	for (const pair of v.split(",")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const key = pair.slice(0, eq).trim();
		if (!(FLEET_BAGGAGE_ALLOWLIST as readonly string[]).includes(key)) continue;
		const value = pair
			.slice(eq + 1)
			.split(";")[0]
			.trim();
		if (value.length === 0) continue;
		kept.push(`${key}=${value}`);
	}
	return kept.length > 0 ? kept.join(",") : null;
}

/** Egress redaction: delete trust-boundary-private trace headers from a
 *  wire header set headed OUT of the fleet (providers see traceparent only). */
export function stripPrivateTrace(h: Record<string, string>): void {
	delete h.baggage;
}
