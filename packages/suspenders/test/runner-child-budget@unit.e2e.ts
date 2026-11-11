import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import {
	assertReservations,
	parentBudget,
	readReservations,
	releaseChildBudget,
	reserveChildBudget,
} from "../hooks/lib/runners/control/child-budget.ts";
import { admitChildRun } from "../hooks/lib/runners/control/child-admission.ts";
import {
	cancelChildRun,
	completeChildRun,
} from "../hooks/lib/runners/control/child-tracking.ts";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import type { DurableAdapter } from "../hooks/lib/runners/control/controller.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";
import type { RunnerActor } from "../hooks/lib/runners/control/rights.ts";

const recording = (calls: string[]): DurableAdapter => ({
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
});

function childWorld(bounds?: { maxChildren?: number; maxDepth?: number }) {
	const world = scratchWorld({ prefix: "runner-child-budget-" });
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

const admitVia = (w: ReturnType<typeof childWorld>, childKey: string) =>
	admitChildRun(
		{
			store: w.current().store,
			controller: w.current().controller,
			actor: w.actor,
			routes: w.routes,
			bounds: w.bounds,
		},
		{
			parentRunId: w.parent,
			supervisorSid: "supervisor-tests",
			childKey,
			kind: "coding",
			brief: `brief for ${childKey}`,
		},
	);

const reserveVia = (
	w: ReturnType<typeof childWorld>,
	childKey: string,
	tokens: { in: number; out: number; cached: number },
	maxTokens: number,
) =>
	reserveChildBudget(w.current().store, {
		parentRunId: w.parent,
		childKey,
		tokens,
		at: 1_000,
		maxTokens,
	});

const settleVia = (
	w: ReturnType<typeof childWorld>,
	childKey: string,
	tokens: { in: number; out: number; cached: number },
) =>
	completeChildRun(w.current().store, {
		parentRunId: w.parent,
		childKey,
		state: "done",
		at: 2_000,
		tokens,
	});

test("reserve replays identically across the crash window and drift refuses", async () => {
	const w = childWorld();
	const first = reserveVia(w, "alpha", { in: 1200, out: 0, cached: 0 }, 2000);
	expect(first.replayed).toBe(false);
	expect(first.budget.total).toBe(1200);
	w.crash();
	const again = reserveVia(w, "alpha", { in: 1200, out: 0, cached: 0 }, 2000);
	expect(again.replayed).toBe(true);
	expect(() =>
		reserveVia(w, "alpha", { in: 1300, out: 0, cached: 0 }, 2000),
	).toThrow(/reservation drift/);
	expect(readReservations(w.current().store, w.parent)).toHaveLength(1);
	w.close();
});

test("a later retry preserves the original reservation timestamp", () => {
	const w = childWorld();
	try {
		const input = {
			parentRunId: w.parent,
			childKey: "later",
			tokens: { in: 100, out: 20, cached: 0 },
			maxTokens: 1000,
		};
		reserveChildBudget(w.current().store, { ...input, at: 1000 });
		const retry = reserveChildBudget(w.current().store, { ...input, at: 2000 });
		expect(retry.replayed).toBe(true);
		expect(readReservations(w.current().store, w.parent)[0]?.at).toBe(1000);
	} finally {
		w.close();
	}
});

test("two individually affordable children whose combined reservation exceeds the allowance", async () => {
	const w = childWorld();
	const store = w.current().store;
	const alpha = reserveVia(w, "alpha", { in: 1200, out: 0, cached: 0 }, 1500);
	expect(alpha.replayed).toBe(false);
	expect(() =>
		reserveVia(w, "beta", { in: 400, out: 0, cached: 0 }, 1500),
	).toThrow(/budget exhausted/);
	expect(readReservations(store, w.parent)).toHaveLength(1);
	await admitVia(w, "alpha");
	await settleVia(w, "alpha", { in: 900, out: 50, cached: 20 });
	expect(
		releaseChildBudget(store, { parentRunId: w.parent, childKey: "alpha" })
			.released,
	).toBe(true);
	const beta = reserveVia(w, "beta", { in: 400, out: 0, cached: 0 }, 1500);
	expect(beta.replayed).toBe(false);
	expect(beta.budget.total).toBe(950 + 400);
	w.close();
});

test("cancellation returns the reservation to the wave", async () => {
	const w = childWorld();
	const store = w.current().store;
	await admitVia(w, "gamma");
	reserveVia(w, "gamma", { in: 800, out: 0, cached: 0 }, 1000);
	expect(parentBudget(store, w.parent).total).toBe(800);
	await cancelChildRun(
		{ store, controller: w.current().controller, actor: w.actor },
		{ parentRunId: w.parent, childKey: "gamma", at: 3_000 },
	);
	expect(
		releaseChildBudget(store, { parentRunId: w.parent, childKey: "gamma" })
			.released,
	).toBe(true);
	const budget = parentBudget(store, w.parent);
	expect(budget.reserved.children).toBe(0);
	expect(budget.total).toBe(0);
	expect(budget.settled.children).toBe(1);
	w.close();
});

test("release refuses until the receipt settles and replays idempotently", async () => {
	const w = childWorld();
	const store = w.current().store;
	await admitVia(w, "delta");
	reserveVia(w, "delta", { in: 300, out: 0, cached: 0 }, 1000);
	expect(() =>
		releaseChildBudget(store, { parentRunId: w.parent, childKey: "delta" }),
	).toThrow(/no terminal child result/);
	await settleVia(w, "delta", { in: 10, out: 5, cached: 0 });
	const release = () =>
		releaseChildBudget(store, { parentRunId: w.parent, childKey: "delta" });
	expect(release().released).toBe(true);
	expect(release().released).toBe(false);
	w.close();
});

test("a reservation cannot follow its terminal receipt", async () => {
	const w = childWorld();
	await admitVia(w, "zeta");
	await settleVia(w, "zeta", { in: 40, out: 0, cached: 0 });
	expect(() =>
		reserveVia(w, "zeta", { in: 100, out: 0, cached: 0 }, 1000),
	).toThrow(/already settled/);
	w.close();
});

test("assertReservations judges the wave against the allowance", async () => {
	const w = childWorld();
	const store = w.current().store;
	await admitVia(w, "mu");
	await settleVia(w, "mu", { in: 700, out: 0, cached: 0 });
	const within = assertReservations(store, {
		parentRunId: w.parent,
		maxTokens: 800,
	});
	expect(within.budget.total).toBe(700);
	expect(() =>
		assertReservations(store, { parentRunId: w.parent, maxTokens: 600 }),
	).toThrow(/exceeds the allowance/);
	w.close();
});
