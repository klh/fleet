import { expect, test } from "@playwright/test";
import {
	resolveProvider,
	validateProviderConfig,
} from "@klh/settings/connections";
import { resolveAdapter } from "@klh/buckle/src/adapters/index.ts";
import { projectConnectionGroups } from "../deploy/hub-connections.ts";

test("one provider uses its declared OpenAI and Anthropic endpoints with matching actual wire builders", async () => {
	const profiles = validateProviderConfig({
		example: {
			kind: "provider",
			provider: "zai",
			adapter: "openai",
			endpoints: {
				openai: "https://provider.example/v4",
				anthropic: "https://provider.example/anthropic",
			},
		},
	});
	const profile = resolveProvider("example", profiles);
	if (!profile) throw Error("Profile absent");
	for (const dialect of ["openai", "anthropic"] as const) {
		const row = projectConnectionGroups(
			{ model: [{ providerProfile: "example", dialect, model: "glm-5.3" }] },
			[profile],
		).model?.[0];
		if (!row) throw Error("Route absent");
		const dep = {
			...row,
			group: "model",
			dialect,
			url: String(row.url),
			adapter: String(row.adapter),
		};
		const adapter = resolveAdapter(dep);
		expect(adapter.dialect).toBe(dialect);
		const path =
			dialect === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
		const wire = await adapter.buildCall(
			dep,
			{ group: "model", dialect, path, body: {}, key: "" },
			{
				model: "glm-5.3",
				max_tokens: 16,
				messages: [{ role: "user", content: "test" }],
			},
		);
		expect(wire.url).toBe(
			dialect === "anthropic"
				? "https://provider.example/anthropic/v1/messages"
				: "https://provider.example/v4/chat/completions",
		);
		expect(JSON.parse(wire.body).model).toBe("glm-5.3");
	}
});
