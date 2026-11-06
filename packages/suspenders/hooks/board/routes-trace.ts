// hooks/board/routes-trace.ts — W2268 clickable Fleet error traces: the
// /console/trace read-only details page + the /api/trace JSON face. The page
// resolves trace_id through the local Buckle admin API
// (GET /v1/admin/traces) using the SERVER-HELD admin key (belt.env /
// BUCKLE_ADMIN_KEY — lane-auth.ts adminKey()); the browser never sees a
// credential. Every request rides the board's shared W264 perimeter (host
// allowlist on ALL requests, enforced in fleet-board.ts before this handler).
// Unknown / missing / expired traces and an unreachable or erroring Buckle
// all say so honestly — never a fabricated page.

import { consolePage, esc } from "../bin/console-html.ts";
import { adminKey, BUCKLE_FRONT } from "../lib/lanes/lane-auth.ts";
import { consoleMe } from "./console-view.ts";
import { json } from "./helpers.ts";

const TRACE_ID = /^[0-9a-f]{32}$/;
const TRACE_FETCH_TIMEOUT_MS = 4000;

/** One attempt row from Buckle /v1/admin/traces — the subset the page shows. */
interface TraceAttempt {
	rid?: string | null;
	ts?: string | null;
	hop?: string | null;
	status?: number | null;
	refusal?: string | null;
	refusal_origin?: string | null;
	upstream_refusal_code?: string | null;
	provider_error_code?: string | null;
	provider_error_type?: string | null;
	duration_ms?: number | null;
	retry_after_ms?: number | null;
	call_id?: string | null;
	candidate?: string | null;
	provider_pool?: string | null;
	queue_wait_ms?: number | null;
}

/** The Buckle answer states: ok | unreachable | http_error | bad_json. */
type TraceState = "ok" | "unreachable" | "http_error" | "bad_json";

/** The Buckle answer shape (ok | unreachable | http_error | bad_json). */
interface TraceResolve {
	state: TraceState;
	httpStatus?: number;
	body?: Record<string, unknown>;
}

/** Resolve one trace through the server-held admin key. Read-only GET,
 * timeout-bounded; failures degrade to honest states, never fabrications. */
export async function resolveTrace(
	traceId: string,
	fetchFn: typeof fetch = fetch,
	front: string = BUCKLE_FRONT,
	admin: string | null = adminKey(),
): Promise<TraceResolve> {
	let resp: Response;
	try {
		resp = await fetchFn(
			`${front.replace(/\/+$/, "")}/v1/admin/traces?trace_id=${traceId}`,
			{
				method: "GET",
				headers: { authorization: `Bearer ${admin ?? ""}` },
				cache: "no-store",
				signal: AbortSignal.timeout(TRACE_FETCH_TIMEOUT_MS),
			},
		);
	} catch {
		return { state: "unreachable" };
	}
	if (resp.status !== 200)
		return { state: "http_error", httpStatus: resp.status };
	try {
		const parsed: unknown = await resp.json();
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			return { state: "bad_json" };
		return { state: "ok", body: parsed as Record<string, unknown> };
	} catch {
		return { state: "bad_json" };
	}
}

const num = (v: unknown): string =>
	typeof v === "number" && Number.isFinite(v) ? String(v) : "—";

const txt = (v: unknown): string => {
	if (typeof v === "string" && v.length > 0) return esc(v.slice(0, 128));
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return "—";
};

function tracePageTraceId(url: URL): string | null {
	const id = url.searchParams.get("trace_id") ?? "";
	return TRACE_ID.test(id) ? id : null;
}

/** The hop chain rendered from the answer's requests + attempts: request
 *  status/decision rows, then per-attempt timings and refusal source. */
function attemptsTable(attempts: TraceAttempt[]): string {
	if (attempts.length === 0)
		return '<p class="dim">No hop attempts recorded for this trace.</p>';
	const rows = attempts
		.map(
			(a) =>
				`<tr><td class="num">${txt(a.ts)}</td><td>${txt(a.hop)}</td><td class="num">${num(a.status)}</td><td>${txt(a.refusal ?? a.refusal_origin ?? a.upstream_refusal_code)}</td><td>${txt(a.provider_error_code ?? a.provider_error_type)}</td><td class="num">${num(a.duration_ms)}</td><td class="num">${num(a.queue_wait_ms)}</td><td>${txt(a.call_id)}</td></tr>`,
		)
		.join("");
	return `<table class="ct"><thead><tr><th>time</th><th>hop</th><th>status</th><th>refusal</th><th>provider error</th><th>dur ms</th><th>queue ms</th><th>call id</th></tr></thead><tbody>${rows}</tbody></table>`;
}

interface RequestRow {
	rid?: string | null;
	ts?: string | null;
	status?: number | null;
	ok?: number | null;
	decision?: string | null;
	error_code?: string | null;
	why?: string | null;
	target_kind?: string | null;
	target_host?: string | null;
	target_port?: number | null;
	target_model?: string | null;
	duration_ms?: number | null;
}

function requestsTable(rows: RequestRow[]): string {
	if (rows.length === 0)
		return '<p class="dim">No request rows recorded for this trace.</p>';
	const body = rows
		.map(
			(r) =>
				`<tr><td class="num">${txt(r.ts)}</td><td class="num">${num(r.status)}</td><td>${txt(r.decision)}</td><td>${txt(r.error_code)}</td><td>${txt(r.target_host ? `${r.target_host}:${r.target_port ?? ""}` : null)}${r.target_kind ? ` (${esc(r.target_kind)})` : ""}</td><td>${txt(r.target_model)}</td><td class="num">${num(r.duration_ms)}</td></tr>`,
		)
		.join("");
	return `<table class="ct"><thead><tr><th>time</th><th>status</th><th>decision</th><th>error</th><th>sanitized target</th><th>model</th><th>dur ms</th></tr></thead><tbody>${body}</tbody></table>`;
}

const asRows = (v: unknown): Array<Record<string, unknown>> =>
	Array.isArray(v) && v.every((r) => r && typeof r === "object")
		? (v as Array<Record<string, unknown>>)
		: [];

function stateNotice(state: TraceState, httpStatus?: number): string {
	if (state === "unreachable")
		return '<div class="errbox">Buckle admin API unreachable — the trace cannot be resolved from this board right now.</div>';
	if (state === "bad_json")
		return '<div class="errbox">Buckle answered with an unusable body — the trace cannot be shown.</div>';
	return `<div class="errbox">Buckle answered HTTP ${httpStatus ?? "—"} — the trace could not be read.</div>`;
}

function traceBody(id: string, resolved: TraceResolve): string {
	if (resolved.state !== "ok")
		return stateNotice(resolved.state, resolved.httpStatus);
	const body = resolved.body ?? {};
	const requests = asRows(body.requests);
	const attempts = asRows(body.attempts);
	if (requests.length === 0 && attempts.length === 0)
		return `<div class="errbox">Unknown or expired trace — no requests or attempts are recorded for <code>${id}</code>.</div>`;
	return `<div class="panel"><h2>requests</h2>${requestsTable(requests as RequestRow[])}</div><div class="panel"><h2>hop attempts</h2>${attemptsTable(attempts as TraceAttempt[])}</div>`;
}

export async function handleTrace(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname !== "/console/trace" && url.pathname !== "/api/trace")
		return null;
	if (req.method !== "GET") return json({ ok: false, error: "GET only" }, 405);
	const id = tracePageTraceId(url);
	if (!id) {
		const hint =
			"trace_id missing or malformed — it must be 32 lowercase hex characters";
		if (url.pathname === "/api/trace")
			return json({ ok: false, error: hint }, 400);
		return new Response(
			consolePage(
				"Fleet trace",
				"",
				`<div class="errbox">${esc(hint)}</div>`,
				consoleMe(),
			),
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	}
	const resolved = await resolveTrace(id);
	if (url.pathname === "/api/trace")
		return json({ ok: resolved.state === "ok", trace_id: id, ...resolved });
	return new Response(
		consolePage(
			`Fleet trace ${id.slice(0, 8)}`,
			"",
			`<p class="dim">trace <code>${id}</code> · resolved through the local Buckle admin API · read-only</p>${traceBody(id, resolved)}`,
			consoleMe(),
		),
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
			},
		},
	);
}
