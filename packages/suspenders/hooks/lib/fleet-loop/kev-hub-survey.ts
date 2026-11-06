// hooks/lib/fleet-loop/kev-hub-survey.ts — W2777: the all-hubs catalog
// survey behind kev-chooses. W2677 read ONE hub's live /v1/models; the
// owner directive (2026-11-06) makes kev weigh the (model, hub) pair across
// ALL machine-conf hubs under per-hub load. The survey enumerates the
// settings.json hub rows (dark-window hubs excluded — W483), times one
// bounded catalog GET per hub, and hands the picker per-hub latency +
// serving evidence. A hub whose catalog is unavailable is DOWN evidence —
// never picked; unknown never blocks (the static pick stands, W1712/W576).
import { hubCredential } from "../lanes/lane-auth.ts";
import { fetchHubCatalog } from "../hub/model-health.ts";
import { hubBuckleUrl } from "../hub/hub-endpoint.ts";
import { darkHubNow, loadStack } from "../stack-config.ts";

/** One bounded catalog read per hub per launch attempt (W779 parity). */
export const KEV_HUB_SURVEY_TIMEOUT_MS = 3000;

/** One hub's survey row. `offerings` null = catalog unavailable — the hub
 *  is down as far as this pick is concerned and must NOT be chosen. */
export type HubSurvey = {
	label: string;
	url: string;
	offerings: string[] | null;
	/** Wall time of the catalog GET itself — the freshest hub-latency
	 *  signal, measured on the launch path. */
	latencyMs: number | null;
};

/** A launch-ready hub row: label + front url + credential. */
export type HubEntry = { label: string; url: string; key: string | null };

/** The machine-conf hub rows (settings.json hubs projected through
 *  stackFromSettings). Dark-window hubs are expected down (W483) and never
 *  surveyed; no/bad conf degrades to zero hubs — the local belt ladder
 *  keeps owning routing, kev-chooses never invents a destination. */
export const confHubEntries = (
	env: NodeJS.ProcessEnv = process.env,
): HubEntry[] => {
	const out: HubEntry[] = [];
	try {
		for (const [label, prof] of Object.entries(loadStack().hubs)) {
			const url = hubBuckleUrl(prof);
			if (!url || darkHubNow(label)) continue;
			out.push({ label, url, key: hubCredential(label, env) });
		}
	} catch {
		// no/bad settings.json — no hubs to survey
	}
	return out;
};

/** Survey every hub entry in parallel — one bounded GET each, wall-timed.
 *  `entries`/`fetchCatalog` are injectable for tests (serveStub seam). */
export const surveyHubCatalogs = async (o?: {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	entries?: HubEntry[];
	fetchCatalog?: (
		url: string,
		key: string | null,
		timeoutMs: number,
	) => Promise<string[] | null>;
}): Promise<HubSurvey[]> => {
	const entries = o?.entries ?? confHubEntries(o?.env);
	const fetchCatalog = o?.fetchCatalog ?? fetchHubCatalog;
	return Promise.all(
		entries.map(async (e) => {
			const t0 = Date.now();
			const offerings = await fetchCatalog(
				e.url,
				e.key,
				o?.timeoutMs ?? KEV_HUB_SURVEY_TIMEOUT_MS,
			);
			return {
				label: e.label,
				url: e.url,
				offerings,
				latencyMs: Date.now() - t0,
			};
		}),
	);
};
