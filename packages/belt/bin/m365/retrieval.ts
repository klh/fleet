// bin/m365/retrieval.ts — Microsoft Graph Retrieval API grounding client for
// the belt M365 custom-engine agent (W261). Delegated-user tokens only
// (entra-auth.ts); results are scoped to the calling user's M365 content.
// WIRE SHAPE: the /copilot/retrieval request+response shape is encoded in
// retrievalRequestBody()/normalizeHits() — the ONLY places to adjust if the
// tenant reports drift. Unverified against a live tenant (docs/m365-agent.md).
import { getDelegatedToken, type EntraConfig } from "./entra-auth.ts";

export interface RetrievalHit {
	resourceType: string;
	url: string;
	title: string;
	snippet: string;
}

export type Grounding =
	| { ok: true; hits: RetrievalHit[] }
	| {
			ok: false;
			reason: "not-configured" | "login-needed" | "http" | "shape";
			status?: number;
			detail?: string;
			hint?: string;
	  };

export interface RetrievalOptions {
	dataSource: string; // sharePoint | oneDrive | exchange (tenant-verify)
	graphBase: string; // default https://graph.microsoft.com
	apiVersion: string; // default beta
}

export function loadRetrievalOptions(
	env: Record<string, string | undefined> = process.env,
): RetrievalOptions {
	return {
		dataSource: env.M365_RETRIEVAL_DATA_SOURCE?.trim() || "sharePoint",
		graphBase: (
			env.M365_GRAPH_BASE?.trim() || "https://graph.microsoft.com"
		).replace(/\/+$/, ""),
		apiVersion: env.M365_GRAPH_API_VERSION?.trim() || "beta",
	};
}

/** The request body, isolated: one grounding request against one source. */
export function retrievalRequestBody(
	query: string,
	dataSource: string,
): unknown {
	return {
		requests: [
			{
				endpoint: "grounding",
				queryString: query,
				dataSource,
			},
		],
	};
}

type UnknownRec = Record<string, unknown>;

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Defensive normalization — field names drift across API versions. */
export function normalizeHits(payload: unknown): RetrievalHit[] {
	const out: RetrievalHit[] = [];
	const responses = ((payload ?? {}) as UnknownRec).responses;
	if (!Array.isArray(responses)) return out;
	for (const resp of responses) {
		const hits = (resp as UnknownRec | null)?.retrievalHits;
		if (!Array.isArray(hits)) continue;
		for (const hit of hits) {
			const h = (hit ?? {}) as UnknownRec;
			out.push({
				resourceType:
					str(h.resourceType) || str(h["@odata.type"]).replace(/^#*/, ""),
				url: str(h.webUrl) || str(h.url),
				title: str(h.displayName) || str(h.name) || str(h.title),
				snippet: str(h.summary) || str(h.snippet),
			});
		}
	}
	return out;
}

async function callRetrieval(
	base: string,
	apiVersion: string,
	token: string,
	body: unknown,
	fetchImpl: typeof fetch,
): Promise<{ status: number; payload: unknown }> {
	const res = await fetchImpl(`${base}/${apiVersion}/copilot/retrieval`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const payload: unknown = await res.json().catch(() => null);
	return { status: res.status, payload };
}

/** Ground a query in the calling user's M365 content. Full chain: delegated
 * token (cache→refresh) → Graph retrieval → normalized hits. */
export async function ground(
	query: string,
	opts: {
		env?: Record<string, string | undefined>;
		cfg?: EntraConfig;
		auth?: Parameters<typeof getDelegatedToken>[0];
		retrieval?: Partial<RetrievalOptions>;
		fetchImpl?: typeof fetch;
	} = {},
): Promise<Grounding> {
	const auth = await getDelegatedToken({
		...opts.auth,
		env: opts.env,
		cfg: opts.cfg,
		fetchImpl: opts.fetchImpl,
	});
	if (!auth.ok) return { ok: false, reason: auth.reason, hint: auth.hint };
	const ro = { ...loadRetrievalOptions(opts.env), ...opts.retrieval };
	const { status, payload } = await callRetrieval(
		ro.graphBase,
		ro.apiVersion,
		auth.token,
		retrievalRequestBody(query, ro.dataSource),
		opts.fetchImpl ?? fetch,
	);
	if (status === 401 || status === 403)
		return {
			ok: false,
			reason: "login-needed",
			status,
			hint: "graph rejected the delegated token — re-login: bun packages/belt/bin/m365/login.ts",
		};
	if (status >= 400)
		return {
			ok: false,
			reason: "http",
			status,
			detail: JSON.stringify(payload).slice(0, 300),
		};
	const hits = normalizeHits(payload);
	if (hits.length === 0 && payload !== null && typeof payload === "object")
		return { ok: true, hits: [] }; // empty is a valid answer, shape ambiguity is not
	return { ok: true, hits };
}
