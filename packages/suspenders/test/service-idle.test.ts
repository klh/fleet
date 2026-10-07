import { describe, expect, test } from "bun:test";
import { isOnDemandIdle } from "../hooks/board/supervisor-snapshot.ts";
import {
	probeService,
	withRecovery,
	type ProbeDeps,
} from "../hooks/board/service-probe.ts";
import {
	rowModel,
	ServiceRowController,
} from "../hooks/board-html/service-row-model.ts";
import {
	beltPage,
	localPage,
	serviceRowHtml,
} from "../hooks/bin/console-html.ts";

const now = new Date();
const target = {
	port: 8901,
	kind: "ondemand",
	state: "idle",
	alert: false,
	lastProbe: now.toISOString(),
};
const snapshot = {
	version: 1,
	updated: now.toISOString(),
	intervalMs: 5000,
	targets: [target],
};
const deps = (status?: number, doc: unknown = snapshot): ProbeDeps => ({
	fetch: async () => {
		if (status === undefined) throw new Error("ECONNREFUSED");
		return new Response("{}", { status });
	},
	launchctl: async () => ({ code: 113, out: "" }),
	now: () => now,
	readSupervisor: () => doc,
});

describe("on-demand service state", () => {
	test("requires recent document and target probes with no active alert", () => {
		expect(isOnDemandIdle(snapshot, 8901, now.getTime())).toBe(true);
		for (const doc of [
			null,
			{},
			{ ...snapshot, updated: "invalid" },
			{ ...snapshot, updated: new Date(now.getTime() - 16_000).toISOString() },
			{ ...snapshot, targets: [{ ...target, lastProbe: "invalid" }] },
			{
				...snapshot,
				targets: [
					{
						...target,
						lastProbe: new Date(now.getTime() - 16_000).toISOString(),
					},
				],
			},
			{ ...snapshot, targets: [{ ...target, kind: "specialist" }] },
			{ ...snapshot, targets: [{ ...target, alert: true }] },
			{
				...snapshot,
				targets: [{ ...target, preflightError: "dependency missing" }],
			},
		]) {
			expect(isOnDemandIdle(doc, 8901, now.getTime())).toBe(false);
		}
		expect(isOnDemandIdle(snapshot, 8902, now.getTime())).toBe(false);
	});
	test("fresh idle excuses only absence, never a failing HTTP response", async () => {
		expect((await probeService("swarm-8901", deps()))?.state).toBe("idle");
		expect((await probeService("swarm-8901", deps(503)))?.state).toBe(
			"degraded",
		);
		expect((await probeService("swarm-8901", deps(200)))?.state).toBe("up");
		expect(
			(await probeService("swarm-8901", deps(undefined, null)))?.state,
		).toBe("down");
		expect((await probeService("swarm-8902", deps()))?.state).toBe("down");
	});
	test("idle evidence retains the supervisor times and never gains freshness from a re-probe", async () => {
		const doc = {
			...snapshot,
			updated: new Date(now.getTime() - 2_000).toISOString(),
			targets: [
				{
					...target,
					lastProbe: new Date(now.getTime() - 14_000).toISOString(),
				},
			],
		};
		const probe = await probeService("swarm-8901", deps(undefined, doc));
		if (!probe) throw new Error("missing service");
		expect(probe.state).toBe("idle");
		expect(probe.observation).toMatchObject({
			source: "belt-supervisor",
			kind: "supervisor",
			observedAt: now.getTime() - 14_000,
			expiresAt: now.getTime() + 1_000,
		});
		expect(rowModel(withRecovery(probe), now.getTime() + 999).badge).toBe(
			"IDLE",
		);
		expect(rowModel(withRecovery(probe), now.getTime() + 1_000).badge).toBe(
			"STALE",
		);
		const repeated = await probeService("swarm-8901", {
			...deps(undefined, doc),
			now: () => new Date(now.getTime() + 500),
		});
		expect(repeated?.observation).toEqual(probe.observation);
		const expired = await probeService("swarm-8901", {
			...deps(undefined, doc),
			now: () => new Date(now.getTime() + 1_000),
		});
		expect(expired?.state).toBe("down");
	});
	test("idle rows offer no restart commands in Lit or no-JS fallback", async () => {
		const probe = await probeService("swarm-8901", deps());
		if (!probe) throw new Error("missing service");
		const row = withRecovery(probe);
		const model = rowModel(row);
		expect(model.badge).toBe("IDLE");
		expect(model.showRecovery).toBe(false);
		expect(model.steps).toEqual([]);
		expect(serviceRowHtml(row)).not.toContain("how to recover");
		const page = localPage({
			services: [],
			regPath: "",
			error: null,
			source: "probes",
			probes: [probe],
		});
		expect(page).toContain("0/1 up · 1 on demand");
		expect(page).toContain("<klh-service-row");
		expect(page).toContain("/vendor/klh-service-row.js");
		expect(page).not.toContain("how to recover");
		const belt = beltPage({
			policy: null,
			gateway: null,
			policyError: null,
			beltApi: null,
			health: [row],
			groups: null,
		});
		expect(belt).toContain("Gateway transports · 0/0 up");
		expect(belt).not.toContain('data-service="swarm-8901"');
		expect(belt).not.toContain("need recovery");
	});
	test("idle rows can observe activation through the existing re-probe controller", async () => {
		const idle = await probeService("swarm-8901", deps());
		const up = await probeService("swarm-8901", deps(200));
		if (!idle || !up) throw new Error("missing service");
		const controller = new ServiceRowController(withRecovery(idle));
		const result = await controller.reprobe(async () =>
			Response.json({ ok: true, service: withRecovery(up) }),
		);
		expect(result.state).toBe("up");
	});
});
