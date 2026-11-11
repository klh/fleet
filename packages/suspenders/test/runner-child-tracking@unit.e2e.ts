import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { admitChildRun } from "../hooks/lib/runners/control/child-admission.ts";
import {
	cancelChildRun,
	completeChildRun,
	parentAttribution,
	parentJoin,
	parentSpend,
	assertBudget,
	readResults,
} from "../hooks/lib/runners/control/child-tracking.ts";
import type { DurableAdapter } from "../hooks/lib/runners/control/controller.ts";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import type { RunnerActor } from "../hooks/lib/runners/control/rights.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";

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
	const world = scratchWorld({ prefix: "runner-child-" });
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

const admitVia = (
	w: ReturnType<typeof childWorld>,
	childKey: string,
	extra: Partial<Parameters<typeof admitChildRun>[1]> = {},
) =>
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
			...extra,
		},
	);

test("completion flips the parent join and rides the intent attribution", async () => {
	const w = childWorld();
	try {
		const admitted = await admitVia(w, "implement");
		const join0 = parentJoin(w.current().store, w.parent);
		expect(join0.joined).toBe(false);
		expect(join0.children).toEqual(["implement"]);
		expect(join0.outstanding).toEqual(["implement"]);
		await completeChildRun(w.current().store, {
			parentRunId: w.parent,
			childKey: "implement",
			state: "done",
			at: 42,
			tokens: { in: 100, out: 20, cached: 50 },
			artifacts: [{ path: "patch.diff", digest: "a".repeat(64), bytes: 128 }],
		});
		const join = parentJoin(w.current().store, w.parent);
		expect(join.joined).toBe(true);
		expect(join.terminal).toEqual(["implement"]);
		const results = readResults(w.current().store, w.parent);
		expect(results).toHaveLength(1);
		expect(results[0]?.provider).toBe("belt");
		expect(results[0]?.model).toBe("glm-5.3-flash");
		expect(results[0]?.runId).toBe(admitted.runId);
		expect(results[0]?.artifacts).toHaveLength(1);
	} finally {
		w.close();
	}
});

test("completion refuses a child with no admitted intent", async () => {
	const w = childWorld();
	try {
		await admitVia(w, "implement");
		await expect(
			completeChildRun(w.current().store, {
				parentRunId: w.parent,
				childKey: "ghost",
				state: "done",
				at: 42,
				tokens: { in: 1, out: 1, cached: 0 },
			}),
		).rejects.toThrow(/no admitted child intent/);
	} finally {
		w.close();
	}
});

test("replay is idempotent and drift refuses with the row unchanged", async () => {
	const w = childWorld();
	try {
		await admitVia(w, "implement");
		const input = {
			parentRunId: w.parent,
			childKey: "implement",
			state: "done",
			at: 42,
			tokens: { in: 100, out: 20, cached: 50 },
		} as const;
		const first = await completeChildRun(w.current().store, input);
		expect(first.replayed).toBe(false);
		const replay = await completeChildRun(w.current().store, input);
		expect(replay.replayed).toBe(true);
		await expect(
			completeChildRun(w.current().store, {
				...input,
				tokens: { in: 100, out: 21, cached: 50 },
			}),
		).rejects.toThrow(/child result drift/);
		expect(readResults(w.current().store, w.parent)).toHaveLength(1);
	} finally {
		w.close();
	}
});

test("attribution rolls up per route and spend totals every child", async () => {
	const w = childWorld();
	try {
		await admitVia(w, "implement");
		await admitVia(w, "review");
		await admitVia(w, "scan", { route: w.routes[1] });
		const done = (
			childKey: string,
			tokens: { in: number; out: number; cached: number },
		) =>
			completeChildRun(w.current().store, {
				parentRunId: w.parent,
				childKey,
				state: "done",
				at: 42,
				tokens,
			});
		await done("implement", { in: 100, out: 20, cached: 50 });
		await done("review", { in: 30, out: 10, cached: 0 });
		await done("scan", { in: 5, out: 2, cached: 0 });
		const rows = parentAttribution(w.current().store, w.parent);
		expect(rows).toHaveLength(2);
		const flash = rows.find((row) => row.model === "glm-5.3-flash");
		const full = rows.find((row) => row.model === "glm-5.3");
		expect(flash).toMatchObject({
			provider: "belt",
			children: 2,
			tokens: { in: 130, out: 30, cached: 50 },
		});
		expect(full).toMatchObject({
			provider: "belt",
			children: 1,
			tokens: { in: 5, out: 2, cached: 0 },
		});
		const spend = parentSpend(w.current().store, w.parent);
		expect(spend.children).toBe(3);
		expect(spend.tokens).toEqual({ in: 135, out: 32, cached: 50 });
	} finally {
		w.close();
	}
});

test("restart between receipts neither duplicates nor loses a child", async () => {
	const w = childWorld();
	try {
		await admitVia(w, "implement");
		await admitVia(w, "review");
		const complete = (childKey: string, at: number) =>
			completeChildRun(w.current().store, {
				parentRunId: w.parent,
				childKey,
				state: "done",
				at,
				tokens: { in: 100, out: 20, cached: 50 },
			});
		await complete("implement", 42);
		w.crash();
		const replay = await complete("implement", 42);
		expect(replay.replayed).toBe(true);
		await complete("review", 43);
		const join = parentJoin(w.current().store, w.parent);
		expect(join.joined).toBe(true);
		expect(join.children).toEqual(["implement", "review"]);
		expect(readResults(w.current().store, w.parent)).toHaveLength(2);
	} finally {
		w.close();
	}
});

test("budget asserts against live spend and gates the next admission", async () => {
	const w = childWorld();
	try {
		assertBudget(w.current().store, { parentRunId: w.parent, maxTokens: 1000 });
		await admitVia(w, "implement");
		await completeChildRun(w.current().store, {
			parentRunId: w.parent,
			childKey: "implement",
			state: "done",
			at: 42,
			tokens: { in: 100, out: 20, cached: 50 },
		});
		const spend = parentSpend(w.current().store, w.parent);
		expect(spend.tokens.in + spend.tokens.out).toBe(120);
		assertBudget(w.current().store, { parentRunId: w.parent, maxTokens: 121 });
		expect(() =>
			assertBudget(w.current().store, {
				parentRunId: w.parent,
				maxTokens: 120,
			}),
		).toThrow(/delegated budget/);
		const intents = w
			.current()
			.store.all(
				"SELECT child_key FROM runner_child_intents WHERE parent_run_id = ?",
				w.parent,
			);
		expect(intents).toHaveLength(1);
	} finally {
		w.close();
	}
});

test("cancellation aborts through the controller and records the receipt", async () => {
	const w = childWorld();
	try {
		await admitVia(w, "implement");
		const before = w.calls.length;
		const outcome = await cancelChildRun(
			{
				store: w.current().store,
				controller: w.current().controller,
				actor: w.actor,
			},
			{ parentRunId: w.parent, childKey: "implement", at: 43 },
		);
		expect(outcome.replayed).toBe(false);
		expect(w.calls.slice(before)).toEqual(["stop"]);
		const results = readResults(w.current().store, w.parent);
		expect(results[0]?.state).toBe("aborted");
		expect(results[0]?.reason).toBe("cancelled by supervisor");
		const again = await cancelChildRun(
			{
				store: w.current().store,
				controller: w.current().controller,
				actor: w.actor,
			},
			{ parentRunId: w.parent, childKey: "implement", at: 43 },
		);
		expect(again.replayed).toBe(true);
		await expect(
			completeChildRun(w.current().store, {
				parentRunId: w.parent,
				childKey: "implement",
				state: "done",
				at: 44,
				tokens: { in: 5, out: 5, cached: 0 },
			}),
		).rejects.toThrow(/child result drift/);
	} finally {
		w.close();
	}
});
