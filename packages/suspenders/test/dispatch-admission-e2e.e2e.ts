import { expect, test } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { HOME, REPO, g, addItem, dispatchA, toolA } = dispatchHarness(test.afterAll, {
	tag: "route-admission",
	beltEnv: true,
});

test("attributable internal route failures hold before claim and key mint", async () => {
	const calls: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const path = new URL(request.url).pathname;
			calls.push(`${request.method} ${path}`);
			if (path === "/status") return new Response("ok");
			if (path === "/v1/admin/requests") {
				if (
					request.headers.get("authorization") !== "Bearer bksk_admin_scratch"
				)
					return new Response(null, { status: 401 });
				return Response.json({
					requests: [1, 2, 3].map((seconds) => ({
						ts: new Date(Date.now() - seconds * 1_000).toISOString(),
						traffic_kind: "inference",
						hop: "origin",
						target_model: "glm-5.3-flash",
						target_kind: "local",
						target_host: "127.0.0.1",
						target_port: 4000,
						candidates_seen: 1,
						selected_target_exact: true,
						selected_target_attempted: false,
						status: 502,
						ok: 0,
						error_code: "no_route",
						attempts: 0,
					})),
				});
			}
			return new Response("unexpected", { status: 500 });
		},
	});
	try {
		writeFileSync(join(REPO, ".prefer"), "must=glm-5.3-flash\n");
		g(["add", "-f", ".prefer"]);
		g(["commit", "-m", "pin test route"]);
		const id = await addItem("route admission preclaim fixture");
		const result = await dispatchA(
			{
				SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${server.port}`,
				SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
			},
			"--item",
			id,
		);
		expect(result.out).toContain(`WAIT ${id} — glm-5.3-flash`);
		expect(
			JSON.parse((await toolA({}, "work.ts", "show", id, "--json")).out).state,
		).toBe("READY");
		expect(existsSync(join(REPO, ".worktrees", id))).toBe(false);
		expect(calls).toContain("GET /v1/admin/requests");
		expect(calls.every((call) => !call.includes("/v1/admin/keys"))).toBe(true);
	} finally {
		server.stop(true);
	}
}, 60_000);
