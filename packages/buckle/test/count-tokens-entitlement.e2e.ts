// W2257.1 — count_tokens estimates are entitlement-bound: the scoped
// candidate domain must hold a row for the EXACT requested group before the
// local bytes/4 estimate fires. A policy-fallback head (entitled delivery
// for another group) never authorizes an estimate for the requested one —
// refusal is 503 buckle.tier_no_upstream with zero outbound. Provider-
// neutral: the axes are group entitlement and account scope only.
import { serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import type { AccountPolicyDoc } from "../src/account-policy.ts";
import { Cooldowns } from "../src/cooldown.ts";
import { stashPrincipal } from "../src/gov/federation.ts";
import type { Principal } from "../src/gov/middleware.ts";
import { createApp } from "../src/handlers.ts";
import type { GatewayPolicy } from "../src/policy.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";

const REQUESTED = "requested-openai-model";
const FALLBACK = "fallback-entitled-model";

// The authenticated account class permits ONLY the entitled provider.
const DOC: AccountPolicyDoc = {
	version: 1,
	classes: [
		{
			id: "entitled-only",
			tier: "work",
			general: true,
			keys: ["*"],
			providers: ["entitled"],
		},
	],
};

const principal: Principal = {
	kind: "api_key",
	keyId: "test-key",
	name: "any-tool-key",
	team: null,
	actor: "any-tool-key",
	scopes: ["buckle:proxy:WRITE_*"],
	jti: null,
	rpm: null,
	tpm: null,
};

function poolOf(requested: string, fallback: string): UpstreamPool {
	return {
		groups: () => [REQUESTED, FALLBACK],
		deployments: (group): Deployment[] =>
			group === REQUESTED
				? [
						{
							group,
							url: requested,
							dialect: "openai",
							adapter: "openai-compat",
							provider: "forbidden",
						},
					]
				: group === FALLBACK
					? [
							{
								group,
								url: fallback,
								dialect: "openai",
								adapter: "openai-compat",
								provider: "entitled",
							},
						]
					: [],
	};
}

function policyOf(): GatewayPolicy {
	return {
		num_retries: 1,
		allowed_fails: 3,
		cooldown_time: 30,
		fallbacks: { [REQUESTED]: [FALLBACK] },
	};
}

function countRequest(model: string): Request {
	const req = new Request("http://127.0.0.1:4101/v1/messages/count_tokens", {
		method: "POST",
		body: JSON.stringify({
			model,
			system: "Be concise",
			messages: [{ role: "user", content: "How many tokens?" }],
		}),
	});
	stashPrincipal(req, principal);
	return req;
}

const unexpected = () =>
	new Response("unexpected upstream call", { status: 500 });

test.describe("count_tokens entitlement binding @api", () => {
	test("requested group scoping strips its only row while an entitled fallback head survives: 503, zero outbound", async () => {
		const forbidden = serveStub(unexpected);
		const entitled = serveStub(unexpected);
		try {
			const cooldowns = new Cooldowns(1, 30);
			const deps = testDeps(poolOf(forbidden.url, entitled.url), {
				accountPolicy: DOC,
				policy: policyOf(),
				cooldowns,
			});
			// Bench the requested group's only row so decideRoute falls through
			// to the configured policy fallback (the W2257 adversarial shape).
			cooldowns.eject({
				group: REQUESTED,
				url: forbidden.url,
				dialect: "openai",
			});
			deps.table.rebuild();
			const response = await createApp(deps).fetch(countRequest(REQUESTED));
			expect(response.status).toBe(503);
			expect(((await response.json()) as { code?: string }).code).toBe(
				"buckle.tier_no_upstream",
			);
			expect(response.headers.get("x-klh-token-count-method")).toBeNull();
			expect(forbidden.requests).toHaveLength(0);
			expect(entitled.requests).toHaveLength(0);
		} finally {
			forbidden.close();
			entitled.close();
		}
	});

	test("healthy but unentitled requested row: scope refusal fires before any estimate", async () => {
		const forbidden = serveStub(unexpected);
		const entitled = serveStub(unexpected);
		try {
			const deps = testDeps(poolOf(forbidden.url, entitled.url), {
				accountPolicy: DOC,
			});
			const response = await createApp(deps).fetch(countRequest(REQUESTED));
			expect(response.status).toBe(503);
			expect(((await response.json()) as { code?: string }).code).toBe(
				"buckle.tier_no_upstream",
			);
			expect(response.headers.get("x-klh-token-count-method")).toBeNull();
			expect(forbidden.requests).toHaveLength(0);
			expect(entitled.requests).toHaveLength(0);
		} finally {
			forbidden.close();
			entitled.close();
		}
	});

	test("entitled openai-only group still estimates under an active account boundary", async () => {
		const entitled = serveStub(unexpected);
		try {
			const deps = testDeps(
				{
					groups: () => [FALLBACK],
					deployments: (group) =>
						group === FALLBACK
							? [
									{
										group,
										url: entitled.url,
										dialect: "openai",
										adapter: "openai-compat",
										provider: "entitled",
									},
								]
							: [],
				},
				{ accountPolicy: DOC },
			);
			const response = await createApp(deps).fetch(countRequest(FALLBACK));
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				input_tokens: expect.any(Number),
			});
			expect(response.headers.get("x-klh-token-count-method")).toBe(
				"estimated-bytes-v1",
			);
			expect(entitled.requests).toHaveLength(0);
		} finally {
			entitled.close();
		}
	});
});
