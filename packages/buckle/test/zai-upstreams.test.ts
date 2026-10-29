import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { upstreamUrlOf } from "../src/adapters/types.ts";
import { loadUpstreams } from "../src/upstreams.ts";

const fixture = join(import.meta.dir, "../upstreams.zai.json");

describe("Z.ai hub upstream template", () => {
	test("all advertised GLM routes use direct Z.ai egress and a named secret", () => {
		const pool = loadUpstreams(fixture);
		for (const group of [
			"general",
			"glm-5.3-flash",
			"glm-5.3-flashx",
			"glm-5.3",
			"glm-5.2",
		]) {
			const [deployment] = pool.deployments(group);
			expect(deployment).toBeDefined();
			expect(deployment.url).toBe("https://api.z.ai");
			expect(deployment.api_key_env).toBe("Z_AI_API_KEY");
			expect(upstreamUrlOf(deployment, "/v1/chat/completions")).toBe(
				"https://api.z.ai/api/coding/paas/v4/chat/completions",
			);
			expect(deployment.model).toBe(
				group === "general" ? "glm-5.3-flash" : group,
			);
			// W1257.1: Coding Plan credentials never reach the general inference
			// endpoint — the template ships the guard rows and per-wire
			// correction URLs (anthropic wire keeps the /api/anthropic base).
			const guard = deployment.adapter_config?.blocked_outbound as
				| { paths: string[]; corrections: Record<string, string> }
				| undefined;
			expect(guard?.paths).toContain("/api/paas/v4/");
			expect(guard?.corrections.anthropic).toBe(
				"https://api.z.ai/api/anthropic/v1/messages",
			);
			expect(guard?.corrections.openai).toBe(
				"https://api.z.ai/api/coding/paas/v4/chat/completions",
			);
			expect(guard?.corrections.responses).toBe(
				"https://api.z.ai/api/v1/responses",
			);
		}
	});
});
