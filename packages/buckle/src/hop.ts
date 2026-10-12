// src/hop.ts — W706 hop attribution: verified origin hub vs immediate peer,
// so a relayed request bills once. The baggage header is the carrier (the
// fleet allowlist in trace.ts gates the keys); a relaying hub stamps
// origin (its own id when the request entered the fleet there, else the
// received origin passed through) + peer (its own id). The hub that sees NO
// peer marker is the origin — the designated billing source; every
// downstream hop marks its audit row forwarded. Marker trust is the
// transport: fleet-internal legs are buckle-marked deployments (config-over-
// code) and authenticated; baggage never rides external-provider egress.
export const ORIGIN_BAGGAGE_KEY = "fleet.origin.hub.id";
export const PEER_BAGGAGE_KEY = "fleet.peer.hub.id";

/** What this hop received: the verified origin and the immediate peer that
 *  forwarded the leg. peer = null → the request entered the fleet here
 *  (this hub is the origin and the designated billing source). */
export interface HopContext {
	origin: string;
	peer: string | null;
}

/** The ledger hop marker (route_audit.hop): 'origin' rows are billable;
 *  'forwarded' rows are per-hop evidence, never billed again. */
export type HopKind = "origin" | "forwarded";

export function hopKindOf(hop: HopContext): HopKind {
	return hop.peer === null ? "origin" : "forwarded";
}

/** Read the hop marker off already-allowlisted baggage (W3C list format).
 *  Values are opaque hub ids — recorded verbatim, length-bounded. */
export function hopFromBaggage(baggage: string | null | undefined): HopContext {
	let origin = "";
	let peer: string | null = null;
	if (baggage) {
		for (const pair of baggage.split(",")) {
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const key = pair.slice(0, eq).trim();
			const value = pair
				.slice(eq + 1)
				.split(";")[0]
				.trim()
				.slice(0, 128);
			if (key === ORIGIN_BAGGAGE_KEY && value) origin = value;
			else if (key === PEER_BAGGAGE_KEY && value) peer = value;
		}
	}
	return { origin, peer };
}

/** The outbound baggage for a relay leg to a buckle peer: the origin passes
 *  through (self when none was received) and the peer seat is claimed. Other
 *  allowlisted entries are preserved. */
export function hopBaggageOf(
	baggage: string | null | undefined,
	self: string,
): string {
	const origin = hopFromBaggage(baggage).origin || self;
	const kept: string[] = [];
	if (baggage) {
		for (const pair of baggage.split(",")) {
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const key = pair.slice(0, eq).trim();
			if (key === ORIGIN_BAGGAGE_KEY || key === PEER_BAGGAGE_KEY) continue;
			kept.push(pair.trim());
		}
	}
	kept.push(`${ORIGIN_BAGGAGE_KEY}=${origin}`);
	kept.push(`${PEER_BAGGAGE_KEY}=${self}`);
	return kept.join(",");
}
