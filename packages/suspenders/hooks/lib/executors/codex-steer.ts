// Direct Fleet events can steer an active Codex app-server turn. A detached
// `codex exec` process has no app-server turn to address; its durable coord
// inbox remains the fallback until dispatch uses a steerable runtime.
// W1052.2.2: managed lanes serve the same JSON-RPC face on a per-lane unix
// socket (`codex.sock.<sid>` fact) — the steer client rides that socket.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";

export type CoordDirectEvent = {
	id: number;
	source: string;
	kind: string;
	target: string | null;
	payload: string | null;
};

type Rpc = (
	method: string,
	params: Record<string, unknown>,
) => Promise<unknown>;
type ThreadRead = {
	thread?: {
		status?: { type?: string };
		turns?: Array<{ id: string; status: string }>;
	};
};

export type CodexDelivery =
	| { state: "steered"; turnId: string }
	| { state: "queued" | "unsupported" | "ignored"; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECT_KINDS = new Set(["NOTE", "consult", "consult.answer"]);

export function codexEventText(event: CoordDirectEvent): string {
	let payload: unknown = event.payload;
	try {
		payload = JSON.parse(event.payload ?? "null");
	} catch {
		// The durable inbox retains the raw payload for an exact read.
	}
	return `Fleet coordination event #${event.id} (${event.kind}) from ${event.source}, addressed to this session.\n${JSON.stringify(payload)}\nRead and act on the full event with coord inbox --as ${event.target}; acknowledge it only after acting.`;
}

/** A successful RPC means Codex accepted same-turn steering, not that the
 * agent acted or acknowledged the durable Fleet inbox entry. */
export async function steerCodexDirectEvent(
	event: CoordDirectEvent,
	opts: {
		threadId?: string;
		rpc?: Rpc;
		command?: string[];
		sock?: string;
	} = {},
): Promise<CodexDelivery> {
	if (!event.target || !DIRECT_KINDS.has(event.kind))
		return { state: "ignored", reason: "not a direct message or consult" };
	const threadId = opts.threadId ?? event.target;
	if (!UUID.test(threadId))
		return {
			state: "unsupported",
			reason: "no Codex thread UUID for this Fleet session",
		};
	let close: (() => void) | undefined;
	try {
		const rpc =
			opts.rpc ?? (await connectCodexAppServer(opts.command, opts.sock));
		if (!opts.rpc) close = (rpc as ManagedRpc).close;
		const read = (await rpc("thread/read", {
			threadId,
			includeTurns: true,
		})) as ThreadRead;
		if (read.thread?.status?.type !== "active")
			return {
				state: "queued",
				reason: "Codex thread is not in an active turn",
			};
		const turn = read.thread.turns?.findLast(
			(item) => item.status === "inProgress",
		);
		if (!turn)
			return { state: "queued", reason: "active Codex turn ID unavailable" };
		await rpc("turn/steer", {
			threadId,
			expectedTurnId: turn.id,
			input: [{ type: "text", text: codexEventText(event) }],
		});
		return { state: "steered", turnId: turn.id };
	} catch (error) {
		return {
			state: "queued",
			reason: `Codex active-turn delivery unavailable: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		close?.();
	}
}

type ManagedRpc = Rpc & { close: () => void };

/** Codex 0.158 app-server's documented JSON-RPC face. Default transport is
 * the shared-daemon proxy (connects only to an already-running daemon,
 * never starts a new Codex session); a managed lane's per-lane steer socket
 * (the `codex.sock.<sid>` fact) is addressed with `sock`. */
export async function connectCodexAppServer(
	command: string[] = ["codex", "app-server", "proxy"],
	sock?: string,
): Promise<ManagedRpc> {
	const channel = sock
		? connect({ path: sock })
		: spawn(command[0], command.slice(1), {
				stdio: ["pipe", "pipe", "pipe"],
			});
	const send = (line: string): void => {
		if ("stdin" in channel) channel.stdin.write(line);
		else channel.write(line);
	};
	const shut = (): void => {
		if ("stdin" in channel) channel.kill();
		else channel.end();
	};
	const inlet = "stdin" in channel ? channel.stdout : channel;
	const pending = new Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let nextId = 0;
	let closed = false;
	const stop = (reason: string): void => {
		if (closed) return;
		closed = true;
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(reason));
		}
		pending.clear();
	};
	channel.on("error", (error) => stop(error.message));
	channel.on("close", () => stop("app-server transport closed"));
	("stdin" in channel ? channel.stdin : channel).on("error", (error) =>
		stop(error.message),
	);
	const lines = createInterface({ input: inlet });
	lines.on("line", (line) => {
		let response: {
			id?: number;
			result?: unknown;
			error?: { message?: string };
		};
		try {
			response = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof response.id !== "number") return;
		const waiter = pending.get(response.id);
		if (!waiter) return;
		pending.delete(response.id);
		clearTimeout(waiter.timer);
		if (response.error)
			waiter.reject(new Error(response.error.message ?? "app-server error"));
		else waiter.resolve(response.result);
	});
	const rpc = ((method: string, params: Record<string, unknown>) => {
		if (closed) return Promise.reject(new Error("app-server proxy closed"));
		const id = ++nextId;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, 2000);
			pending.set(id, { resolve, reject, timer });
			send(`${JSON.stringify({ id, method, params })}\n`);
		});
	}) as ManagedRpc;
	rpc.close = () => {
		stop("app-server transport closed");
		shut();
	};
	try {
		await rpc("initialize", {
			clientInfo: { name: "fleet-coord", version: "1" },
		});
		send(`${JSON.stringify({ method: "initialized" })}\n`);
		return rpc;
	} catch (error) {
		rpc.close();
		throw error;
	}
}
