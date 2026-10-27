// test/w770-escalate-reasoning.test.ts — W770: the escalation reasoning
// pin. Belt resolves the routing-policy reasoning axis (role
// escalate/escalate-fast) and clamps to the Z.AI-verified efforts
// (low|high — GLM-5.3 always thinks; medium/disable don't exist). thinking
// + reasoning_effort ride the body so BOTH hop modes carry it: the gate
// translation hop forwards reasoning_effort verbatim (buckle W770), the
// legacy litellm-direct hop buckets thinking to the same effort (adapter:
// ≥4096→high, ≥1024→low). The gate's own request-transform test pins the
// buckle side; this file pins the belt side.
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";
import { escalate } from "../bin/escalate.ts";
import { scratchWorld } from "@klh/test-kit";

type AnyRec = Record<string, unknown>;

const { home: dir, clean } = scratchWorld({ prefix: "w770-" });
const policyFile = `${dir}/policy.yaml`;
writeFileSync(
	policyFile,
	[
		"version: 1",
		"gateway: {}",
		"classes:",
		"  frontier: [glm-5.3]",
		"  standard: [glm-5.3-flash]",
		"reasoning:",
		"  default: medium",
		"  roles:",
		"    escalate: high",
		"    escalate-fast: xhigh",
		"",
	].join("\n"),
);

afterAll(() => clean());

const ENV = {
	BELT_ESCALATE_URL: "http://127.0.0.1:9",
	BELT_ESCALATE_KEY: "bksk_test",
};

/** fetch stub capturing the request body; always 200 + a text block. */
function stub200(): { fetcher: typeof fetch; bodies: AnyRec[] } {
	const bodies: AnyRec[] = [];
	const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)) as AnyRec);
		return Response.json({ content: [{ text: "pong" }] });
	}) as unknown as typeof fetch;
	return { fetcher, bodies };
}

const BODY = {
	model: "glm-5.3",
	max_tokens: 4096,
	messages: [{ role: "user", content: "one-word answer: ping?" }],
};

describe("escalate reasoning pin (W770)", () => {
	test("default policy (medium) clamps to low + 1024 thinking", async () => {
		const { fetcher, bodies } = stub200();
		await escalate(BODY, {
			maxTokens: 4096,
			wantFast: false,
			env: ENV,
			fetcher,
			policyPath: `${dir}/absent-defaults.yaml`,
		});
		expect(bodies[0]?.reasoning_effort).toBe("low");
		expect(bodies[0]?.thinking).toEqual({
			type: "enabled",
			budget_tokens: 1024,
		});
	});

	test("roles.escalate: high → high + 4096", async () => {
		const { fetcher, bodies } = stub200();
		await escalate(BODY, {
			maxTokens: 4096,
			wantFast: false,
			env: ENV,
			fetcher,
			policyPath: policyFile,
		});
		expect(bodies[0]?.reasoning_effort).toBe("high");
		expect(bodies[0]?.thinking).toEqual({
			type: "enabled",
			budget_tokens: 4096,
		});
	});

	test("wantFast rides the escalate-fast role row (xhigh → high)", async () => {
		const { fetcher, bodies } = stub200();
		await escalate(BODY, {
			maxTokens: 4096,
			wantFast: true,
			env: ENV,
			fetcher,
			policyPath: policyFile,
		});
		expect(bodies[0]?.reasoning_effort).toBe("high");
	});

	test("model/system/messages still ride the body", async () => {
		const { fetcher, bodies } = stub200();
		await escalate(BODY, {
			maxTokens: 4096,
			wantFast: false,
			env: ENV,
			fetcher,
			policyPath: policyFile,
		});
		expect(bodies[0]?.model).toBe("glm-5.3");
		expect(bodies[0]?.messages).toEqual(BODY.messages);
	});
});
