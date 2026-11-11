import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import {
	closeChildRun,
	delegateChildRun,
	revokeChildRun,
} from "../hooks/lib/runners/control/child-delegation.ts";
import { readReservations } from "../hooks/lib/runners/control/child-budget.ts";
import {
	parentJoin,
	readIntentKeys,
} from "../hooks/lib/runners/control/child-tracking.ts";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import type { DurableAdapter } from "../hooks/lib/runners/control/controller.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";
import type { RunnerActor } from "../hooks/lib/runners/control/rights.ts";

const recording = (calls: string[]) =>
	({
		start: async () => {
			calls.push("start");
		},
		stop: async () => {
			calls.push("stop");
		},
		resume: async () => {
			calls.push("resume");
		},
		submit: async () => {
			calls.push("submit");
		},
	}) as DurableAdapter;

function childWorld(bounds?: { maxChildren?: number; maxDepth?: number }) {
	const world = scratchWorld({ prefix: "runner-child-deleg-" });
	const path = join(world.repo, "runner-control.db");
	const calls: string[] = [];
	const actor: RunnerActor = {
		sid: "supervisor-tests",
		scopes: ["buckle:runner:WRITE_"],
	};
	const routes = [
		{ provider: "belt", model: "glm-5.3-flash" },
		{ provider: "belt", model: "glm-5.3" },
	];
	let t = 1_000_000_000_000;
	const now = () => t;
	const tick = (ms: number) => {
		t += ms;
	};
	const open = () => {
		const db = new Database(path);
		const store = sqliteStore(db);
		const controller = openRunnerController({
			store,
			durable: recording(calls),
			now,
			leaseTtlMs: 1_000,
		});
		return { db, store, controller };
	};
	let current = open();
	const crash = () => {
		current.db.close();
		// A restart takes wall time; the crashed lease must be provably stale
		// before the restarted supervisor can take the run over (epoch bump).
		tick(2_000);
		current = open();
	};
	const close = () => {
		current.db.close();
		world.clean();
	};
	const parent = randomUUID();
	return {
		calls,
		routes,
		parent,
		actor,
		bounds,
		current: () => current,
		crash,
		close,
		tick,
	};
}

const delegateVia = (
	w: ReturnType<typeof childWorld>,
	childKey: string,
	tokens: { in: number; out: number; cached: number },
	maxTokens: number,
) =>
	delegateChildRun(
		{
			store: w.current().store,
			controller: w.current().controller,
			actor: w.actor,
			routes: w.routes,
			bounds: w.bounds,
			now: () => 1_000,
		},
		{
			parentRunId: w.parent,
			supervisorSid: "supervisor-tests",
			childKey,
			kind: "coding",
			brief: `brief for ${childKey}`,
			tokens,
			maxTokens,
		},
	);

test("delegate reserves the budget then admits through the ledger", async () => {
	const w = childWorld();
	const first = await delegateVia(
		w,
		"alpha",
		{ in: 500, out: 100, cached: 0 },
		2000,
	);
	expect(first.replayed).toBe(false);
	expect(first.reservationReplayed).toBe(false);
	expect(first.runId).toBeTruthy();
	expect(first.token).toBeTruthy();
	// The supervisor's submit leg starts the cold child (durable start+submit)
	const submitted = await w.current().controller.submit({
		runId: first.runId,
		text: "begin",
		actor: w.actor,
	});
	expect(submitted.ok).toBe(true);
	expect(w.calls).toEqual(["start", "submit"]);
	expect(readReservations(w.current().store, w.parent)).toHaveLength(1);
	w.close();
});

test("a denied child route consumes no parent reservation", async () => {
	const w = childWorld();
	try {
		await expect(
			delegateChildRun(
				{
					store: w.current().store,
					controller: w.current().controller,
					actor: w.actor,
					routes: w.routes,
				},
				{
					parentRunId: w.parent,
					supervisorSid: w.actor.sid,
					childKey: "denied",
					kind: "coding",
					brief: "inspect",
					route: { provider: "unknown", model: "unknown" },
					tokens: { in: 100, out: 10, cached: 0 },
					maxTokens: 1000,
				},
			),
		).rejects.toThrow(/allowlist/);
		expect(readReservations(w.current().store, w.parent)).toEqual([]);
		expect(readIntentKeys(w.current().store, w.parent)).toEqual([]);
		expect(w.calls).toEqual([]);
	} finally {
		w.close();
	}
});

test("denied cancellation preserves the reservation and parent join", async () => {
	const w = childWorld();
	try {
		await delegateVia(w, "held", { in: 100, out: 10, cached: 0 }, 1000);
		await expect(
			revokeChildRun(
				{
					store: w.current().store,
					controller: w.current().controller,
					actor: { ...w.actor, scopes: [] },
					routes: w.routes,
				},
				{
					parentRunId: w.parent,
					childKey: "held",
					at: 3000,
				},
			),
		).rejects.toThrow(/denied abort/);
		expect(readReservations(w.current().store, w.parent)).toHaveLength(1);
		expect(parentJoin(w.current().store, w.parent).joined).toBe(false);
		await expect(
			revokeChildRun(
				{
					store: w.current().store,
					actor: w.actor,
					routes: w.routes,
					controller: {
						...w.current().controller,
						stopWithRevocation: async () => ({
							ok: false,
							reason: "cleanup refused",
						}),
					},
				},
				{
					parentRunId: w.parent,
					childKey: "held",
					at: 3001,
				},
			),
		).rejects.toThrow(/did not confirm/);
		expect(readReservations(w.current().store, w.parent)).toHaveLength(1);
	} finally {
		w.close();
	}
});

test("an over-budget wave refuses before the controller admits", async () => {
	const w = childWorld();
	const alpha = await delegateVia(
		w,
		"alpha",
		{ in: 800, out: 0, cached: 0 },
		1000,
	);
	const submitted = await w.current().controller.submit({
		runId: alpha.runId,
		text: "begin",
		actor: w.actor,
	});
	expect(submitted.ok).toBe(true);
	expect(w.calls).toEqual(["start", "submit"]);
	await expect(
		delegateVia(w, "beta", { in: 400, out: 0, cached: 0 }, 1000),
	).rejects.toThrow(/budget exhausted/);
	// beta never minted an intent: the reservation gate sits BEFORE admission
	expect(readIntentKeys(w.current().store, w.parent)).toEqual(["alpha"]);
	expect(w.calls).toEqual(["start", "submit"]);
	w.close();
});

test("close settles the receipt, releases the reservation and joins the parent", async () => {
	const w = childWorld();
	const store = w.current().store;
	await delegateVia(w, "alpha", { in: 500, out: 100, cached: 0 }, 2000);
	const close = await closeChildRun(
		{
			store,
			controller: w.current().controller,
			actor: w.actor,
			routes: w.routes,
		},
		{
			parentRunId: w.parent,
			childKey: "alpha",
			state: "done",
			at: 2_000,
			tokens: { in: 300, out: 20, cached: 5 },
		},
	);
	expect(close.replayed).toBe(false);
	expect(close.released).toBe(true);
	expect(readReservations(store, w.parent)).toHaveLength(0);
	expect(parentJoin(store, w.parent).joined).toBe(true);
	w.close();
});

test("revoke aborts the child, settles zero spend and frees the budget", async () => {
	const w = childWorld();
	const store = w.current().store;
	const alpha = await delegateVia(
		w,
		"alpha",
		{ in: 400, out: 0, cached: 0 },
		1000,
	);
	const submitted = await w.current().controller.submit({
		runId: alpha.runId,
		text: "begin",
		actor: w.actor,
	});
	expect(submitted.ok).toBe(true);
	const revoke = await revokeChildRun(
		{
			store,
			controller: w.current().controller,
			actor: w.actor,
			routes: w.routes,
		},
		{
			parentRunId: w.parent,
			childKey: "alpha",
			at: 3_000,
			reason: "wave collapsed",
		},
	);
	expect(revoke.replayed).toBe(false);
	expect(revoke.released).toBe(true);
	expect(w.calls).toEqual(["start", "submit", "stop"]);
	expect(readReservations(store, w.parent)).toEqual([]);
	w.close();
});

test("delegate replays identically across the crash window", async () => {
	const w = childWorld();
	const first = await delegateVia(
		w,
		"gamma",
		{ in: 600, out: 0, cached: 0 },
		2000,
	);
	expect(first.replayed).toBe(false);
	w.crash();
	const again = await delegateVia(
		w,
		"gamma",
		{ in: 600, out: 0, cached: 0 },
		2000,
	);
	expect(again.replayed).toBe(true);
	expect(again.reservationReplayed).toBe(true);
	expect(readReservations(w.current().store, w.parent)).toHaveLength(1);
	expect(readIntentKeys(w.current().store, w.parent)).toEqual(["gamma"]);
	w.close();
});
