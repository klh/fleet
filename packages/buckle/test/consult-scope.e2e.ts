// W2779.4: the CONSULT_ scope row is mintable + verifiable end to end —
// the fk sink's /api/consult auth line is only enforceable if a buckle key
// can carry buckle:knowledge:CONSULT_ (scope-string literal matches the
// seam-doc auth table verbatim) and /v1/admin/keys/verify reports it back.
import { expect, test } from "@playwright/test";
import { issueViaAdmin, ROOT, startGate } from "./gate.ts";
import { startMockUpstream } from "./mock.ts";

test.describe("@api", () => {
	test("CONSULT_ mints via the admin API and verifies with the scope reported", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate({ upstreamUrl: upstream.url });
		const { key } = await issueViaAdmin(gate.base, {
			name: "w2779-consult-e2e",
			scopes: ["buckle:knowledge:CONSULT_"],
		});
		expect(key.startsWith("bksk_")).toBe(true);
		const verify = await fetch(`${gate.base}/v1/admin/keys/verify`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${ROOT}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ key }),
		});
		expect(verify.status).toBe(200);
		const body = (await verify.json()) as {
			valid: boolean;
			scopes: string[];
		};
		expect(body.valid).toBe(true);
		expect(body.scopes).toContain("buckle:knowledge:CONSULT_");
		gate.stop();
		upstream.close();
	});

	test("CONSULT_ implies nothing on the proxy face (no QUERY_/READ_ sidecar)", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "x", choices: [], usage: {} }),
		);
		const gate = await startGate({ upstreamUrl: upstream.url });
		const { key } = await issueViaAdmin(gate.base, {
			name: "w2779-consult-implies",
			scopes: ["buckle:knowledge:CONSULT_"],
		});
		// the proxy face demands proxy scopes — a consult key is refused
		const proxy = await fetch(`${gate.base}/v1/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
		});
		expect(proxy.status).toBe(403);
		const denied = (await proxy.json()) as { code?: string };
		expect(denied.code).toBe("buckle.insufficient_scope");
		gate.stop();
		upstream.close();
	});
});
