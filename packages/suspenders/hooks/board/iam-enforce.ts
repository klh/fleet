// hooks/board/iam-enforce.ts — W844: the request pipeline when an IAM gate
// is registered. Order is the perimeter: gate-owned routes pass through
// (login/callback/logout are public), then authenticate (session cookie →
// principal with CURRENT roles), then authorize (server-side RBAC), and only
// then dispatch into the board. Gate-less = the caller never enters here —
// Core SKU behavior stays byte-for-byte. Browser navigations get the 302
// login challenge; API clients get fixed-shape 401/403, never a fake 200.
import { getIamGate, isIamPublicPath, type IamGate } from "./iam-seam.ts";

export async function enforceIam(
	req: Request,
	url: URL,
	dispatch: (req: Request) => Promise<Response>,
	gate: IamGate | null = getIamGate(),
): Promise<Response> {
	if (!gate) return dispatch(req);
	const routed = await gate.route(req, url);
	if (routed) return routed;
	if (isIamPublicPath(url.pathname))
		return Response.json(
			{ ok: false, code: "board.iam_no_route", why: "no such iam endpoint" },
			{ status: 404 },
		);
	const a = await gate.authn(req, url);
	if (!a.ok) return a.response;
	const z = gate.authorize(a.principal, req, url);
	if (!z.ok)
		return Response.json(
			{ ok: false, code: z.code, why: z.why },
			{ status: z.status },
		);
	return dispatch(req);
}
