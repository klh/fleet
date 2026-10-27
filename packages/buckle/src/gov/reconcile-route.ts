// src/gov/reconcile-route.ts — W1124.31: the POST /v1/admin/requests/
// reconcile face. Records the audited abandoned verdict on ONE provably
// dead inference receipt: the ledger's proof gates decide (prior gate
// incarnation + elapsed transport bound), a refusal is a 409 with the
// ledger's stable code, and success appends a chained auth event
// (event=reconciled, jti=rid) — the audit trail rides the W703
// tamper-evident chain, never a raw-DB edit. Never a fabricated status.
import { problem } from "../citizenship.ts";
import { readBoundedJson } from "../ingress-body.ts";
import { appendAuthEvent } from "./audit-chain.ts";
import type { Governance, Principal } from "./middleware.ts";

const JSON_HEADERS = { "content-type": "application/json" };

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

function bad(status: number, code: string, why: string): Response {
	return problem({ status, code, why: `belt: ${code} — ${why}` });
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** The one reconcile mutation: exact-body in, verdict or stable-code
 *  refusal out. The chained auth event lands only on success. */
export async function reconcileRequest(
	req: Request,
	p: Principal,
	gov: Governance,
): Promise<Response> {
	const read = await readBoundedJson(req, gov.ingressBodyTimeoutMs);
	if (!read.ok) return bad(read.status, read.code, read.why);
	const body = read.body as Record<string, unknown> | null;
	if (body === null) return bad(400, "buckle.bad_body", "missing body");
	const rid = str(body.rid);
	const lane = str(body.lane);
	if (rid === null || lane === null)
		return bad(400, "buckle.bad_body", "missing rid or lane");
	const result = gov.ledger.reconcileAbandoned({
		rid,
		lane,
		trace_id: str(body.trace_id),
		ts: str(body.ts),
		actor: p.actor ?? p.keyId,
		reason: str(body.reason) ?? "unspecified",
	});
	if (!result.ok) return bad(409, result.code, result.why);
	appendAuthEvent(gov.db, {
		ts: Date.now(),
		actor: p.actor ?? p.keyId,
		event: "reconciled",
		jti: rid,
		via: "admin",
	});
	return ok({ reconciled: rid, verdict: result.verdict });
}
