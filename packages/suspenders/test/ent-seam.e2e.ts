// test/ent-seam.test.ts — W775.1: the board-side enterprise seam. The
// contract the GUI gates on: honest 501 provider-less (Core SKU), payload
// passthrough with a registered provider, 503 on a throwing provider, and
// the panel-key contract order.
import { expect, test } from "./pw";
import {
	ENT_PANEL_KEYS,
	ENT_NO_OVERLAY,
	getEnterpriseProvider,
	setEnterpriseProvider,
	type EnterpriseProvider,
	type EnterprisePayload,
	type EntitlementsPayload,
} from "../hooks/board/ent-seam.ts";
import { handleEnterprise } from "../hooks/board/routes-enterprise.ts";

const get = (path: string): Promise<Response | null> => {
	const url = new URL(`http://board${path}`);
	return handleEnterprise(new Request(url), url);
};

/** A minimal honest provider — the shape the overlay implements. */
function fixtureProvider(): EnterpriseProvider {
	const ent: EntitlementsPayload = {
		ok: true,
		sku: "enterprise",
		tenant: "acme-corp",
		panels: [...ENT_PANEL_KEYS],
	};
	const panels: EnterprisePayload = {
		ok: true,
		ts: 1_700_000_000_000,
		panels: {
			identity: {
				ok: true,
				users: [
					{
						id: "u1",
						label: "ada",
						kind: "employee",
						roles: ["admin"],
						mfa: "enforced",
						entitled: true,
					},
				],
				roles: [{ id: "admin", members: 1, scopes: ["vault:read"] }],
				oidc: { issuer: "https://login.example", enforced: true },
			},
			vault: {
				ok: false,
				why: "vault surface not wired on this hub",
			},
		},
	};
	return {
		entitlements: () => ent,
		panels: () => panels,
	};
}

test.afterEach(() => {
	setEnterpriseProvider(null);
});

test.describe("enterprise seam (W775.1)", () => {
	test("slot starts and stays null until registered", () => {
		expect(getEnterpriseProvider()).toBeNull();
		const p = fixtureProvider();
		setEnterpriseProvider(p);
		expect(getEnterpriseProvider()).toBe(p);
		setEnterpriseProvider(null);
		expect(getEnterpriseProvider()).toBeNull();
	});

	test("both routes answer the honest 501 provider-less (Core SKU)", async () => {
		for (const path of ["/api/entitlements", "/api/enterprise"]) {
			const res = await get(path);
			expect(res === null).toBe(false);
			if (res === null) return;
			expect(res.status).toBe(501);
			const j = (await res.json()) as Record<string, unknown>;
			expect(j).toEqual(ENT_NO_OVERLAY);
		}
	});

	test("unrelated paths fall through (null)", async () => {
		expect(await get("/api/data")).toBeNull();
		expect(await get("/entitlements")).toBeNull();
	});

	test("entitlements pass through with a registered provider", async () => {
		setEnterpriseProvider(fixtureProvider());
		const res = await get("/api/entitlements");
		if (res === null) throw new Error("no response");
		expect(res.status).toBe(200);
		const j = (await res.json()) as EntitlementsPayload;
		expect(j.ok).toBe(true);
		expect(j.sku).toBe("enterprise");
		expect(j.tenant).toBe("acme-corp");
		expect(j.panels).toEqual([...ENT_PANEL_KEYS]);
	});

	test("panels passthrough carries failed slices honestly", async () => {
		setEnterpriseProvider(fixtureProvider());
		const res = await get("/api/enterprise");
		if (res === null) throw new Error("no response");
		expect(res.status).toBe(200);
		const j = (await res.json()) as EnterprisePayload;
		expect(j.ok).toBe(true);
		const identity = j.panels.identity;
		expect(identity?.ok).toBe(true);
		if (identity?.ok) expect(identity.users.length).toBe(1);
		const vault = j.panels.vault;
		expect(vault?.ok).toBe(false);
		if (!vault?.ok) expect(vault?.why).toContain("not wired");
	});

	test("a throwing provider answers 503, never a fake 200", async () => {
		setEnterpriseProvider({
			entitlements: () => {
				throw new Error("boom");
			},
			panels: () => {
				throw new Error("boom");
			},
		});
		for (const path of ["/api/entitlements", "/api/enterprise"]) {
			const res = await get(path);
			if (res === null) throw new Error("no response");
			expect(res.status).toBe(503);
			const j = (await res.json()) as Record<string, unknown>;
			expect(String(j.why)).toContain("boom");
		}
	});

	test("panel keys are the contract render order", () => {
		expect([...ENT_PANEL_KEYS]).toEqual([
			"identity",
			"federation",
			"audit",
			"usage",
			"policy",
			"vault",
			"ma",
		]);
	});
});
