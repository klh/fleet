// hooks/board/routes-federation.ts — W171: /federation-usage — the GLOBAL
// usage/aid dashboard. The board fetches the hub-stored rollups
// server-side (GET /federation/usage, hub-admin credential from the
// operator env — the browser never sees the key). Honest degradation:
// unset env → explanatory page; hub down → same page with the reason;
// both truthful about default-OFF.
import { federationUsagePage } from "../bin/federation-usage-html.ts";
import { readCapped } from "../lib/federation.ts";

type ClassCell = {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
};

interface HubReport {
	days: number;
	spokes: number;
	windows: Array<{
		bucket: number;
		team: string;
		spoke: string;
		classes: Record<string, ClassCell>;
	}>;
	aids: Array<{
		bucket: number;
		team: string;
		spoke: string;
		aid: string;
		domain: string;
		injected: number;
		skipped: number;
		tok_injected: number;
	}>;
}

/** Server-side fetch of the hub rollups; error string on any failure. */
async function fetchHubReport(
	hubUrl: string,
	token: string,
	days: number,
): Promise<{ ok: true; report: HubReport } | { ok: false; why: string }> {
	try {
		const res = await fetch(`${hubUrl}/federation/usage?days=${String(days)}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(4000),
		});
		if (!res.ok)
			return { ok: false, why: `hub answered ${String(res.status)}` };
		const body = await readCapped(res, 4 * 1024 * 1024);
		return { ok: true, report: body as unknown as HubReport };
	} catch (e) {
		return { ok: false, why: String(e) };
	}
}

function page(report: HubReport, degraded: string | null): Response {
	return new Response(federationUsagePage(report, { degraded }), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** The dashboard route. Returns null when the path is not ours (the board's
 *  handler list tries each route module in order). */
export async function handleFederationUsage(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname !== "/federation-usage") return null;
	void req;
	const d = Number(url.searchParams.get("days") ?? 28) || 28;
	const days = Math.min(90, Math.max(1, d));
	const hubUrl = (
		process.env.FEDERATION_HUB_URL ??
		process.env.BUCKLE_HUB_URL ??
		""
	).replace(/\/$/, "");
	const token =
		process.env.FEDERATION_HUB_TOKEN ?? process.env.BUCKLE_ADMIN_KEY ?? "";
	if (hubUrl.length === 0)
		return page(
			{ days, spokes: 0, windows: [], aids: [] },
			"FEDERATION_HUB_URL (or BUCKLE_HUB_URL) is not set on the board host — hub rollups live only on the hub; set the env and reload",
		);
	if (token.length === 0)
		return page(
			{ days, spokes: 0, windows: [], aids: [] },
			"admin-token env (FEDERATION_HUB_TOKEN / BUCKLE_ADMIN_KEY) is not set on the board host",
		);
	const out = await fetchHubReport(hubUrl, token, days);
	if (!out.ok) return page({ days, spokes: 0, windows: [], aids: [] }, out.why);
	return page(out.report, null);
}
