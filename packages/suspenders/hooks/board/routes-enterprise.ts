// hooks/board/routes-enterprise.ts — W775.1: the enterprise seam routes.
// Provider-less (Core SKU) = honest 501 ENT_NO_OVERLAY on both routes —
// the GUI probe keys on that exact status. With the overlay's provider
// registered, the routes pass through its payloads; a throwing provider
// answers a 503 with the reason (honest, never a fake 200).
import {
	ENT_NO_OVERLAY,
	getEnterpriseProvider,
	type EnterprisePayload,
	type EntitlementsPayload,
} from "./ent-seam.ts";

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});

export async function handleEnterprise(
	_req: Request,
	url: URL,
): Promise<Response | null> {
	if (url.pathname === "/api/entitlements") {
		const p = getEnterpriseProvider();
		if (!p) return json(ENT_NO_OVERLAY, 501);
		try {
			return json(p.entitlements() satisfies EntitlementsPayload);
		} catch (e) {
			return json(
				{ ok: false, code: "board.entitlements_failed", why: String(e) },
				503,
			);
		}
	}
	if (url.pathname === "/api/enterprise") {
		const p = getEnterpriseProvider();
		if (!p) return json(ENT_NO_OVERLAY, 501);
		try {
			return json(p.panels() satisfies EnterprisePayload);
		} catch (e) {
			return json(
				{ ok: false, code: "board.enterprise_failed", why: String(e) },
				503,
			);
		}
	}
	return null;
}
