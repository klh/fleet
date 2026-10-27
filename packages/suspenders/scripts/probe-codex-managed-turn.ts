#!/usr/bin/env bun
// W1052.2.2 probe (live ground truth, 2026-10-22, codex-cli 0.158.0): the
// stdio `codex app-server` hosts managed threads end to end — initialize →
// thread/start → turn/start → turn/completed notification → thread/read
// (idle). Hooks run on these turns: hook/started + hook/completed
// notifications and hooks/list (sessionStart, stop, …) prove the suspenders
// codex dialect keeps governing a managed turn. Diagnostics, not a runtime
// dep: run on demand with the codex binary as argv[2].
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const bin = process.argv[2] ?? "codex";
const cwd = process.argv[3] ?? "/tmp/codex-probe-thread";

type Waiter = {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};
const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], cwd });
const pending = new Map<number, Waiter>();
const notifies = new Set<string>();
let nextId = 0;
let completed = false;

function rpc(method: string, params: unknown, timeoutMs = 8000): Promise<unknown> {
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timer });
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
	});
}

const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
	let msg: {
		id?: number;
		method?: string;
		error?: { message?: string };
		result?: unknown;
		params?: { turn?: { status?: string; items?: Array<{ text?: string }> } };
	};
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.id === undefined) {
		if (msg.method) {
			notifies.add(msg.method);
			if (msg.method === "turn/completed") completed = msg.params?.turn?.status === "completed";
		}
		return;
	}
	const waiter = pending.get(msg.id);
	if (!waiter) return;
	pending.delete(msg.id);
	clearTimeout(waiter.timer);
	if (msg.error) waiter.reject(new Error(msg.error.message ?? "app-server error"));
	else waiter.resolve(msg.result);
});
child.stderr.on("data", () => {}); // MCP transport noise is irrelevant here

const answer = (v: unknown): string =>
	(v as { thread?: { id?: string } })?.thread?.id ?? "";

try {
	await rpc("initialize", { clientInfo: { name: "fleet-probe", version: "1" } });
	const started = (await rpc("thread/start", {
		cwd,
		sandbox: "danger-full-access",
		approvalPolicy: "never",
	})) as { thread?: { id?: string } };
	const threadId = answer(started);
	if (!threadId) throw new Error("thread/start returned no thread id");
	await rpc("turn/start", {
		threadId,
		input: [{ type: "text", text: "Reply with exactly: probe-ok" }],
	}, 150_000);
	const t0 = Date.now();
	while (!completed && Date.now() - t0 < 150_000) await Bun.sleep(1000);
	const read = (await rpc("thread/read", { threadId, includeTurns: true })) as {
		thread?: { status?: { type?: string } };
	};
	console.log(`thread=${threadId} completed=${completed} status=${read.thread?.status?.type}`);
	console.log(`hooks fired: ${notifies.has("hook/started") && notifies.has("hook/completed")}`);
	console.log(`notifications: ${[...notifies].sort().join(",")}`);
	console.log(completed ? "VERDICT: PASS" : "VERDICT: FAIL - turn never completed");
} catch (error) {
	console.log(`VERDICT: FAIL - ${error instanceof Error ? error.message : String(error)}`);
}
child.kill();
process.exit(0);
