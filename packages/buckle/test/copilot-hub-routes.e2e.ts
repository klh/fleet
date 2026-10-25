import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	preferCopilotHub,
	type UpstreamConfig,
} from "../src/copilot-hub-routes.ts";

test.describe({ tag: "@unit" }, () => {
	const template = JSON.parse(
		readFileSync(join(import.meta.dir, "../upstreams.copilot.json"), "utf8"),
	) as UpstreamConfig;
	const hubUrl = "http://127.0.0.1:4201";

	test.describe("Copilot Docker hub routing", () => {
		test("all 26 configured model groups enter the IKEA hub first", () => {
			const names = Object.keys(template.groups);
			expect(names).toHaveLength(26);
			const local: UpstreamConfig = {
				version: 1,
				groups: Object.fromEntries(
					names.map((name) => [
						name,
						[
							{ url: "https://api.githubcopilot.com", model: name },
							{ url: "http://127.0.0.1:4100", model: "glm-5.3-flash" },
						],
					]),
				),
			};
			const first = preferCopilotHub(local, template.groups, hubUrl);
			for (const name of names) {
				const routes = first.config.groups[name] ?? [];
				expect(
					routes
						.filter((route) => route.url === hubUrl)
						.every((route) => route.buckle === true),
				).toBe(true);
				expect(routes[0]).toEqual({
					url: hubUrl,
					buckle: true,
					dialect: name.startsWith("claude-") ? "anthropic" : "openai",
					adapter: name.startsWith("claude-") ? "anthropic" : "openai-compat",
					model: name,
					api_key_env: "IKEA_HUB_KEY",
				});
				expect(routes[1]?.url).toBe("http://127.0.0.1:4100");
				expect(
					routes.some((route) => route.url.includes("githubcopilot")),
				).toBe(false);
			}
			expect(preferCopilotHub(first.config, template.groups, hubUrl)).toEqual(
				first,
			);
		});

		test("a missing local group aborts before changing any route", () => {
			const local: UpstreamConfig = { groups: { "claude-sonnet-5": [] } };
			expect(() => preferCopilotHub(local, template.groups, hubUrl)).toThrow(
				"Mac upstream groups missing",
			);
			expect(local.groups["claude-sonnet-5"]).toEqual([]);
		});
	});
});
