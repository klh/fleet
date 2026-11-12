import { expect, test } from "@playwright/test";
import {
	resolveProvider,
	validateProviderConfig,
} from "@klh/settings/connections";
import {
	applyAccountPolicy,
	scopeSelection,
} from "@klh/buckle/src/account-policy.ts";
import type { RouteSelection } from "@klh/buckle/src/decide.ts";
import { projectConnectionGroups } from "../deploy/hub-connections.ts";

test("known peer provider annotation preserves ordinary account admission; unknown peer origin stays denied", () => {
	const profiles = validateProviderConfig({
		peer: {
			kind: "buckle",
			adapter: "buckle",
			endpoints: { openai: "https://peer-policy.example/v1" },
		},
	});
	const peer = resolveProvider("peer", profiles);
	if (!peer) throw Error("Peer absent");
	const policy = applyAccountPolicy(
		{
			version: 1,
			classes: [
				{
					id: "personal",
					tier: "personal",
					keys: ["ordinary"],
					providers: ["zai", "openrouter"],
					groups: ["*"],
				},
			],
		},
		{
			kind: "api_key",
			keyName: "ordinary",
			claimRepo: null,
			lane: null,
			pin: null,
			group: "exact-model",
		},
	);
	if (!policy.ok || !policy.acct) throw Error("Ordinary class absent");
	for (const known of [true, false]) {
		const row = projectConnectionGroups(
			{
				"exact-model": [
					{
						providerProfile: "peer",
						model: "exact-model",
						dialect: "openai",
						...(known ? { provider: "zai" } : {}),
					},
				],
			},
			[peer],
		)["exact-model"]?.[0];
		if (!row) throw Error("Peer row absent");
		// scopeSelection reads only the ordered row's dep/group; no model/router execution.
		const candidate = {
			group: "exact-model",
			dep: { ...row, group: "exact-model" },
		};
		const selection = {
			ordered: [candidate],
			head: candidate,
		} as unknown as RouteSelection;
		expect(scopeSelection(selection, policy.acct).ok).toBe(known);
		expect(row.provider).toBe(known ? "zai" : "buckle");
	}
});
