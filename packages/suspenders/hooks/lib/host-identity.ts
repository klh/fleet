// host-identity.ts — the ONE host-flip normalizer (moved verbatim from
// scripts/lib/launch-fencing.ts; W1232: lane-liveness joins the flip
// contract). macOS flips a host between `.local` and `.localdomain`
// (mDNS/DHCP); the same machine must stay inspectable across the flip or
// its pre-flip launch intents and lane-registry rows read foreign forever
// and the probe collapses to transcript-only trust. Only that exact suffix
// pair normalizes — the pid+birth+argv (launch-fencing) and pid+args+sid
// (lane-liveness) fencing stays the gate.
const normalizeHost = (host: string): string =>
	host.replace(/(?:\.(?:local|localdomain))+$/i, "");

/** Same-machine verdict under the macOS .local/.localdomain flip — shared
 * with launch-fencing (W669.12: one source, controller-fence imports the
 * launch-fencing re-export). */
export const sameMachine = (a: string, b: string): boolean =>
	normalizeHost(a) === normalizeHost(b);
