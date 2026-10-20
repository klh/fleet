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
				"https://api.z.ai/api/paas/v4/chat/completions",
			);
			expect(deployment.model).toBe(
				group === "general" ? "glm-5.3-flash" : group,
			);
		}
	});
});
