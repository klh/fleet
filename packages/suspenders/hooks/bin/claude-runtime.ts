#!/usr/bin/env bun
// Fleet owns this native stdin for the whole lane. Existing interactive
// Claude processes have no such channel and cannot be adopted by this file.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ClaudeControl, claudeStreamArguments } from "../lib/claude-control.ts";
import {
	consumeClaudeWake,
	proveClaudeWake,
	releaseClaudeWake,
	waitForClaudeWakeClaim,
} from "../lib/claude-wake.ts";
// W1035.1: interrupt results are internal turn boundaries — never terminal.
import { defineVerb, runCli } from "../lib/verb-kit.ts";

async function run(args: string[]): Promise<number> {
	const nativeBin = process.env.SUSPENDERS_CLAUDE_NATIVE_BIN;
	const sid = process.env.SUSPENDERS_SID;
	if (!nativeBin || !sid)
		throw new Error(
			"SUSPENDERS_CLAUDE_NATIVE_BIN and SUSPENDERS_SID are required",
		);
	const stream = claudeStreamArguments(args);
	const child = spawn(nativeBin, stream.args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, SUSPENDERS_CLAUDE_WAKE: "0" },
	});
	const abort = new AbortController();
	const control = new ClaudeControl(
		(frame) => {
			if (!child.stdin.write(`${JSON.stringify(frame)}\n`))
				child.stdout.pause();
		},
		// config-over-code knob: the interrupted-result wait (tests pin it low)
		Number(process.env.SUSPENDERS_CLAUDE_CONTROL_TIMEOUT_MS) || 10_000,
	);
	child.stdin.on("drain", () => child.stdout.resume());
	child.stdin.on("error", () => control.close());
	const emit = (frame: Record<string, unknown>) =>
		process.stdout.write(`${JSON.stringify(frame)}\n`);
	const lines = createInterface({ input: child.stdout });
	let closing = false;
	let finishTimer: ReturnType<typeof setTimeout> | undefined;
	lines.on("line", (line) => {
		if (!process.stdout.write(`${line}\n`)) {
			lines.pause();
			process.stdout.once("drain", () => lines.resume());
		}
		try {
			const frame = JSON.parse(line);
			control.receive(frame);
			// W1035.1: a result closing an interrupted turn is an internal
			// boundary — the injected turn follows in the same conversation, so
			// the end-of-session close waits for the NEXT result instead.
			if (
				frame.type === "result" &&
				!control.busy &&
				!control.interruptBoundaryResult
			) {
				clearTimeout(finishTimer);
				finishTimer = setTimeout(() => {
					if (!control.active && !control.busy) {
						closing = true;
						abort.abort();
						child.stdin.end();
					}
				}, 25);
			}
		} catch {
			// Non-JSON diagnostics remain visible, never become protocol input.
		}
	});
	child.stderr.pipe(process.stderr, { end: false });
	const stop = () => {
		closing = true;
		abort.abort();
		child.kill("SIGTERM");
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	const exited = new Promise<number>((resolve) => {
		child.on("error", (error) => {
			process.stderr.write(`${error.message}\n`);
			resolve(1);
		});
		child.on("close", (code) => resolve(code ?? 1));
	});
	const delivery = (async () => {
		while (!closing) {
			const claim = await waitForClaudeWakeClaim(sid, {
				consumer: "managed",
				abort: abort.signal,
			});
			if (!claim || closing) break;
			const wasActive = control.active;
			let state = wasActive ? "interrupted-and-injected" : "injected";
			// W1035.1.1: a native interrupt aborts in-flight tool calls — only an
			// explicitly urgent event may do that. Routine direct notes coalesce:
			// they wait for the current turn's boundary, then inject into the
			// same conversation without interrupting anything.
			if (wasActive && !claim.urgent) {
				try {
					await control.boundary(abort.signal);
					state = "boundary-injected";
				} catch {
					// Boundary timeout/abort: never abort the turn for a routine
					// note — requeue; the next wake replays the event.
					releaseClaudeWake(sid, undefined, "managed");
					emit({
						type: "fleet.claude.delivery",
						sid,
						state: "queued",
						reason: "routine note waits for the turn boundary",
						event: String(claim.id),
					});
					continue;
				}
				if (closing) break;
			}
			try {
				await control.steer(claim.text);
				// W1035.1: the watermark moves only after a proven injection.
				// W1035.1.1: proof waits for the injected turn's RESULT frame — a
				// native exit before it leaves the claim requeueable (replay).
				control.awaitResult().then(
					(delivered) => {
						if (!delivered) return;
						proveClaudeWake(sid, undefined, "managed", claim.id);
						emit({
							type: "fleet.claude.delivery",
							sid,
							state: "delivered",
							event: String(claim.id),
						});
					},
					() => {},
				);
				consumeClaudeWake(sid, undefined, "boundary");
				emit({
					type: "fleet.claude.delivery",
					sid,
					state,
					event: String(claim.id),
				});
			} catch (error) {
				// Interrupt refused/timeout: requeue — the durable event must not
				// sit behind an advanced watermark.
				releaseClaudeWake(sid, undefined, "managed");
				emit({
					type: "fleet.claude.delivery",
					sid,
					state: "queued",
					reason: String(error),
				});
				break;
			}
		}
	})();
	control.start(stream.prompt);
	const code = await exited;
	// W1035.1: a native exit with an unproven injection requeues the claim —
	// the resume path replays the directed event instead of it being lost
	// behind a watermark that never advanced. W1035.1.1: proof moved to the
	// injected turn's result, so this covers the whole inject→result window.
	releaseClaudeWake(sid, undefined, "managed");
	closing = true;
	abort.abort();
	control.close();
	clearTimeout(finishTimer);
	await delivery;
	process.off("SIGTERM", stop);
	process.off("SIGINT", stop);
	lines.close();
	return code;
}

if (import.meta.main)
	await runCli({
		prog: "claude-runtime",
		about: "claude-runtime — Fleet managed Claude stream-json runtime.",
		defaultVerb: "run",
		verbs: [
			defineVerb({
				name: "run",
				usage:
					"usage: claude-runtime run <native Claude -p prompt and options>",
				lax: true,
				run: (parsed) => run(parsed.rest),
			}),
		],
	});
