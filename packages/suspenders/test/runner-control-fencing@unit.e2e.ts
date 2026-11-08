import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { digestOf } from "../hooks/lib/runners/control/control-state.ts";
import {
	admitLease,
	ensureRunnerLeaseSchema,
	fenceCheck,
	getLease,
	revokeLease,
} from "../hooks/lib/runners/control/leases.ts";
import {
	ensureRunnerReaderSchema,
	recordRunnerEvent,
} from "../hooks/lib/runners/control/cursors.ts";
import {
	makeRunnerAuthorizer,
	RunnerAuthError,
	RUNNER_SCOPES,
	type RunnerActor,
} from "../hooks/lib/runners/control/rights.ts";
import {
	openRunnerController,
	type DurableAdapter,
} from "../hooks/lib/runners/control/controller.ts";
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
			admitLease(store, { runId, controllerSid: "c1", now: now(), ttlMs: 60_000 }),
		).toEqual({ ok: true, token: { epoch: 1 } });
		expect(
			admitLease(store, { runId, controllerSid: "c2", now: now(), ttlMs: 60_000 }),
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
			reason: "executor-absent: no durable adapter bound — control row unchanged",
		});
		const { job } = await ctl.read({ runId: spec.runId, actor: controlActor() });
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
		expect(durable.calls).toEqual([`start:${spec.runId}`]);
		const aborted = await ctl.abort({ runId: spec.runId, actor: controlActor() });
		expect(aborted).toEqual({ ok: true, state: "stopping" });
		expect(durable.calls).toEqual([
			`start:${spec.runId}`,
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
			reason: "runner: submit from stopping refuses (cold/parked/running)",
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
			readerSid: "board",
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
			readerSid: "board",
			actor: readOnly(),
		});
		expect(again.events.map((e) => e.kind)).toEqual(["admitted", "tick"]);
		const empty = await ctl.replay({
			runId: spec.runId,
			readerSid: "board",
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
			readerSid: "board",
			actor: readOnly(),
		});
		await ctl.replay({ runId: spec.runId, readerSid: "board", actor: readOnly() });
		await ctl.detach({ runId: spec.runId, readerSid: "board", actor: readOnly() });
		const reattach = await ctl.attach({
			runId: spec.runId,
			readerSid: "board",
			actor: readOnly(),
		});
		expect(reattach.events).toEqual([]);
		const { job } = await ctl.read({ runId: spec.runId, actor: controlActor() });
		expect(job.state).toBe("cold");
	});
});
