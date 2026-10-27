// egress-visibility.test.ts — W1264.2: the honest visibility-tier model.
// Proves the two laws: CONNECT is never an L7 API call (transport rows
// never become request rows), and selective TLS inspection is scoped to
// trusted apps on verified routes with pinning fallback — plus the owner
// boundary: the adapter metadata rides the W918 catalog, never a new list.
import { expect, test } from "@playwright/test";
import {
	DEFAULT_EGRESS_TRUST,
	buckleRouteAdapters,
	classifyVisibility,
	hostMatchesSuffix,
	summarizeVisibility,
	type EgressTrustSource,
} from "../hooks/lib/egress-visibility.ts";
import { VERIFIED_BUCKLE_ROUTES, listTargets } from "../hooks/lib/targets.ts";
import { agents, type AgentType } from "../hooks/lib/vendor/skills-agents.ts";

/** One trusted catalog app with a pinned-host suffix for fallback proofs. */
const trustRequest: EgressTrustSource = {
	requestCapableApps: new Set<AgentType>(["claude-code"]),
	verifiedRoutes: new Set<AgentType>(["claude-code"]),
	trustedApps: new Set<AgentType>(["claude-code"]),
	pinnedDestinations: ["pinned.example"],
};

test.describe("classifyVisibility", () => {
	test("trusted app on a verified route → request tier", () => {
		const verdict = classifyVisibility(
			{ agentType: "claude-code", destinationHost: "api.anthropic.com" },
			trustRequest,
		);
		expect(verdict.tier).toBe("request");
		expect(verdict.requestAware).toBe(true);
	});

	test("trusted app, pinned destination → pinning-fallback, never request", () => {
		const verdict = classifyVisibility(
			{ agentType: "claude-code", destinationHost: "api.pinned.example" },
			trustRequest,
		);
		expect(verdict.tier).toBe("pinning-fallback");
		expect(verdict.requestAware).toBe(false);
	});
});

test.describe("classifyVisibility transport gates", () => {
	test("verified route but no operator trust → transport", () => {
		const verdict = classifyVisibility(
			{ agentType: "claude-code", destinationHost: "api.anthropic.com" },
			{
				requestCapableApps: new Set<AgentType>(["claude-code"]),
				verifiedRoutes: new Set<AgentType>(["claude-code"]),
				trustedApps: new Set<AgentType>(),
				pinnedDestinations: [],
			},
		);
		expect(verdict.tier).toBe("transport");
		expect(verdict.reason).toContain("trust");
	});

	test("operator trust but unverified route → transport (route unaudited)", () => {
		const verdict = classifyVisibility(
			{ agentType: "codex", destinationHost: "api.openai.com" },
			{
				requestCapableApps: new Set<AgentType>(["codex"]),
				verifiedRoutes: new Set<AgentType>(),
				trustedApps: new Set<AgentType>(["codex"]),
				pinnedDestinations: [],
			},
		);
		expect(verdict.tier).toBe("transport");
		expect(verdict.reason).toContain("route");
	});

	test("capability-absent target stays transport even when trusted and verified", () => {
		const verdict = classifyVisibility(
			{ agentType: "cursor", destinationHost: "api.anthropic.com" },
			{
				requestCapableApps: new Set<AgentType>(),
				verifiedRoutes: new Set<AgentType>(["cursor"]),
				trustedApps: new Set<AgentType>(["cursor"]),
				pinnedDestinations: [],
			},
		);
		expect(verdict.tier).toBe("transport");
		expect(verdict.reason).toContain("capability");
	});
});

test.describe("classifyVisibility attribution", () => {
	test("no catalog attribution → unattributed, never guessed", () => {
		const verdict = classifyVisibility(
			{ agentType: null, destinationHost: "unknown-ai.example" },
			trustRequest,
		);
		expect(verdict.tier).toBe("unattributed");
		expect(verdict.requestAware).toBe(false);
	});

	test("default trust keeps verified routes at transport until trust is deployed", () => {
		const verdict = classifyVisibility(
			{ agentType: "claude-code", destinationHost: "api.anthropic.com" },
			DEFAULT_EGRESS_TRUST,
		);
		expect(verdict.tier).toBe("transport");
		expect(verdict.requestAware).toBe(false);
	});

	test("default capability set includes the four researched targets, trust still gates", () => {
		const verdict = classifyVisibility(
			{ agentType: "grok", destinationHost: "api.x.ai" },
			DEFAULT_EGRESS_TRUST,
		);
		expect(verdict.tier).toBe("transport");
		expect(verdict.reason).toContain("trust");
	});
});

test.describe("hostMatchesSuffix", () => {
	test("exact and subdomain matches", () => {
		expect(hostMatchesSuffix("x.pin", ["x.pin"])).toBe(true);
		expect(hostMatchesSuffix("api.x.pin", ["x.pin"])).toBe(true);
	});

	test("label boundary holds: no substring matches", () => {
		expect(hostMatchesSuffix("notx.pin", ["x.pin"])).toBe(false);
		expect(hostMatchesSuffix("x.pin.evil.example", ["x.pin"])).toBe(false);
	});
});

test.describe("buckleRouteAdapters", () => {
	test("full catalog breadth, universal excluded — gated, not trimmed", () => {
		const rows = buckleRouteAdapters(trustRequest);
		const expected = Object.keys(agents).filter((t) => t !== "universal");
		expect(rows.map((r) => r.type)).toEqual(expected);
	});

	test("requestEligible requires BOTH verified route and operator trust", () => {
		const rows = new Map(
			buckleRouteAdapters(trustRequest).map((r) => [r.type, r]),
		);
		const claude = rows.get("claude-code");
		expect(claude?.routeVerified).toBe(true);
		expect(claude?.trusted).toBe(true);
		expect(claude?.requestEligible).toBe(true);
		const codex = rows.get("codex");
		expect(codex?.requestCapable).toBe(false); // not in trustRequest's capable set
		expect(codex?.routeVerified).toBe(false);
		expect(codex?.trusted).toBe(false);
		expect(codex?.requestEligible).toBe(false);
	});

	test("VERIFIED_BUCKLE_ROUTES derives from the targets.ts evidence table", () => {
		expect(VERIFIED_BUCKLE_ROUTES.has("claude-code")).toBe(true);
		expect(VERIFIED_BUCKLE_ROUTES.has("codex")).toBe(true);
		const catalogTypes = listTargets("").map((t) => t.type);
		for (const type of VERIFIED_BUCKLE_ROUTES)
			expect(catalogTypes).toContain(type);
	});
});

test.describe("summarizeVisibility", () => {
	test("per-tier counts with requestAware equal to the request count only", () => {
		const summary = summarizeVisibility(
			[
				{ host: "api.anthropic.com", agentType: "claude-code" },
				{ host: "api.pinned.example", agentType: "claude-code" },
				{ host: "random.example", agentType: "codex" },
				{ host: "unknown-ai.example", agentType: null },
			],
			trustRequest,
		);
		expect(summary.requestAware).toBe(1);
		expect(summary.tiers.request).toBe(1);
		expect(summary.tiers["pinning-fallback"]).toBe(1);
		expect(summary.tiers.transport).toBe(1);
		expect(summary.tiers.unattributed).toBe(1);
	});

	test("transport rows never fold into requestAware even at scale", () => {
		const summary = summarizeVisibility(
			Array.from({ length: 50 }, (_, i) =>
				i === 49
					? {
							host: "api.pinned.example",
							agentType: "claude-code" as AgentType,
						} // pinned trusted row
					: {
							host: `host-${i}.example`,
							agentType: "codex" as AgentType, // untrusted under trustRequest
						},
			),
			trustRequest,
		);
		expect(summary.tiers.transport).toBe(49);
		expect(summary.tiers["pinning-fallback"]).toBe(1);
		expect(summary.requestAware).toBe(0);
	});
});
