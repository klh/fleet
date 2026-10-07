import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { adviceReadiness } from "../hooks/board/advice-readiness.ts";
import { SETUP } from "../hooks/board-html/setup.ts";

const now = Date.now();
const target = {
	port: 8999,
	kind: "ondemand",
	state: "idle",
	alert: false,
	lastProbe: new Date(now).toISOString(),
};
const snapshot = {
	version: 1,
	updated: new Date(now).toISOString(),
	intervalMs: 5000,
	targets: [target],
};
const deps = (doc: unknown = snapshot, status?: number) => ({
	fetch: (async () => {
		if (status === undefined) throw new Error("ECONNREFUSED");
		return new Response("{}", { status });
	}) as typeof fetch,
	readSupervisor: () => doc,
	now: () => now,
});
const origin = "http://127.0.0.1:8999";

describe("advice readiness", () => {
	test("absent on-demand target uses fresh independent lifecycle, without claiming up", async () => {
		const result = await adviceReadiness(origin, deps());
		expect(result).toMatchObject({ ok: false, state: "idle" });
		expect(result.detail).toContain("on demand and not loaded");
		expect(result.observation?.source).toBe("belt-supervisor");
		expect(result.observation?.observedAt).toBe(now);
	});
	test("loaded or required targets and stale/alerting observations remain failures", async () => {
		for (const doc of [
			null,
			{ ...snapshot, targets: [{ ...target, state: "up" }] },
			{ ...snapshot, targets: [{ ...target, kind: "specialist" }] },
			{ ...snapshot, targets: [{ ...target, alert: true }] },
			{
				...snapshot,
				targets: [{ ...target, preflightError: "missing dependency" }],
			},
			{ ...snapshot, updated: new Date(now - 16000).toISOString() },
		]) {
			expect(await adviceReadiness(origin, deps(doc))).toMatchObject({
				ok: false,
				state: "down",
			});
		}
	});
	test("failed HTTP and redirects cannot be excused as idle; live target is up", async () => {
		for (const status of [302, 401, 503]) {
			const result = await adviceReadiness(origin, deps(snapshot, status));
			expect(result).toMatchObject({ ok: false, state: "degraded" });
			expect(result.observation).toBeUndefined();
		}
		expect(await adviceReadiness(origin, deps(snapshot, 200))).toMatchObject({
			ok: true,
			state: "up",
		});
	});
	test("remote same-port endpoint cannot inherit local supervisor evidence", async () => {
		expect(
			await adviceReadiness("http://remote.example:8999", deps()),
		).toMatchObject({ ok: false, state: "down" });
	});
	test("Setup renders neutral idle, while required/down and expired evidence render fail", async () => {
		let markup = "";
		const check = await adviceReadiness(origin, deps());
		const context = {
			Date: { now: () => now },
			setupLoaded: true,
			setupErr: null,
			setupData: { checks: [{ label: "Advice", ...check }] },
			setupOkAt: now,
			byId: () => ({}),
			clearErr: () => {},
			sigSet: (_body: unknown, _sig: unknown, html: string) => {
				markup = html;
			},
			esc: (value: string) => value,
		};
		runInNewContext(`${SETUP}\nrenderSetup();`, context);
		expect(markup).toContain('class="sok dim">idle');
		expect(markup).not.toContain('class="sok ok"');
		context.setupData.checks = [
			{ label: "Required", ...(await adviceReadiness(origin, deps(null))) },
		];
		runInNewContext("renderSetup();", context);
		expect(markup).toContain('class="sok fail">fail');
		context.setupData.checks = [{ label: "Advice", ...check }];
		context.Date.now = () => now + 15000;
		runInNewContext("renderSetup();", context);
		expect(markup).toContain('class="sok fail">fail');
	});
});
