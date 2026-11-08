import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { withRouteKey } from "../bench/runner/route-auth.ts";

test("route key admin redirects refuse and action failures still revoke @unit", async () => {
	const old = process.env.BUCKLE_ADMIN_KEY;
	process.env.BUCKLE_ADMIN_KEY = "fixture-admin";
	let revoked = 0;
	const destination = serveStub(() => Response.json({ key: "bksk_fixture", key_id: "fixture" }));
	const redirect = serveStub(() => Response.redirect(destination.url));
	const gateway = serveStub((req) => {
		if (new URL(req.url).pathname.endsWith("/revoke")) {
			revoked++; return Response.json({ ok: true });
		}
		return Response.json({ key: "bksk_fixture", key_id: "fixture" });
	});
	try {
		await expect(withRouteKey(redirect.url, null, "fixture", async () => "unused"))
			.rejects.toThrow("mint refused");
		expect(destination.requests).toHaveLength(0);
		await expect(withRouteKey(gateway.url, null, "fixture", async () => {
			throw new Error("fixture action failure");
		})).rejects.toThrow("fixture action failure");
		expect(revoked).toBe(1);
	} finally {
		destination.close(); redirect.close(); gateway.close();
		if (old === undefined) delete process.env.BUCKLE_ADMIN_KEY;
		else process.env.BUCKLE_ADMIN_KEY = old;
	}
});
