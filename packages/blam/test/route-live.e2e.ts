import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { routeExperiment } from "../bench/runner/route-live.ts";

function gateway(
	provider = "fixture-provider",
	options: {
		missingLedger?: boolean;
		output?: number;
		revokeFails?: boolean;
	} = {},
) {
	let revoked = 0,
		count = 0;
	const stub = serveStub((req) => {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/revoke")) {
			revoked++;
			return Response.json(
				{ ok: !options.revokeFails },
				{ status: options.revokeFails ? 503 : 200 },
			);
		}
		if (url.pathname === "/v1/admin/keys")
			return Response.json({
				key: "bksk_fixture",
				key_id: (++count).toString(16).padStart(12, "0"),
			});
		if (url.pathname === "/v1/admin/requests")
			return Response.json({
				requests: options.missingLedger
					? []
					: [
							{
								rid: "fixture-rid",
								lane: url.searchParams.get("lane"),
								status: 200,
								ok: 1,
								served_model: "glm-5.3-flash",
								served_provider: provider,
								target_model: "glm-5.3-flash",
								dialect: "openai",
								in_tok: 100,
								out_tok: options.output ?? 5,
								cache_r: 80,
								cache_c: 0,
								cache_reported: 1,
							},
						],
			});
		return new Response(
			`data: ${JSON.stringify({ model: "glm-5.3-flash", choices: [{ delta: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } })}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	return { ...stub, revoked: () => revoked };
}

test.describe("route live scoped evidence @unit", () => {
	for (const [name, provider, options] of [
		["provider mismatch", "wrong-provider", {}],
		["missing ledger", "fixture-provider", { missingLedger: true }],
		["usage mismatch", "fixture-provider", { output: 9 }],
		["cleanup failure", "fixture-provider", { revokeFails: true }],
	] as const) {
		test(`${name} retains the failed pair and refuses lift`, async () => {
			const world = scratchWorld({ prefix: "blam-failed-routes-" });
			const a = gateway(),
				b = gateway(provider, options);
			const old = process.env.BUCKLE_ADMIN_KEY;
			process.env.BUCKLE_ADMIN_KEY = "fixture-admin";
			try {
				const report = await routeExperiment({
					baseline: { url: a.url, hub: null },
					candidate: { url: b.url, hub: null },
					model: "glm-5.3-flash",
					providerIdentity: "fixture-provider",
					reps: 12,
					timeoutMs: 1000,
					cacheCondition: "fixture",
					policyDigest: "fixture",
					outputDir: join(world.home, "out"),
				});
				expect(report.issues.length).toBeGreaterThan(0);
				expect(report.pairs).toHaveLength(1);
				expect(report.lift).toBeNull();
				expect(report.arms.candidate.failures).toBe(1);
				expect(a.revoked()).toBe(1);
				expect(b.revoked()).toBe(1);
			} finally {
				a.close();
				b.close();
				world.clean();
				if (old === undefined) delete process.env.BUCKLE_ADMIN_KEY;
				else process.env.BUCKLE_ADMIN_KEY = old;
			}
		});
	}
	test("matched inference pairs use scoped keys, audit receipts and guaranteed cleanup", async () => {
		const world = scratchWorld({ prefix: "blam-routes-" }),
			a = gateway(),
			b = gateway();
		const old = process.env.BUCKLE_ADMIN_KEY;
		process.env.BUCKLE_ADMIN_KEY = "fixture-admin";
		try {
			const report = await routeExperiment({
				baseline: { url: a.url, hub: null },
				candidate: { url: b.url, hub: null },
				model: "glm-5.3-flash",
				providerIdentity: "fixture-provider",
				reps: 12,
				timeoutMs: 1000,
				cacheCondition: "fixture",
				policyDigest: "fixture",
				outputDir: join(world.home, "out"),
			});
			expect(report.issues).toEqual([]);
			expect(report.pairs).toHaveLength(12);
			expect(a.revoked()).toBe(12);
			expect(b.revoked()).toBe(12);
			expect(
				a.requests
					.filter((r) => r.path.includes("/w/"))
					.every((r) => r.auth === "Bearer bksk_fixture"),
			).toBe(true);
		} finally {
			a.close();
			b.close();
			world.clean();
			if (old === undefined) delete process.env.BUCKLE_ADMIN_KEY;
			else process.env.BUCKLE_ADMIN_KEY = old;
		}
	});
});
