// hooks/lib/executors/detect.ts — W1731: the ONE ambient client-discovery
// seam. @vercel/detect-agent's determineAgent() reads this process's env;
// the answer canonicalizes onto the executor registry (each adapter's
// `detect` row — no second client list) and the detector's raw name and
// every env value stay inside this file: never returned, logged or stored.
//
// Authority ladder (resolveClient): the registered launch identity — the
// lane.<sid>.executor fact dispatch and the board record at spawn (W620) —
// wins; detection is advisory. It fills in only when no launch identity is
// registered, and a disagreement is reported loudly, never adopted.
// Detection never authorizes, owns, exempts or selects a transcript: it
// only picks which registered reader parses the transcript the session row
// already selected — a wrong pick yields zero runs, so a test-pass claim
// fails closed rather than passing.
import { determineAgent } from "@vercel/detect-agent";
import { adapterFor, adapterForDetected, DEFAULT_ADAPTER } from "./registry.ts";

/** The canonical registry id of the client running this process, or null:
 *  unknown/unregistered detector names, missing signals, a credential with
 *  no runtime marker, and detector errors all answer null. */
export async function detectClient(): Promise<string | null> {
	let name: string | undefined;
	try {
		const result = await determineAgent();
		name = result.isAgent ? result.agent.name : undefined;
	} catch {
		return null;
	}
	const adapter = name ? adapterForDetected(name) : null;
	const markers = adapter?.detect?.markers;
	if (!adapter || (markers && !markers.some((m) => process.env[m]?.trim())))
		return null;
	return adapter.id;
}

/** A registered launch token (executor id, alias, or a belt model pin that
 *  rides claude) → the canonical id, exactly as the launch resolved it. */
export const launchClient = (
	token: string | null | undefined,
): string | null => (token?.trim() ? adapterFor(token.trim()).id : null);

export interface ClientResolution {
	/** Canonical registry id whose evidence reader parses the transcript. */
	client: string;
	source: "launch" | "detected" | "default";
	/** Set when ambient detection disagrees with the launch identity. */
	mismatch: string | null;
}

export function resolveClient(
	launch: string | null,
	detected: string | null,
): ClientResolution {
	if (launch)
		return {
			client: launch,
			source: "launch",
			mismatch:
				detected && detected !== launch
					? `launch identity ${launch} ≠ detected ${detected} (inherited environment?) — launch identity wins`
					: null,
		};
	if (detected) return { client: detected, source: "detected", mismatch: null };
	return { client: DEFAULT_ADAPTER.id, source: "default", mismatch: null };
}
