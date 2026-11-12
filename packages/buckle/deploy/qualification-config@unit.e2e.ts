import { expect, test } from "@playwright/test";
import { fixture } from "./test/fixture.ts";
import { configureFallback } from "./test/qualification-config.ts";
import { parsePolicy } from "../src/policy.ts";

test("fallback qualification reaches actual policy loader and independently lowers output only", async () => {
	const data = await fixture();
	try {
		await configureFallback(data);
		const effective = parsePolicy(
			await Bun.file(`${data.site}/policy.json`).text(),
		);
		expect(effective.fallbacks).toEqual({ "seed-model": ["seed-fallback"] });
		const upstreams = await Bun.file(`${data.site}/upstreams.json`).json();
		expect(upstreams.inherit_defaults).toBe(false);
		expect(
			upstreams.groups["seed-model"][0].capabilities.max_output_tokens,
		).toBe(16384);
		expect(upstreams.groups["seed-fallback"][0].capabilities).toEqual({
			context_length: 131072,
			max_output_tokens: 8192,
			reasoning: false,
			capability_source: "operator-pinned",
		});
	} finally {
		data.stub.close();
		data.world.clean();
	}
});
