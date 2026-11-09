// hooks/board/routes-federation.ts — W171: /federation-usage — the GLOBAL
// usage/aid dashboard. The board fetches the hub-stored rollups
// server-side (GET /federation/usage, hub-admin credential from the
// operator env — the browser never sees the key). Honest degradation:
// unset env → explanatory page; hub down → same page with the reason;
// both truthful about default-OFF.

import { createHash, timingSafeEqual } from "node:crypto";
import { federationUsagePage } from "../bin/federation-usage-html.ts";
import { federationWorkPage } from "../bin/federation-work-html.ts";
import { readCapped } from "../lib/federation/federation.ts";
import {
	federatedWorkView,
	filterViewToOwner,
	type GovernorStore,
	localWorkFeed,
} from "../lib/federation/federation-work.ts";
import { tokenOk } from "../lib/host-guard.ts";
import { adminKey } from "../lib/lanes/lane-auth.ts";

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

// ─── W370 federated work view ────────────────────────────────────────────────
// Serve leg: GET /federation/work emits THIS hub's own open work on the
// minimal wire (localWorkFeed — never descriptions, never spoke items).
// Edge auth: SUSPENDERS_FEDERATION_WORK_TOKEN required-bearer when set
// (timing-safe compare); unset = the board perimeter posture (reads open
// within the host guard, like every other console read).
function shaEqual(a: string, b: string): boolean {
	const da = createHash("sha256").update(a).digest();
	const db = createHash("sha256").update(b).digest();
	return timingSafeEqual(da, db);
}

function workFeedAuthorized(req: Request): boolean {
	const expected = process.env.SUSPENDERS_FEDERATION_WORK_TOKEN;
	if (expected === undefined || expected.length === 0) return true;
	const got = (req.headers.get("authorization") ?? "").replace(
		/^Bearer\s+/i,
		"",
	);
	if (got.length === 0) return false;
	return shaEqual(got, expected);
}

// W2878 viewer gate: the board-page VIEWER side (not the hub-to-hub serve
// auth above). Admin = the board's own write-token (W264 host-guard cookie
// or header — "the operator at this board is the authority", the
// observation-serving.ts precedent) OR a presented bearer matching the
// already-configured buckle admin key (belt.env BUCKLE_ADMIN_KEY) — both
// EXISTING credentials, no new token surface. Admin sees every lane
// unfiltered; everyone else may narrow to their own sid (?viewer=<sid>, the
// `work mine --as` idiom) but never widens past it.
function isAdminViewer(req: Request): boolean {
	if (tokenOk(req)) return true;
	const presented = (req.headers.get("authorization") ?? "").replace(
		/^Bearer\s+/i,
		"",
	);
	const expected = adminKey();
	return (
		presented.length > 0 && expected !== null && shaEqual(presented, expected)
	);
}

export async function handleFederationWork(
	req: Request,
	url: URL,
	store?: GovernorStore,
): Promise<Response | null> {
	if (req.method !== "GET") return null;
	if (url.pathname === "/federation/work") {
		if (!workFeedAuthorized(req))
			return Response.json(
				{ error: { code: "unauthorized", message: "belt: bearer required" } },
				{ status: 401 },
			);
		try {
			return Response.json(localWorkFeed({ store }));
		} catch (e) {
			return Response.json(
				{ error: { code: "feed_failed", message: String(e) } },
				{ status: 500 },
			);
		}
	}
	if (
		url.pathname === "/api/federation-work" ||
		url.pathname === "/federation-work"
	) {
		const admin = isAdminViewer(req);
		const viewerSid = url.searchParams.get("viewer");
		let view: Awaited<ReturnType<typeof federatedWorkView>>;
		try {
			view = await federatedWorkView({ store });
		} catch (e) {
			return url.pathname === "/api/federation-work"
				? Response.json(
						{ error: { code: "view_failed", message: String(e) } },
						{ status: 500 },
					)
				: new Response(`federation view failed: ${String(e)}`, {
						status: 500,
					});
		}
		if (!admin && viewerSid) view = filterViewToOwner(view, viewerSid);
		if (url.pathname === "/api/federation-work") return Response.json(view);
		return new Response(
			federationWorkPage(view, {
				hub: url.searchParams.get("hub"),
				viewerSid,
				admin,
			}),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	return null;
}
