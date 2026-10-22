#!/usr/bin/env bun
// codex-managed-turn — the codex adapter's managed runtime (W1052.2.2).
// Rides the same seam as claude-runtime (W1169): executorLaunch swaps the
// executor to this entrypoint and the native codex binary rides
// SUSPENDERS_CODEX_NATIVE_BIN. Hosts the lane's mission as an app-server
// thread: initialize → thread/start → turn/start(mission), so the coord
// WS subscriber can steer the ACTIVE turn instead of writing to a detached
// exec log. A per-lane steer socket (<wt>/.fleet/codex-appserver.sock)
// speaks the same JSON-RPC face for the steer client, notifications pump to
// stdout (dispatch redirects to the lane log) as NDJSON, thread + socket
// land as facts (`codex.thread.<sid>` / `codex.sock.<sid>`), and any
// managed-init failure falls back to the verbatim `codex exec` argv.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { openStore } from "../lib/govdb.ts";
import { defineVerb, runCli } from "../lib/verb-kit.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The steer surface only needs the subscriber's exact face plus the
// handshake — everything else stays off the socket.
const SERVED = new Set(["initialize", "thread/read", "turn/steer"]);

const emit = (frame: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

type Waiter = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
};
type ServerConn = {
	write: (line: string) => void;
};

class ManagedTurn {
	private child: ReturnType<typeof spawn>;
	private pending = new Map<number, Waiter>();
	private nextId = 0;
	private completedResolve: ((status: "completed" | "failed") => void) | null =
		null;
	completed: Promise<"completed" | "failed"> = new Promise((resolve) => {
		this.completedResolve = resolve;
	});

	constructor(nativeBin: string, cwd: string) {
		this.child = spawn(nativeBin, ["app-server"], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
		});
		this.child.on("error", (error) =>
			this.failWaiters(new Error(error.message)),
		);
		const lines = createInterface({ input: this.child.stdout });
		lines.on("line", (line) => this.onLine(line));
		this.child.stderr.on("data", () => {});
		this.completed = new Promise((resolve) => {
			this.resolveCompleted = resolve;
		});
	}

	private failWaiters(error: Error): void {
		for (const waiter of this.pending.values()) waiter.reject(error);
		this.pending.clear();
	}

	private onLine(line: string): void {
		let msg: {
			id?: number;
			method?: string;
			result?: unknown;
			error?: { message?: string };
			params?: { turn?: { status?: string } };
		};
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		// Responses route to the waiter that owns the internal id.
		if (typeof msg.id === "number") {
			const waiter = this.pending.get(msg.id);
			if (!waiter) return;
			this.pending.delete(msg.id);
			clearTimeout(waiter.timer);
			if (msg.error)
				waiter.reject(new Error(msg.error.message ?? "app-server error"));
			else waiter.resolve(msg.result);
			return;
		}
		if (msg.method === "turn/completed") {
			emit({ "fleet.codex.turn": msg.params?.turn?.status ?? "completed" });
			this.completedResolve?.(
				msg.params?.turn?.status === "failed" ? "failed" : "completed",
			);
			return;
		}
		// Every other notification pumps verbatim — the lane log keeps the
		// full app-server event stream as NDJSON.
		if (msg.method) emit({ "fleet.codex.notify": msg.method });
	}

	rpc(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs
				? setTimeout(() => {
						this.pending.delete(id);
						reject(new Error(`${method} timed out`));
					}, timeoutMs)
				: undefined;
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	kill(): void {
		this.child.kill("SIGTERM");
	}
}

async function run(args: string[]): Promise<number> {
	const nativeBin = process.env.SUSPENDERS_CODEX_NATIVE_BIN;
	const sid = process.env.SUSPENDERS_SID;
	if (!nativeBin) throw new Error("SUSPENDERS_CODEX_NATIVE_BIN is required");
	// The fence passes the verbatim codex argv: `exec --sandbox <…> <prompt>`;
	// prompt is the trailing positional (promptLast, W1009.1).
	const prompt = args.at(-1);
	if (!prompt || args[0] !== "exec")
		throw new Error("expected codex exec argv: exec [flags] <prompt>");
	const listen =
		args.includes("--listen") && args.indexOf("--listen") + 1 < args.length
			? args[args.indexOf("--listen") + 1]
			: `${process.cwd()}/.fleet/codex-appserver.sock`;
	let managed: ManagedTurn;
	try {
		managed = new ManagedTurn(nativeBin, process.cwd());
		await managed.rpc(
			"initialize",
			{
				clientInfo: { name: "fleet-managed-turn", version: "1" },
			},
			8000,
		);
		const started = (await managed.rpc(
			"thread/start",
			{
				cwd: process.cwd(),
				sandbox: "danger-full-access",
				approvalPolicy: "never",
			},
			8000,
		)) as { thread?: { id?: string } };
		const threadId = started?.thread?.id ?? "";
		if (!UUID.test(threadId))
			throw new Error("thread/start returned no thread id");
		bankFacts(sid, threadId, listen);
		emit({
			"fleet.codex.managed": "started",
			thread: threadId,
			sock: listen,
		});
		serve(listen, managed);
		await managed.rpc("turn/start", {
			threadId,
			input: [{ type: "text", text: prompt }],
		});
		const status = await managed.completed;
		managed.kill();
		return status === "completed" ? 0 : 1;
	} catch (error) {
		// Pre-turn failures only — once turn/start is accepted the mission is
		// in flight and a fallback would rerun it from scratch.
		emit({
			"fleet.codex.managed": "fallback",
			reason: error instanceof Error ? error.message : String(error),
		});
	}
	const fallback = spawn(nativeBin, args, {
		stdio: ["ignore", "inherit", "inherit"],
	});
	return await new Promise<number>((resolve) => {
		fallback.on("error", () => resolve(1));
		fallback.on("close", (code) => resolve(code ?? 1));
	});
}

function bankFacts(
	sid: string | undefined,
	threadId: string,
	sock: string,
): void {
	if (!sid) return;
	try {
		const store = openStore();
		for (const [key, value] of [
			["codex.thread", threadId],
			["codex.sock", sock],
		] as const)
			store.run(
				"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, 'codex-managed-turn', 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
				`${key}.${sid}`,
				value,
				Date.now(),
			);
		store.close();
	} catch (error) {
		process.stderr.write(
			`codex-managed-turn fact write failed: ${String(error)}\n`,
		);
	}
}

// The per-lane steer socket speaks the subscriber's JSON-RPC face: every
// request is remapped onto the app-server child's id space, the response
// routed back to its connection.
function serve(listen: string, managed: ManagedTurn): void {
	const routed = new Map<number, { conn: ServerConn; id: number }>();
	let nextRoute = 0;
	Bun.listen({
		unix: listen,
		socket: {
			open: (socket) => {
				socket.data = { buffer: "" }; // Bun never seeds socket.data
			},
			data: (socket, chunk) => {
				const conn = socket as unknown as ServerConn;
				const state = socket.data as { buffer: string };
				state.buffer += chunk;
				for (;;) {
					const nl = state.buffer.indexOf("\n");
					if (nl < 0) break;
					const line = state.buffer.slice(0, nl);
					state.buffer = state.buffer.slice(nl + 1);
					let req: { id?: number; method?: string; params?: unknown };
					try {
						req = JSON.parse(line);
					} catch {
						continue;
					}
					if (
						!req.method ||
						(req.id !== undefined && !SERVED.has(req.method))
					) {
						if (req.id !== undefined)
							socket.write(
								`${JSON.stringify({ id: req.id, error: { message: "method not served" } })}\n`,
							);
						continue;
					}
					const route = ++nextRoute;
					routed.set(route, { conn, id: req.id });
					managed
						.rpc(req.method, req.params)
						.then((result) => {
							const peer = routed.get(route);
							routed.delete(route);
							peer?.conn.write(`${JSON.stringify({ id: peer.id, result })}\n`);
						})
						.catch((error: unknown) => {
							const peer = routed.get(route);
							routed.delete(route);
							peer?.conn.write(
								`${JSON.stringify({ id: peer.id, error: { message: String(error) } })}\n`,
							);
						});
				}
			},
		},
	});
}

if (import.meta.main)
	await runCli({
		prog: "codex-managed-turn",
		about: "codex-managed-turn — Fleet managed Codex app-server turn.",
		defaultVerb: "run",
		verbs: [
			defineVerb({
				name: "run",
				usage:
					"usage: codex-managed-turn [flags] <native codex exec [flags] <prompt>>",
				lax: true,
				run: (parsed) => run(parsed.rest),
			}),
			// The dispatch fence recipe passes the verbatim codex argv whose head
			// is the `exec` subcommand — expose it as the verb and reattach it so
			// run() always sees the full native argv.
			defineVerb({
				name: "exec",
				usage: "usage: codex-managed-turn exec [flags] <prompt>",
				lax: true,
				run: (parsed) => run(["exec", ...parsed.rest]),
			}),
		],
	});
