import { expect, test } from "@playwright/test";
import { providerObservationsFromRequests } from "../bin/hubs.ts";

const now = Date.parse("2026-10-20T17:00:00Z");
const routes = {
	name: "DESKTOP",
	models: ["claude-sonnet-5", "gpt-5.2", "chatgpt/gpt-6-sol"],
	routeCount: 4,
	unresolvedRoutes: [],
	routesByModel: {
		"claude-sonnet-5": ["anthropic/claude-sonnet-5"],
		"gpt-5.2": ["openai/gpt-5.2"],
		"chatgpt/gpt-6-sol": ["chatgpt/gpt-6-sol"],
		ambiguous: ["openai/ambiguous", "anthropic/ambiguous"],
	},
	providerIntents: ["anthropic", "openai", "chatgpt"],
	providerHosts: [],
	providerHostsByModel: {},
	targetPortsByModel: {},
	providerModelIds: {},
};

test("hub provider status follows fresh Buckle outcomes for unambiguous configured models @unit", () => {
	const rows = [
		{
			ts: "2026-10-20T16:59:00Z",
			target_model: "claude-sonnet-5",
			status: 200,
			ok: 1,
			traffic_kind: "inference",
		},
		{
			ts: "2026-10-20T16:58:00Z",
			target_model: "gpt-5.2",
			status: 429,
			ok: 0,
			traffic_kind: "inference",
		},
		{
			ts: "2026-10-20T16:57:00Z",
			target_model: "chatgpt/gpt-6-sol",
			status: 200,
			ok: 1,
			traffic_kind: "inference",
		},
		{
			ts: "2026-10-20T16:56:00Z",
			target_model: "ambiguous",
			status: 200,
			ok: 1,
			traffic_kind: "inference",
		},
		{
			ts: "2026-10-20T16:40:00Z",
			target_model: "gpt-5.2",
			status: 200,
			ok: 1,
			traffic_kind: "inference",
		},
	];
	expect(
		providerObservationsFromRequests("DESKTOP", routes, rows, now),
	).toEqual([
		{
			hub: "DESKTOP",
			provider: "anthropic",
			successes15: 1,
			failures15: 0,
			lastStatus: 200,
			lastAt: "2026-10-20T16:59:00Z",
		},
		{
			hub: "DESKTOP",
			provider: "openai",
			successes15: 0,
			failures15: 1,
			lastStatus: 429,
			lastAt: "2026-10-20T16:58:00Z",
		},
		{
			hub: "DESKTOP",
			provider: "chatgpt",
			successes15: 1,
			failures15: 0,
			lastStatus: 200,
			lastAt: "2026-10-20T16:57:00Z",
		},
	]);
});

test("a single declared provider owns otherwise unnamed routes on its hub @unit", () => {
	const dedicated = {
		...routes,
		providerIntents: ["zai"],
		routesByModel: { "zai-glm-5.3-flash": ["glm-5.3-flash"] },
	};
	expect(
		providerObservationsFromRequests(
			"ZAI",
			dedicated,
			[
				{
					ts: "2026-10-20T16:59:00Z",
					target_model: "zai-glm-5.3-flash",
					status: 200,
					ok: 1,
					traffic_kind: "inference",
				},
			],
			now,
		),
	).toEqual([
		{
			hub: "ZAI",
			provider: "zai",
			successes15: 1,
			failures15: 0,
			lastStatus: 200,
			lastAt: "2026-10-20T16:59:00Z",
		},
	]);
});
