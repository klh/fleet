// test/iam-seam.test.ts — W844: the board-side IAM seam. Slot mechanics and
// the enforceIam pipeline (gate-owned routes pass through, everything else
// authenticates then authorizes server-side). The real gate implementation
// lives in the private overlay (klh-remote); these fixtures pin the contract
// the overlay implements.
import { expect, test } from "./pw";
import {
	getIamGate,
	type IamGate,
	type IamPrincipal,
	iamChallenge,
	iamForbidden,
	isIamPublicPath,
	setIamGate,
} from "../hooks/board/iam-seam.ts";
import { enforceIam } from "../hooks/board/iam-enforce.ts";

const principal = (over: Partial<IamPrincipal> = {}): IamPrincipal => ({
	id: "u1",
	label: "ada",
	tenant: "acme",
	kind: "user",
	roles: ["viewer"],
	breakglass: false,
	...over,
});

/** Minimal honest gate: `sid=ok` cookie authenticates, operator role gates
 *  the /api/answer write route, /iam/login routes. */
function fixtureGate(): IamGate & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		route: async (_req, url) => {
			calls.push(`route ${url.pathname}`);
			return url.pathname === "/iam/login"
				? new Response("login", { status: 200 })
				: null;
		},
		authn: async (req) => {
			calls.push(`authn ${new URL(req.url).pathname}`);
			const c = req.headers.get("cookie") ?? "";
			if (!c.includes("sid=ok"))
				return {
					ok: false as const,
					response: iamChallenge(req, "/iam/login"),
				};
			return { ok: true as const, principal: principal() };
		},
		authorize: (p, _req, url) => {
			calls.push(`authz ${url.pathname}`);
			if (url.pathname === "/api/answer" && !p.roles.includes("operator"))
				return {
					ok: false as const,
					status: 403,
					code: "iam.role_missing",
					why: "operator role required for writes",
				};
			return { ok: true as const };
		},
	};
}

test.afterEach(() => setIamGate(null));

test.describe("iam seam slot + pipeline (W844)", () => {
	test("slot starts and stays null until registered", () => {
		expect(getIamGate()).toBeNull();
		const g = fixtureGate();
		setIamGate(g);
		expect(getIamGate()).toBe(g);
		setIamGate(null);
		expect(getIamGate()).toBeNull();
	});

	test("public path classifier", () => {
		expect(isIamPublicPath("/iam")).toBe(true);
		expect(isIamPublicPath("/iam/login")).toBe(true);
		expect(isIamPublicPath("/api/data")).toBe(false);
	});

	test("gate-less pipeline is a pure passthrough", async () => {
		let hits = 0;
		const u = "http://b/api/data";
		const res = await enforceIam(
			new Request(u),
			new URL(u),
			async () => {
				hits++;
				return new Response("ok");
			},
			null,
		);
		expect(hits).toBe(1);
		expect(res.status).toBe(200);
	});
});

test.describe("iam pipeline denials (W844)", () => {
	test("gate-owned route answers without authn/authz", async () => {
		const g = fixtureGate();
		const u = "http://b/iam/login";
		const res = await enforceIam(
			new Request(u),
			new URL(u),
			async () => new Response("never"),
			g,
		);
		expect(res.status).toBe(200);
		expect(g.calls).toEqual(["route /iam/login"]);
	});

	test("unauthenticated API request gets the 401 challenge", async () => {
		const u = "http://b/api/data";
		const res = await enforceIam(
			new Request(u),
			new URL(u),
			async () => new Response("never"),
			fixtureGate(),
		);
		expect(res.status).toBe(401);
		expect((await res.json()).code).toBe("board.iam_unauthenticated");
	});

	test("unauthenticated browser navigation gets the 302 login redirect", async () => {
		const req = new Request("http://b/", {
			headers: { accept: "text/html" },
		});
		const res = await enforceIam(
			req,
			new URL("http://b/"),
			async () => new Response("never"),
			fixtureGate(),
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/iam/login");
	});

	test("authenticated + authorized request reaches dispatch", async () => {
		const g = fixtureGate();
		let hits = 0;
		const u = "http://b/api/data";
		const req = new Request(u, { headers: { cookie: "sid=ok" } });
		const res = await enforceIam(
			req,
			new URL(u),
			async () => {
				hits++;
				return new Response("ok");
			},
			g,
		);
		expect(hits).toBe(1);
		expect(res.status).toBe(200);
		expect(g.calls).toEqual([
			"route /api/data",
			"authn /api/data",
			"authz /api/data",
		]);
	});

	test("RBAC deny answers the fixed-shape 403", async () => {
		const u = "http://b/api/answer";
		const req = new Request(u, {
			method: "POST",
			headers: { cookie: "sid=ok" },
		});
		const res = await enforceIam(
			req,
			new URL(u),
			async () => new Response("never"),
			fixtureGate(),
		);
		expect(res.status).toBe(403);
		const j = await res.json();
		expect(j.code).toBe("iam.role_missing");
	});

	test("public path the gate did not route answers the honest 404", async () => {
		const u = "http://b/iam/whatever";
		const res = await enforceIam(
			new Request(u),
			new URL(u),
			async () => new Response("never"),
			fixtureGate(),
		);
		expect(res.status).toBe(404);
		expect((await res.json()).code).toBe("board.iam_no_route");
	});
});

test.describe("iam challenge + forbidden shapes (W844)", () => {
	test("iamChallenge: 302 for HTML navigation, 401 JSON for API", async () => {
		const html = iamChallenge(
			new Request("http://b/", { headers: { accept: "text/html" } }),
			"/iam/login",
		);
		expect(html.status).toBe(302);
		expect(html.headers.get("location")).toBe("/iam/login");
		const api = iamChallenge(new Request("http://b/api/data"), "/iam/login");
		expect(api.status).toBe(401);
		expect(api.headers.get("www-authenticate")).toBe("openid-connect");
	});

	test("iamForbidden is the fixed-shape 403", async () => {
		const res = iamForbidden("iam.cross_tenant", "tenant mismatch");
		expect(res.status).toBe(403);
		const j = await res.json();
		expect(j.ok).toBe(false);
		expect(j.code).toBe("iam.cross_tenant");
	});
});
