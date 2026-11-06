// test/adapters-responses-live.e2e.ts — W2780: the LIVE Copilot Responses
// wire receipt. W2583's reviewer B1 held the merge on mock-only proof of the
// hardcoded upstream path /v1/responses (the /models rows advertise the
// un-prefixed [/responses]). This spec probes the real seat when a PAT is
// reachable (GITHUB_COPILOT_PAT env, else the machine spoke env file) and
// SKIPS hermetically otherwise — the mock suites stay the CI contract.
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";

const PAT_ENV = process.env.GITHUB_COPILOT_PAT?.trim();
let patFile = "";
try {
	const spoke = await Bun.file(
		`${process.env.HOME ?? ""}/.claude/local-llm/buckle-spoke.env`,
	).text();
	patFile =
		spoke
			.split("\n")
			.find((l) => l.startsWith("GITHUB_COPILOT_PAT="))
			?.split("=")
			.slice(1)
			.join("=")
			.trim() ?? "";
} catch {
	// absent machine file — the hermetic skip below is correct
}
const PAT = PAT_ENV || patFile;

test.describe("@api live copilot seat (skips without a PAT)", () => {
	// Hermetic default: every test below first checks the PAT and marks
	// itself skipped — test.info().skip, never a gated describe-level call.
	const noPat = "no GITHUB_COPILOT_PAT and no spoke env file — hermetic";

	const ORIGIN = "https://api.githubcopilot.com";
	const GROUP = "gpt-6-luna";
	const HEADERS = {
		authorization: `Bearer ${PAT}`,
		"copilot-integration-id": "vscode-chat",
		"content-type": "application/json",
	};

	test("origin serves BOTH /responses and /v1/responses (the W2583 path literal is wire-valid)", async () => {
		if (!PAT) test.info().skip(true, noPat);
		const body = JSON.stringify({
			model: GROUP,
			input: "Reply with the single word: ping",
			max_output_tokens: 16,
		});
		for (const path of ["/responses", "/v1/responses"]) {
			const res = await fetch(ORIGIN + path, {
				method: "POST",
				headers: HEADERS,
				body,
			});
			expect(res.status, path).toBe(200);
			const j = (await res.json()) as {
				status: string;
				usage?: { total_tokens: number };
			};
			expect(j.status, path).toBe("completed");
			expect((j.usage?.total_tokens ?? 0) > 0, path).toBe(true);
		}
	});

	test("chat client through the openai-responses rung reaches the live seat", async () => {
		if (!PAT) test.info().skip(true, noPat);
		// The rung's bearerHeaders resolves api_key_env from process.env —
		// the production auth path. Restored at the end of this test.
		const hadPat = "GITHUB_COPILOT_PAT" in process.env;
		const priorPat = process.env.GITHUB_COPILOT_PAT;
		process.env.GITHUB_COPILOT_PAT = PAT;
		const dep: Deployment = {
			group: GROUP,
			url: ORIGIN,
			dialect: "openai",
			adapter: "openai-responses",
			api_key_env: "GITHUB_COPILOT_PAT",
			adapter_config: {
				headers: { "copilot-integration-id": "vscode-chat" },
			},
		};
		const pool: UpstreamPool = {
			groups: () => [GROUP],
			deployments: (g) => (g === GROUP ? [dep] : []),
		};
		const d = testDeps(pool, {
			// api.githubcopilot.com is cloud-class; the default prefs refuse
			// cloud (503 cloud_forbidden) before the wire is ever hit.
			prefs: { cost_speed: "balanced", allow_cloud: true },
		});
		const app = createApp(d);
		const res = await app.fetch(
			new Request("https://buckle.test/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					messages: [{ role: "user", content: "Reply with one word: ping" }],
					max_tokens: 32,
				}),
			}),
		);
		// A wrong hardcoded path would 404 upstream → 502 at the gate; 200 +
		// real text + banked usage is the end-to-end wire proof.
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		expect(out.choices[0]?.message.content.length ?? 0).toBeGreaterThan(0);
		const row = d.ledger.rows()[0] ?? { in_tok: 0, out_tok: 0 };
		expect(row.in_tok).toBeGreaterThan(0);
		expect(row.out_tok).toBeGreaterThan(0);
		if (hadPat) process.env.GITHUB_COPILOT_PAT = priorPat;
		else delete process.env.GITHUB_COPILOT_PAT;
	});
});
