// lib/gate-daemon/host.ts — the daemon half of the hub governor (hub-of-one
// phase 5): evaluate one hot gate event in a WARM process (store-server)
// with the calling session's env, cwd and payload, and return exactly what
// the per-call `bun gate.ts <event>` process would have printed + its exit
// code.
//
// Gates are written as process-terminating deciders (`allow(): never` →
// process.exit). The host runs one request at a time and, for its duration:
//   - swaps process.env and cwd to the client's (call-time env reads see the
//     lane's knobs; only HOME is read at module load, identical per machine)
//   - captures stdout/stderr writes
//   - replaces process.exit with a sentinel throw: the FIRST exit wins (code
//     + output frozen at that point), exactly like a real process that ends
//     there; writes after it are dropped
// and restores everything in `finally`. Requests are serialized — gate code
// shares module state (hookio's HOOK stash) and the process cwd/env.
import type { GateRequest, GateResponse } from "./schema.ts";

class GateExit extends Error {
	constructor() {
		super("gate-exit");
	}
}

let chain: Promise<unknown> = Promise.resolve();

export function runGate(
	event: string,
	req: GateRequest,
): Promise<GateResponse> {
	const run = chain.then(() => runOne(event, req));
	chain = run.catch(() => undefined);
	return run;
}

function swapEnv(next: Record<string, string>): Record<string, string> {
	const saved: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (typeof v === "string") saved[k] = v;
	for (const k of Object.keys(saved)) if (!(k in next)) delete process.env[k];
	Object.assign(process.env, next);
	return saved;
}

async function runOne(event: string, req: GateRequest): Promise<GateResponse> {
	const out: string[] = [];
	const err: string[] = [];
	let code: number | null = null;
	const savedEnv = swapEnv(req.env);
	const savedCwd = process.cwd();
	const savedExit = process.exit;
	const savedOut = process.stdout.write;
	const savedErr = process.stderr.write;
	const savedArgv3 = process.argv[3];
	const capture =
		(sink: string[]) =>
		(chunk: unknown): boolean => {
			if (code === null)
				sink.push(
					typeof chunk === "string"
						? chunk
						: new TextDecoder().decode(chunk as Uint8Array),
				);
			return true;
		};
	try {
		try {
			process.chdir(req.cwd);
		} catch {} // a vanished cwd: gates resolve from the payload's paths
		process.argv[3] = req.mode;
		process.exit = ((c?: number) => {
			if (code === null) code = c ?? 0;
			throw new GateExit();
		}) as typeof process.exit;
		process.stdout.write = capture(out) as typeof process.stdout.write;
		process.stderr.write = capture(err) as typeof process.stderr.write;
		const { parseHook } = await import("../hookio.ts");
		const { dispatchGate } = await import("../../gate-dispatch.ts");
		await dispatchGate(event, parseHook(req.raw));
		// a gate that returned without deciding = the entrypoint's tail allow
		if (code === null) {
			out.push("{}");
			code = 0;
		}
	} catch (e) {
		if (!(e instanceof GateExit) && code === null) {
			// a crashing gate in the per-call process = uncaught error, exit 1
			err.push(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
			code = 1;
		}
	} finally {
		process.exit = savedExit;
		process.stdout.write = savedOut;
		process.stderr.write = savedErr;
		if (savedArgv3 === undefined) process.argv.length = 3;
		else process.argv[3] = savedArgv3;
		try {
			process.chdir(savedCwd);
		} catch {}
		swapEnv(savedEnv);
	}
	return { stdout: out.join(""), stderr: err.join(""), code: code ?? 0 };
}
