import { readFileSync } from "node:fs";

/** W1040 — provider inference probe state: a TTL-bounded record of the last
 *  outside-process inference attempt per provider, read separately from
 *  catalog reachability and recent Buckle traffic. Green ("ok") is reserved
 *  for a verified usable completion; billing and quota exhaustion, auth
 *  failure, expired ("stale") and never-probed ("untested") stay distinct.
 *  No provider or model is special-cased here — everything derives from the
 *  probe file the CLI writes and the machine config it was derived from. */

export type InferenceProbeVerdict =
	| "ok"
	| "billing"
	| "quota"
	| "auth"
	| "failed";

export type InferenceProbeDisplayState =
	| InferenceProbeVerdict
	| "stale"
	| "untested";

export interface InferenceProbeRecord {
	state: InferenceProbeVerdict;
	checkedAt: number; // epoch ms of the probe attempt
	expiresAt: number; // checkedAt + TTL — past this the state reads stale
	latencyMs: number | null;
	model: string; // wire model id the probe rode
	detail: string; // one-line human explanation
	httpStatus: number | null;
}

/** Persisted feed: ${HOME}/.cache/klh/belt/inference-probe.json */
export interface InferenceProbeFeed {
	ts: number;
	providers: Record<string, InferenceProbeRecord>;
}

export const inferenceProbePath = (home = process.env.HOME ?? ""): string =>
	`${home}/.cache/klh/belt/inference-probe.json`;

const BILLING_SIGNALS = [
	"insufficient",
	"billing",
	"credit",
	"balance",
	"arrears",
	"payment",
];

/** Classify one probe outcome from its HTTP status and response body.
 *  Billing vs quota exhaustion are distinct verdicts: a body that names the
 *  money side (credit/balance/insufficient) is billing; any other 429 is
 *  quota. 401/403 are auth. Everything else non-2xx (and 2xx without usable
 *  content) is failed. Pure — unit-tested without any network. */
export function classifyInferenceProbe(
	status: number,
	body: string,
): InferenceProbeVerdict {
	if (status >= 200 && status < 300) {
		return body.trim().length > 0 ? "ok" : "failed";
	}
	if (status === 401 || status === 403) return "auth";
	if (status === 429) {
		const hay = body.toLowerCase();
		return BILLING_SIGNALS.some((signal) => hay.includes(signal))
			? "billing"
			: "quota";
	}
	return "failed";
}

/** Read-side projection: the written verdict stands only until expiresAt;
 *  past it the state is "stale" (the probe is old, not the provider down).
 *  Absent and unreadable feeds project to "untested" — never to green. */
export function projectInferenceState(
	record: InferenceProbeRecord | undefined,
	now: number,
): InferenceProbeDisplayState {
	if (!record) return "untested";
	return record.expiresAt > now ? record.state : "stale";
}

export function readInferenceProbeFeed(
	path: string,
	now: number,
): Record<string, InferenceProbeRecord> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as InferenceProbeFeed;
		if (
			typeof parsed?.ts !== "number" ||
			parsed.ts <= now - 24 * 60 * 60_000 ||
			typeof parsed.providers !== "object" ||
			parsed.providers === null
		)
			return {};
		return parsed.providers;
	} catch {
		return {};
	}
}
