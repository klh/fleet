// egress-reconcile.test.ts — W1264.2: connection-count reconciliation.
// Proves the join is by unique id ONLY (no host/time heuristics), that one
// tunnel connection may carry many requests (multiplexing ≠ equality), and
// that requestAware is counted from gateway metadata alone — a transport
// observation never promotes.
import { describe, expect, test } from "bun:test";
import {
	reconcileConnections,
	summarizeReconciliation,
	type GatewayRequestRow,
	type TunnelConnection,
} from "../hooks/lib/egress-reconcile.ts";
import type { EgressTrustSource } from "../hooks/lib/egress-visibility.ts";
import type { AgentType } from "../hooks/lib/vendor/skills-agents.ts";

const trustAll: EgressTrustSource = {
	requestCapableApps: new Set<AgentType>(["claude-code"]),
	verifiedRoutes: new Set<AgentType>(["claude-code"]),
	trustedApps: new Set<AgentType>(["claude-code"]),
	pinnedDestinations: ["pinned.example"],
};

const tunnel = (
	id: string,
	over: Partial<TunnelConnection> = {},
): TunnelConnection => ({
	id,
	process: "claude",
	host: "api.anthropic.com",
	port: 443,
	start: 1000,
	agentType: "claude-code",
	...over,
});

const gateway = (
	id: string,
	over: Partial<GatewayRequestRow> = {},
): GatewayRequestRow => ({
	id,
	tunnelConnId: id,
	model: "glm-5.3",
	start: 1001,
	...over,
});

describe("reconcileConnections", () => {
	test("strict id join: matched, tunnelOnly, gatewayOnly partition exactly", () => {
		const t = [tunnel("c1"), tunnel("c2"), tunnel("c3")];
		const g = [gateway("r1", { tunnelConnId: "c1" }), gateway("r2")];
		const rec = reconcileConnections(t, g);
		expect(rec.matched).toEqual([{ tunnelId: "c1", gatewayId: "r1" }]);
		expect(rec.tunnelOnly.map((c) => c.id)).toEqual(["c2", "c3"]);
		expect(rec.gatewayOnly.map((r) => r.id)).toEqual(["r2"]);
		expect(rec.counts).toEqual({
			tunnel: 3,
			gateway: 2,
			matchedTunnel: 1,
			matchedGateway: 1,
			tunnelOnly: 2,
			gatewayOnly: 1,
		});
	});

	test("multiplexing: many requests ride ONE tunnel connection — counts differ by design", () => {
		const t = [tunnel("c1")];
		const g = [
			gateway("r1", { tunnelConnId: "c1" }),
			gateway("r2", { tunnelConnId: "c1" }),
			gateway("r3", { tunnelConnId: "c1" }),
		];
		const rec = reconcileConnections(t, g);
		expect(rec.counts.matchedTunnel).toBe(1);
		expect(rec.counts.matchedGateway).toBe(3);
	});

	test("lookalike rows stay unmatched — id is the only join key", () => {
		const t = [tunnel("cX", { host: "api.anthropic.com", start: 1000 })];
		const g = [gateway("rX", { tunnelConnId: null })];
		const rec = reconcileConnections(t, g);
		expect(rec.matched).toEqual([]);
		expect(rec.counts.tunnelOnly).toBe(1);
		expect(rec.counts.gatewayOnly).toBe(1);
	});
});

describe("summarizeReconciliation", () => {
	test("tiers classify tunnel rows; requestAware counts gateway models only", () => {
		const t = [
			tunnel("c1"),
			tunnel("c2", { agentType: null, host: "unknown-ai.example" }),
			tunnel("c3", { host: "api.pinned.example" }),
		];
		const g = [
			gateway("r1", { tunnelConnId: "c1", model: "glm-5.3" }),
			gateway("r2", { tunnelConnId: null, model: null }),
		];
		const summary = summarizeReconciliation(t, g, trustAll);
		expect(summary.tiers.request).toBe(1);
		expect(summary.tiers.unattributed).toBe(1);
		expect(summary.tiers["pinning-fallback"]).toBe(1);
		expect(summary.requestAware).toBe(1);
	});

	test("requestAware derives from gateway metadata, never from transport observation", () => {
		const t = [tunnel("c1"), tunnel("c2")];
		const g = [
			gateway("r1", { tunnelConnId: "c1", model: null }),
			gateway("r2", { tunnelConnId: "c2", model: "glm-5.3" }),
		];
		const summary = summarizeReconciliation(t, g, trustAll);
		expect(summary.requestAware).toBe(1);
		expect(summary.tiers.request).toBe(2);
	});
});
