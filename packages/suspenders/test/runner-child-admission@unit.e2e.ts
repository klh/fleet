import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import {
	admitChildRun,
	deriveChildRunId,
	recordChildReceipt,
} from "../hooks/lib/runners/control/child-admission.ts";
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

test("admission binds the host execution profile and rejects replay drift", async () => {
	const w = childWorld();
	try {
		const execution = {
			seedDigest: "a".repeat(64),
			policyDigest: "b".repeat(64),
		};
		const deps = {
			store: w.current().store,
			controller: w.current().controller,
			actor: w.actor,
			routes: w.routes,
			execution,
		};
		const input = {
			parentRunId: w.parent,
			supervisorSid: w.actor.sid,
			childKey: "profile",
			kind: "coding" as const,
			brief: "inspect",
		};
		const result = await admitChildRun(deps, input);
		const { RunnerSpecSchema } = await import(
			"../hooks/lib/runners/control/control-state.ts"
		);
		const row = w
			.current()
			.store.get<{ spec_json: string }>(
				"SELECT spec_json FROM runner_jobs WHERE run_id = ?",
				result.runId,
			);
		const spec = RunnerSpecSchema.parse(JSON.parse(row?.spec_json ?? "null"));
		expect(spec.seedDigest).toBe(execution.seedDigest);
		expect(spec.policyDigest).toBe(execution.policyDigest);
		await expect(
			admitChildRun(
				{
					...deps,
					execution: { ...execution, seedDigest: "c".repeat(64) },
				},
				input,
			),
		).rejects.toThrow(/intent drift/);
	} finally {
		w.close();
	}
});

test("admits two children on distinct entitled routes with stable runIds", async () => {
	const w = childWorld();
	try {
		const one = await admitVia(w, "implement", { route: w.routes[0] });
		const two = await admitVia(w, "review", { route: w.routes[1] });
		expect(one.replayed).toBe(false);
		expect(two.replayed).toBe(false);
		expect(two.runId).not.toBe(one.runId);
		expect(one.runId).toBe(deriveChildRunId(w.parent, "implement"));
		// The controller re-admits only a STALE lease — a fresh one refuses
		// (one live controller per run). Advance past the TTL, then replay.
		w.tick(2_000);
		const replay = await admitVia(w, "implement", { route: w.routes[0] });
		expect(replay.replayed).toBe(true);
		expect(replay.runId).toBe(one.runId);
	} finally {
		w.close();
	}
});

test("refuses an unentitled route before admission or executor start", async () => {
	const w = childWorld();
	try {
		await expect(
			admitVia(w, "sneaky", {
				route: { provider: "cloud", model: "unlisted" },
			}),
		).rejects.toThrow(/outside the delegated allowlist/);
		expect(w.calls).toHaveLength(0);
		const intents = w
			.current()
			.store.all("SELECT child_key FROM runner_child_intents");
		expect(intents).toHaveLength(0);
		const jobs = w.current().store.all("SELECT run_id FROM runner_jobs");
		expect(jobs).toHaveLength(0);
	} finally {
		w.close();
	}
});

test("replays across a crash between admission and receipt without a duplicate guest", async () => {
	const w = childWorld();
	try {
		const first = await admitVia(w, "alpha");
		await w.current().controller.submit({
			runId: first.runId,
			text: "brief for alpha",
			requestId: "alpha-turn-1",
			actor: w.actor,
		});
		expect(w.calls).toEqual(["start", "submit"]);
		w.crash();
		const again = await admitVia(w, "alpha");
		expect(again.replayed).toBe(true);
		expect(again.runId).toBe(first.runId);
		await w.current().controller.submit({
			runId: again.runId,
			text: "brief for alpha",
			requestId: "alpha-turn-1",
			actor: w.actor,
		});
		expect(w.calls).toEqual(["start", "submit", "submit"]);
		const jobs = w.current().store.all("SELECT run_id FROM runner_jobs");
		expect(jobs).toHaveLength(1);
		const intents = w
			.current()
			.store.all("SELECT child_key FROM runner_child_intents");
		expect(intents).toHaveLength(1);
	} finally {
		w.close();
	}
});

test("receipts are idempotent on replay and refuse a different outcome", async () => {
	const w = childWorld();
	try {
		const first = recordChildReceipt(
			{ store: w.current().store },
			{
				parentRunId: w.parent,
				childKey: "alpha",
				receipt: { state: "done", at: 42 },
			},
		);
		expect(first.replayed).toBe(false);
		const replay = recordChildReceipt(
			{ store: w.current().store },
			{
				parentRunId: w.parent,
				childKey: "alpha",
				receipt: { state: "done", at: 42 },
			},
		);
		expect(replay.replayed).toBe(true);
		expect(() =>
			recordChildReceipt(
				{ store: w.current().store },
				{
					parentRunId: w.parent,
					childKey: "alpha",
					receipt: { state: "failed", at: 43 },
				},
			),
		).toThrow(/different outcome/);
	} finally {
		w.close();
	}
});

test("replays a cold admission across a crash so the guest starts exactly once", async () => {
	const w = childWorld();
	try {
		const first = await admitVia(w, "beta");
		expect(w.calls).toHaveLength(0);
		w.crash();
		const again = await admitVia(w, "beta");
		expect(again.replayed).toBe(true);
		expect(again.runId).toBe(first.runId);
		await w.current().controller.submit({
			runId: again.runId,
			text: "brief for beta",
			requestId: "beta-turn-1",
			actor: w.actor,
		});
		expect(w.calls).toEqual(["start", "submit"]);
	} finally {
		w.close();
	}
});

test("fan-out and depth bounds refuse before ledger or guest effects", async () => {
	const w = childWorld({ maxChildren: 2 });
	try {
		await admitVia(w, "a");
		await admitVia(w, "b");
		await expect(admitVia(w, "c")).rejects.toThrow(/fan-out bound/);
		const intents = w
			.current()
			.store.all("SELECT child_key FROM runner_child_intents");
		expect(intents).toHaveLength(2);
		expect(w.calls).toHaveLength(0);
	} finally {
		w.close();
	}
	const d = childWorld();
	try {
		await expect(admitVia(d, "grandkid", { depth: 2 })).rejects.toThrow(
			/delegation bound/,
		);
		const none = d
			.current()
			.store.all("SELECT child_key FROM runner_child_intents");
		expect(none).toHaveLength(0);
	} finally {
		d.close();
	}
});
