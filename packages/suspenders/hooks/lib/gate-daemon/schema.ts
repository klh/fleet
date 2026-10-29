// lib/gate-daemon/schema.ts — wire shapes of the hub governor daemon
// (hub-of-one phase 5). The client (hooks/gate.ts) ships one tool-call
// payload; the host (store-server POST /gate/<event>) answers with exactly
// what the per-call process would have written and its exit code.
import { z } from "zod";

// events that run in the daemon: the hot, synchronous pre/post tool gates.
// post-files (qlty spawns), stop, ask and the dialect adapters stay local —
// a slow gate must never serialize every other session's tool calls.
export const DAEMON_EVENTS = [
	"pre-read",
	"pre-bash",
	"pre-files",
	"governor",
	"push",
] as const;
export type DaemonEvent = (typeof DAEMON_EVENTS)[number];
export const isDaemonEvent = (e: string): e is DaemonEvent =>
	(DAEMON_EVENTS as readonly string[]).includes(e);

export const GateRequestSchema = z.object({
	// raw hook JSON exactly as the harness wrote it to stdin
	raw: z.string().max(4_000_000),
	// the client's environment and cwd: gates read process.env at call time
	// (lane knobs ride per-lane settings env) and resolve relative paths
	env: z.record(z.string(), z.string()),
	cwd: z.string().min(1),
	// argv[3] for events that take a mode (none of DAEMON_EVENTS today)
	mode: z.string().default(""),
});
export type GateRequest = z.infer<typeof GateRequestSchema>;

export const GateResponseSchema = z.object({
	stdout: z.string(),
	stderr: z.string(),
	code: z.number().int(),
});
export type GateResponse = z.infer<typeof GateResponseSchema>;
