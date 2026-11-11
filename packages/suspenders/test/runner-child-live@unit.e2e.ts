import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
	delegateChildRun,
	revokeChildRun,
} from "../hooks/lib/runners/control/child-delegation.ts";
import { readReservations } from "../hooks/lib/runners/control/child-budget.ts";
import { readIntentKeys } from "../hooks/lib/runners/control/child-tracking.ts";
import { liveChildWorld } from "./runner-child-live.fixtures.ts";

test("delegation admits a real Docker child, replays and cancels @unit", async () => {
	test.setTimeout(90000);
	test.skip(
		Bun.spawnSync(["docker", "info"], {
			stdout: "ignore",
			stderr: "ignore",
		}).exitCode !== 0,
		"Docker Desktop is required",
	);
	const w = await liveChildWorld();
	const input = {
		parentRunId: randomUUID(),
		supervisorSid: w.actor.sid,
		childKey: "inspect",
		kind: "coding" as const,
		brief: "inspect seed",
		tokens: { in: 100, out: 100, cached: 0 },
		maxTokens: 1000,
	};
	try {
		await expect(
			delegateChildRun(w.deps, {
				...input,
				route: { provider: "unknown", model: "unknown" },
			}),
		).rejects.toThrow(/allowlist/);
		expect(readReservations(w.store, input.parentRunId)).toEqual([]);
		expect(readIntentKeys(w.store, input.parentRunId)).toEqual([]);
		expect(w.counts().minted).toBe(0);
		const child = await delegateChildRun(w.deps, input);
		expect(child.replayed).toBe(false);
		const submission = {
			runId: child.runId,
			actor: w.actor,
			text: input.brief,
			requestId: "inspect-seed",
		};
		expect((await w.leaf.controller.submit(submission)).ok).toBe(true);
		await expect.poll(() => w.model.requests.length).toBe(2);
		expect(JSON.stringify(w.model.requests[1]?.body)).toContain(
			"delegated fixture seed",
		);
		await expect(
			w.leaf.controller.read({
				runId: child.runId,
				actor: { sid: "other-lane", scopes: [] },
			}),
		).rejects.toThrow(/denied read/);
		const replay = await delegateChildRun(w.deps, input);
		expect(replay.runId).toBe(child.runId);
		expect(replay.reservationReplayed).toBe(true);
		expect((await w.leaf.controller.submit(submission)).ok).toBe(true);
		expect(w.model.requests.length).toBe(2);
		expect(w.counts().minted).toBe(1);
		w.holdModel();
		await w.leaf.controller.submit({ ...submission, requestId: "hold-model" });
		await expect.poll(() => w.model.requests.length).toBe(3);
		await revokeChildRun(w.deps, { ...input, at: Date.now() });
		expect(readReservations(w.store, input.parentRunId)).toEqual([]);
		expect(w.counts().revoked).toBe(1);
		const { containerNameOf } = await import(
			"../hooks/lib/runners/desktop/docker-executor.ts"
		);
		await expect
			.poll(
				() =>
					Bun.spawnSync(
						["docker", "container", "inspect", containerNameOf(child.runId)],
						{
							stdout: "ignore",
							stderr: "ignore",
						},
					).exitCode,
			)
			.not.toBe(0);
	} finally {
		await w.close();
	}
});
