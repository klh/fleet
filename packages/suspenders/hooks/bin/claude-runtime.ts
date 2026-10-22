#!/usr/bin/env bun
// Fleet owns this native stdin for the whole lane. Existing interactive
// Claude processes have no such channel and cannot be adopted by this file.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ClaudeControl, claudeStreamArguments } from "../lib/claude-control.ts";
import {
	claudeLaneState,
	claudePausePrompt,
	claudePauseProof,
	claudeResumePrompt,
	claudeWakeControl,
} from "../lib/claude-pause.ts";
import {
	consumeClaudeWake,
	proveClaudeWake,
	releaseClaudeWake,
	waitForClaudeWake,
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
	let pauseMode: "running" | "checkpointing" | "paused" | "resuming" =
		"running";
	let pauseCheckpoint: string | null = null;
	let verifyingPause: Promise<void> | undefined;
	let finishTimer: ReturnType<typeof setTimeout> | undefined;
	const finishWhenIdle = () => {
		clearTimeout(finishTimer);
		finishTimer = setTimeout(() => {
			if (!control.active && !control.busy && pauseMode === "running") {
				closing = true;
				abort.abort();
				child.stdin.end();
			}
		}, 25);
	};
	lines.on("line", (line) => {
		if (!process.stdout.write(`${line}\n`)) {
			lines.pause();
			process.stdout.once("drain", () => lines.resume());
		}
		try {
			const frame = JSON.parse(line);
			control.receive(frame);
			if (
				frame.type === "result" &&
				!control.busy &&
				!control.interruptBoundaryResult &&
				pauseMode === "checkpointing"
			) {
				verifyingPause = (async () => {
					const proof = await claudePauseProof(sid);
					if (proof) {
						pauseMode = "paused";
						pauseCheckpoint = proof.checkpoint;
					}
					emit({
						type: "fleet.claude.pause",
						sid,
						state: proof ? "paused" : "checkpoint-unconfirmed",
						checkpoint: proof?.checkpoint ?? null,
					});
				})();
			}
			if (
				frame.type === "result" &&
				!control.busy &&
				!control.interruptBoundaryResult &&
				pauseMode === "resuming"
			) {
				void (async () => {
					const resumed = (await claudeLaneState(sid)) === "RUNNING";
					if (resumed) {
						pauseMode = "running";
						finishWhenIdle();
					}
					emit({
						type: "fleet.claude.pause",
						sid,
						state: resumed ? "resumed" : "resume-unconfirmed",
					});
				})();
			}
			// W1035.1: a result closing an interrupted turn is an internal
			// boundary — the injected turn follows in the same conversation, so
			// the end-of-session close waits for the NEXT result instead.
			if (
				frame.type === "result" &&
				pauseMode === "running" &&
				!control.busy &&
				!control.interruptBoundaryResult
			) {
				finishWhenIdle();
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
			const text = await waitForClaudeWake(sid, {
				consumer: "managed",
				abort: abort.signal,
			});
			if (!text || closing) break;
			const kind = claudeWakeControl(text);
			if ((pauseMode === "checkpointing" || pauseMode === "paused") && !kind) {
				// Checkpointing and PAUSED remain silent. RESUMING is an active
				// native turn, so direct messages use the ordinary proven interrupt.
				// Keep the unproved claim: no busy-spin and no fake delivery. A
				// subsequent resume has a higher event ID and wakes this watcher.
				emit({
					type: "fleet.claude.delivery",
					sid,
					state: "deferred-while-paused",
				});
				continue;
			}
			const wasActive = control.active;
			const previousPauseMode = pauseMode;
			try {
				if (kind === "resume_ready") {
					await verifyingPause;
					const proof = await claudePauseProof(sid, "RESUME_READY");
					if (
						pauseMode !== "paused" ||
						!proof ||
						proof.checkpoint !== pauseCheckpoint
					)
						throw new Error(
							"resume unsupported until canonical PAUSED checkpoint proof and matching RESUME_READY exist",
						);
				}
				if (kind === "pause_requested") pauseMode = "checkpointing";
				await control.steer(
					kind === "pause_requested"
						? claudePausePrompt(sid, text)
						: kind === "resume_ready"
							? claudeResumePrompt(sid, text)
							: text,
				);
				if (kind === "resume_ready") pauseMode = "resuming";
				// W1035.1: the watermark moves only after a proven injection.
				proveClaudeWake(sid, undefined, "managed");
				consumeClaudeWake(sid, undefined, "boundary");
				emit({
					type: "fleet.claude.delivery",
					sid,
					state: wasActive ? "interrupted-and-injected" : "injected",
					event: text.match(/^Fleet direct event #(\d+)/)?.[1] ?? null,
				});
			} catch (error) {
				pauseMode = previousPauseMode;
				// Interrupt refused/timeout: requeue — the durable event must not
				// sit behind an advanced watermark.
				releaseClaudeWake(sid, undefined, "managed");
				emit({
					type: "fleet.claude.delivery",
					sid,
					state: kind ? "unsupported" : "queued",
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
	// behind a watermark that never advanced.
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
