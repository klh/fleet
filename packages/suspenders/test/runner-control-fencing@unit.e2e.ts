import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { digestOf } from "../hooks/lib/runners/control/control-state.ts";
import {
	type DurableAdapter,
	openRunnerController,
} from "../hooks/lib/runners/control/controller.ts";
import {
	ensureRunnerReaderSchema,
	recordRunnerEvent,
} from "../hooks/lib/runners/control/cursors.ts";
import {
	admitLease,
	ensureRunnerLeaseSchema,
	fenceCheck,
	getLease,
	revokeLease,
} from "../hooks/lib/runners/control/leases.ts";
import {
	makeRunnerAuthorizer,
	RUNNER_SCOPES,
	type RunnerActor,
	RunnerAuthError,
} from "../hooks/lib/runners/control/rights.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";

const digest = () => digestOf(`fixture-${Math.random()}`);
const now = () => 1_000_000;

const specInput = () => ({
	version: 1 as const,
	runId: crypto.randomUUID(),
	owner: "lane-witness",
	generation: 1,
	kind: "coding" as const,
	seedDigest: digest(),
	policyDigest: digest(),
	provider: "belt",
	model: "glm-5.3",
});

const controlActor = (): RunnerActor => ({
	sid: "controller-a",
	scopes: [RUNNER_SCOPES.control, RUNNER_SCOPES.read],
});
const readOnly = (): RunnerActor => ({
	sid: "reader-1",
	scopes: [RUNNER_SCOPES.read],
});
const executor = (epoch: number): RunnerActor => ({
	sid: "executor-1",
	scopes: [],
	leaseToken: { epoch },
});

const memoryStore = () => {
	const store = sqliteStore(new Database(":memory:"));
	ensureRunnerLeaseSchema(store);
	ensureRunnerReaderSchema(store);
	return store;
};

const stubDurable = (): DurableAdapter & { calls: string[] } => {
	const calls: string[] = [];
	return {
		calls,
		async start(spec) {
			calls.push(`start:${spec.runId}`);
		},
		async submit(runId, text) {
			calls.push(`submit:${runId}:${text}`);
		},
		async resume(runId) {
			calls.push(`resume:${runId}`);
		},
		async stop(runId) {
			calls.push(`stop:${runId}`);
		},
	};
};

test.describe("distributed lease + fencing (W2869.2)", () => {
	test("admission is CAS: first controller wins epoch 1, second refused", async () => {
		const store = memoryStore();
		const runId = crypto.randomUUID();
		expect(
			admitLease(store, {
				runId,
				controllerSid: "c1",
				now: now(),
				ttlMs: 60_000,
			}),
		).toEqual({ ok: true, token: { epoch: 1 } });
		expect(
			admitLease(store, {
				runId,
				controllerSid: "c2",
				now: now(),
				ttlMs: 60_000,
			}),
		).toEqual({
			ok: false,
			reason: "runner: lease held by c1 (epoch 1, fresh)",
		});
	});

	test("takeover past ttl and revoked re-admit both bump the epoch", async () => {
		let t = 1_000_000;
		const store = memoryStore();
		const runId = crypto.randomUUID();
		const admit = (sid: string) =>
			admitLease(store, { runId, controllerSid: sid, now: t, ttlMs: 100 });
		expect(admit("c1")).toEqual({ ok: true, token: { epoch: 1 } });
		t += 101;
		expect(admit("c2")).toEqual({ ok: true, token: { epoch: 2 } });
		expect(revokeLease(store, runId, t)).toEqual({ ok: true });
		expect(admit("c3")).toEqual({ ok: true, token: { epoch: 4 } });
	});
});

test.describe("fence verdicts + heartbeat (W2869.2)", () => {
	test("fenceCheck passes live, fences mismatched epochs, refuses revoked", async () => {
		const t = 1_000_000;
		const store = memoryStore();
		const runId = crypto.randomUUID();
		expect(
			admitLease(store, { runId, controllerSid: "c1", now: t, ttlMs: 60_000 }),
		).toEqual({ ok: true, token: { epoch: 1 } });
		expect(fenceCheck(store, runId, { epoch: 1 }, t)).toEqual({ ok: true });
		expect(fenceCheck(store, runId, { epoch: 2 }, t)).toEqual({
			ok: false,
			reason: "runner: fenced — live epoch 1 ≠ token epoch 2",
		});
		expect(revokeLease(store, runId, t)).toEqual({ ok: true });
		expect(fenceCheck(store, runId, { epoch: 1 }, t)).toEqual({
			ok: false,
			reason: "runner: lease revoked",
		});
	});

	test("a passing fenceCheck renews the lease heartbeat", async () => {
		let t = 1_000_000;
		const store = memoryStore();
		const runId = crypto.randomUUID();
		admitLease(store, { runId, controllerSid: "c1", now: t, ttlMs: 5_000 });
		t += 1_000;
		expect(fenceCheck(store, runId, { epoch: 1 }, t)).toEqual({ ok: true });
		expect(getLease(store, runId)?.updated_at).toBe(t);
	});
});

test.describe("6-action rights vocabulary (W2869.2)", () => {
	test("control actions gate on runner scopes; read-only is refused writes", async () => {
		const store = memoryStore();
		const runId = crypto.randomUUID();
		const authz = makeRunnerAuthorizer({ store, now });
		await expect(
			authz.authorize("open", { runId, actor: controlActor() }),
		).resolves.toBeUndefined();
		await expect(
			authz.authorize("submit", { runId, actor: readOnly() }),
		).rejects.toThrow("requires buckle:runner:WRITE_");
		await expect(
			authz.authorize("read", { runId, actor: readOnly() }),
		).resolves.toBeUndefined();
		await expect(
			authz.authorize("abort", { runId, actor: readOnly() }),
		).rejects.toBeInstanceOf(RunnerAuthError);
	});

	test("execute rides NOTHING user-shaped — only the live lease token", async () => {
		let t = 1_000_000;
		const store = memoryStore();
		const runId = crypto.randomUUID();
		const authz = makeRunnerAuthorizer({ store, now: () => t });
		await expect(
			authz.authorize("execute", { runId, actor: controlActor() }),
		).rejects.toThrow("no lease token");
		admitLease(store, { runId, controllerSid: "c1", now: t, ttlMs: 100 });
		await expect(
			authz.authorize("execute", { runId, actor: executor(1) }),
		).resolves.toBeUndefined();
		t += 101;
		admitLease(store, { runId, controllerSid: "c2", now: t, ttlMs: 100 });
		await expect(
			authz.authorize("execute", { runId, actor: executor(1) }),
		).rejects.toThrow("live epoch 2 ≠ token epoch 1");
	});
});

test.describe("controller flow (W2869.2)", () => {
	test("admit takes the lease, writes the cold control row, records the event", async () => {
		const store = memoryStore();
		const ctl = openRunnerController({ store, now });
		const spec = specInput();
		const { token } = await ctl.admit({ spec, actor: controlActor() });
		expect(token.epoch).toBe(1);
		const { job, events } = await ctl.read({
			runId: spec.runId,
			actor: controlActor(),
		});
		expect(job.state).toBe("cold");
		expect(job.generation).toBe(1);
		expect(events.map((e) => e.kind)).toEqual(["admitted"]);
	});

	test("executor-absent submit refuses honestly — control row stays cold", async () => {
		const store = memoryStore();
		const ctl = openRunnerController({ store, now });
		const spec = specInput();
		await ctl.admit({ spec, actor: controlActor() });
		const res = await ctl.submit({
			runId: spec.runId,
			text: "go",
			actor: controlActor(),
		});
		expect(res).toEqual({
			ok: false,
			reason:
				"executor-absent: no durable adapter bound — control row unchanged",
		});
		const { job } = await ctl.read({
			runId: spec.runId,
			actor: controlActor(),
		});
		expect(job.state).toBe("cold");
	});
});

test.describe("durable executor flow (W2869.2)", () => {
	test("submit starts the bound executor; abort stops it and lands stopping", async () => {
		const store = memoryStore();
		const durable = stubDurable();
		const ctl = openRunnerController({ store, durable, now });
		const spec = specInput();
		await ctl.admit({ spec, actor: controlActor() });
		const started = await ctl.submit({
			runId: spec.runId,
			text: "go",
			actor: controlActor(),
		});
		expect(started).toEqual({ ok: true, state: "running" });
		expect(durable.calls).toEqual([
			`start:${spec.runId}`,
			`submit:${spec.runId}:go`,
		]);
		const aborted = await ctl.abort({
			runId: spec.runId,
			actor: controlActor(),
		});
		expect(aborted).toEqual({ ok: true, state: "stopping" });
		expect(durable.calls).toEqual([
			`start:${spec.runId}`,
			`submit:${spec.runId}:go`,
			`stop:${spec.runId}`,
		]);
	});

	test("submit from stopping refuses — terminal transitions assert loud", async () => {
		const store = memoryStore();
		const ctl = openRunnerController({ store, durable: stubDurable(), now });
		const spec = specInput();
		await ctl.admit({ spec, actor: controlActor() });
		await ctl.submit({ runId: spec.runId, text: "go", actor: controlActor() });
		await ctl.abort({ runId: spec.runId, actor: controlActor() });
		const res = await ctl.submit({
			runId: spec.runId,
			text: "late",
			actor: controlActor(),
		});
		expect(res).toEqual({
			ok: false,
			reason: "runner: submit from stopping refuses",
		});
	});
});

test.describe("per-reader cursors (W2869.2)", () => {
	test("attach is non-consuming; replay advances examined-only", async () => {
		const store = memoryStore();
		const ctl = openRunnerController({ store, now });
		const spec = specInput();
		await ctl.admit({ spec, actor: controlActor() });
		const first = await ctl.attach({
			runId: spec.runId,
			actor: readOnly(),
		});
		expect(first.events.map((e) => e.kind)).toEqual(["admitted"]);
		recordRunnerEvent(store, {
			runId: spec.runId,
			kind: "tick",
			payload: { n: 1 },
			now: now(),
		});
		const again = await ctl.replay({
			runId: spec.runId,
			actor: readOnly(),
		});
		expect(again.events.map((e) => e.kind)).toEqual(["admitted", "tick"]);
		const empty = await ctl.replay({
			runId: spec.runId,
			actor: readOnly(),
		});
		expect(empty.events).toEqual([]);
	});

	test("re-attach keeps the reader cursor; detach never touches the job", async () => {
		const store = memoryStore();
		const ctl = openRunnerController({ store, now });
		const spec = specInput();
		await ctl.admit({ spec, actor: controlActor() });
		await ctl.attach({
			runId: spec.runId,
			actor: readOnly(),
		});
		await ctl.replay({ runId: spec.runId, actor: readOnly() });
		await ctl.detach({ runId: spec.runId, actor: readOnly() });
		const reattach = await ctl.attach({
			runId: spec.runId,
			actor: readOnly(),
		});
		expect(reattach.events).toEqual([]);
		const { job } = await ctl.read({
			runId: spec.runId,
			actor: controlActor(),
		});
		expect(job.state).toBe("cold");
	});
});

test("repair: submit to a running run delivers text without restarting", async () => {
	const store = memoryStore();
	const durable = stubDurable();
	const ctl = openRunnerController({ store, durable, now });
	const spec = specInput();
	await ctl.admit({ spec, actor: controlActor() });
	await ctl.submit({ runId: spec.runId, text: "go", actor: controlActor() });
	durable.calls.length = 0;
	const res = await ctl.submit({
		runId: spec.runId,
		text: "more",
		actor: controlActor(),
	});
	expect(res).toEqual({ ok: true, state: "running" });
	expect(durable.calls).toEqual([`submit:${spec.runId}:more`]);
});

test("repair: resume drains held interrupts through the durable adapter", async () => {
	const store = memoryStore();
	const ctl1 = openRunnerController({ store, now });
	const spec = specInput();
	await ctl1.admit({ spec, actor: controlActor() });
	const parked = await ctl1.park({ runId: spec.runId, actor: controlActor() });
	expect(parked).toEqual({ ok: true, state: "parked" });
	await ctl1.submit({ runId: spec.runId, text: "h1", actor: controlActor() });
	await ctl1.submit({ runId: spec.runId, text: "h2", actor: controlActor() });
	const durable = stubDurable();
	const ctl2 = openRunnerController({ store, durable, now });
	const res = await ctl2.resume({ runId: spec.runId, actor: controlActor() });
	expect(res).toEqual({ ok: true, state: "running" });
	expect(durable.calls).toEqual([
		`resume:${spec.runId}`,
		`submit:${spec.runId}:h1`,
		`submit:${spec.runId}:h2`,
	]);
	const { job } = await ctl2.read({ runId: spec.runId, actor: controlActor() });
	expect(job.held_interrupts).toEqual([]);
});

test("repair: watchdog expiry halts with bounded cleanup at the captured epoch", async () => {
	let t = 1_000_000;
	const store = memoryStore();
	const durable = stubDurable();
	const revoked: string[] = [];
	const spec = specInput();
	const ctl = openRunnerController({
		store,
		durable,
		now: () => t,
		leaseTtlMs: 5_000,
		cleanupTimeoutMs: 50,
		revokeCredential: async (runId, lease) => {
			revoked.push(`${runId}@${lease.epoch}`);
		},
	});
	await ctl.admit({ spec, actor: controlActor() });
	await ctl.submit({ runId: spec.runId, text: "go", actor: controlActor() });
	const watcher = ctl.watch({ runId: spec.runId, intervalMs: 10 });
	t += 6_000;
	await new Promise((resolve) => setTimeout(resolve, 60));
	watcher.stop();
	expect(revoked).toEqual([`${spec.runId}@1`]);
	expect(durable.calls).toContain(`stop:${spec.runId}`);
	const { job, events } = await ctl.read({
		runId: spec.runId,
		actor: controlActor(),
	});
	expect(job.state).toBe("stopped");
	expect(events.some((e) => e.kind === "fence-revoked")).toBe(true);
});

test("repair: watchdog on takeover leaves the winner's lease and state intact", async () => {
	const t = 1_000_000;
	const store = memoryStore();
	const durable = stubDurable();
	const revoked: string[] = [];
	const spec = specInput();
	const ctl = openRunnerController({
		store,
		durable,
		now: () => t,
		leaseTtlMs: 5_000,
		cleanupTimeoutMs: 50,
		revokeCredential: async (runId, lease) => {
			revoked.push(`${runId}@${lease.epoch}`);
		},
	});
	await ctl.admit({ spec, actor: controlActor() });
	await ctl.submit({ runId: spec.runId, text: "go", actor: controlActor() });
	const watcher = ctl.watch({ runId: spec.runId, intervalMs: 10 });
	admitLease(store, {
		runId: spec.runId,
		controllerSid: "controller-b",
		now: t + 6_000,
		ttlMs: 5_000,
	});
	await new Promise((resolve) => setTimeout(resolve, 60));
	watcher.stop();
	expect(revoked).toEqual([`${spec.runId}@1`]);
	expect(durable.calls).not.toContain(`stop:${spec.runId}`);
	expect(getLease(store, spec.runId)).toMatchObject({
		state: "active",
		epoch: 2,
	});
	const { job } = await ctl.read({ runId: spec.runId, actor: controlActor() });
	expect(job.state).toBe("running");
});

test("repair: stopWithRevocation fences first and bounds a hung executor stop", async () => {
	const store = memoryStore();
	const order: string[] = [];
	const spec = specInput();
	const ctl = openRunnerController({
		store,
		durable: {
			async start() {},
			async submit() {},
			async resume() {},
			stop: () => new Promise<void>(() => {}),
		},
		now,
		cleanupTimeoutMs: 20,
		revokeCredential: async () => {
			const lease = getLease(store, spec.runId);
			if (!lease) throw new Error("runner: no lease to revoke");
			order.push(`credential@${lease.epoch}:${lease.state}`);
		},
	});
	await ctl.admit({ spec, actor: controlActor() });
	await ctl.submit({ runId: spec.runId, text: "go", actor: controlActor() });
	const res = await ctl.stopWithRevocation({
		runId: spec.runId,
		actor: controlActor(),
	});
	expect(res).toEqual({ ok: true, state: "failed" });
	expect(order).toEqual(["credential@2:revoked"]);
	expect(getLease(store, spec.runId)?.state).toBe("revoked");
	const { events } = await ctl.read({
		runId: spec.runId,
		actor: controlActor(),
	});
	const abort = events.find((e) => e.kind === "abort");
	if (!abort) throw new Error("runner: no abort event recorded");
	const payload = JSON.parse(abort.payload_json) as { cleanupErrors: string[] };
	expect(payload.cleanupErrors).toEqual(["executor stop timed out"]);
});

test("repair: fenceCheck heartbeat CAS survives a racing revoke", () => {
	const store = memoryStore();
	const runId = crypto.randomUUID();
	admitLease(store, { runId, controllerSid: "c1", now: now(), ttlMs: 60_000 });
	const racing = {
		run: (sql: string, ...params: unknown[]) => {
			if (sql.includes("UPDATE runner_leases SET updated_at")) {
				revokeLease(store, runId, now());
			}
			return store.run(sql, ...params);
		},
		get: <T>(sql: string, ...params: unknown[]): T | null =>
			store.get<T>(sql, ...params),
		all: <T>(sql: string, ...params: unknown[]): T[] =>
			store.all<T>(sql, ...params),
	};
	expect(fenceCheck(racing, runId, { epoch: 1 }, now())).toEqual({
		ok: false,
		reason: "runner: fenced — lease changed mid-check",
	});
});

test("repair: crash-reopen re-admits the same spec in place", async () => {
	let t = 1_000_000;
	const store = memoryStore();
	const ctl = openRunnerController({ store, now: () => t, leaseTtlMs: 5_000 });
	const spec = specInput();
	const first = await ctl.admit({ spec, actor: controlActor() });
	expect(first.token.epoch).toBe(1);
	t += 6_000;
	const second = await ctl.admit({ spec: { ...spec }, actor: controlActor() });
	expect(second.token.epoch).toBe(2);
	const rows = store.all<{ run_id: string }>(
		"SELECT run_id FROM runner_jobs WHERE run_id = ?",
		spec.runId,
	);
	expect(rows).toHaveLength(1);
	const { events } = await ctl.read({
		runId: spec.runId,
		actor: controlActor(),
	});
	expect(events.map((e) => e.kind)).toEqual(["admitted", "readmitted"]);
});

test("active admission replay requires the captured lease and original controller", async () => {
	const store = memoryStore();
	const ctl = openRunnerController({ store, now });
	const spec = specInput();
	const { token } = await ctl.admit({ spec, actor: controlActor() });
	const actor = { ...controlActor(), leaseToken: token };
	expect(await ctl.admit({ spec, actor })).toEqual({ token });
	await expect(ctl.admit({ spec, actor: controlActor() })).rejects.toThrow(
		/lease held/,
	);
	await expect(
		ctl.admit({
			spec,
			actor: { ...actor, sid: "other-controller" },
		}),
	).rejects.toThrow(/lease held/);
	await expect(
		ctl.admit({
			spec,
			actor: { ...actor, scopes: [RUNNER_SCOPES.read] },
		}),
	).rejects.toThrow(/denied open/);
	await expect(
		ctl.admit({
			spec: { ...spec, model: "different" },
			actor,
		}),
	).rejects.toThrow(/immutable spec/);
	revokeLease(store, spec.runId, now());
	await expect(ctl.admit({ spec, actor })).rejects.toThrow(/lease revoked/);
	expect(getLease(store, spec.runId)?.epoch).toBe(token.epoch + 1);
	expect(getLease(store, spec.runId)?.state).toBe("revoked");
});

test("repair: re-admission with a mutated spec refuses and leaves the lease", async () => {
	let t = 1_000_000;
	const store = memoryStore();
	const ctl = openRunnerController({ store, now: () => t, leaseTtlMs: 5_000 });
	const spec = specInput();
	await ctl.admit({ spec, actor: controlActor() });
	t += 6_000;
	const mutated = { ...spec, model: "claude-sonnet-5.5" };
	await expect(
		ctl.admit({ spec: mutated, actor: controlActor() }),
	).rejects.toThrow("bound to a different immutable spec");
	expect(getLease(store, spec.runId)?.epoch).toBe(1);
});

test("restart reconciles only fenced stopping rows with a current clean receipt", async () => {
	const store = memoryStore();
	const deps = {
		store,
		durable: stubDurable(),
		now,
		revokeCredential: async () => {},
	};
	const controller = openRunnerController(deps);
	const runs = new Map<string, string>();
	for (const scenario of ["clean", "active", "old", "failed", "missing"]) {
		const spec = specInput();
		runs.set(scenario, spec.runId);
		await controller.admit({ spec, actor: controlActor() });
		if (scenario !== "active") revokeLease(store, spec.runId, now());
		store.run(
			"UPDATE runner_jobs SET state = 'stopping', updated_at = ? WHERE run_id = ?",
			now(),
			spec.runId,
		);
		if (scenario !== "missing")
			recordRunnerEvent(store, {
				runId: spec.runId,
				kind: "abort",
				payload: {
					leaseRevoked: true,
					credentialRevoked: true,
					cleanupErrors: scenario === "failed" ? ["executor stop failed"] : [],
				},
				now: scenario === "old" ? now() - 1 : now(),
			});
	}
	const reopened = openRunnerController(deps);
	for (const [scenario, runId] of runs) {
		const { job } = await reopened.read({ runId, actor: controlActor() });
		expect(job.state, scenario).toBe(
			scenario === "clean" ? "stopped" : "stopping",
		);
	}
});
