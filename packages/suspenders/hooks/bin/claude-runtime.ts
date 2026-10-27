#!/usr/bin/env bun
// Fleet owns this native stdin for the whole lane. Existing interactive
// Claude processes have no such channel and cannot be adopted by this file.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	ClaudeControl,
	claudeStreamArguments,
} from "../lib/executors/claude-control.ts";
import {
	claudeLaneState,
	claudePausePrompt,
	claudePauseProof,
	claudeResumePrompt,
	claudeWakeControl,
} from "../lib/executors/claude-pause.ts";
import {
	consumeClaudeWake,
	proveClaudeWake,
	releaseClaudeWake,
	waitForManagedClaudeWakeClaim,
} from "../lib/executors/claude-wake.ts";
// W1035.1: interrupt results are internal turn boundaries — never terminal.
import { defineVerb, runCli } from "../lib/verb-kit.ts";
import { restartBootstrap } from "../lib/executors/claude-restart.ts";

async function run(args: string[]): Promise<number> {
	const nativeBin = process.env.SUSPENDERS_CLAUDE_NATIVE_BIN;
	const sid = process.env.SUSPENDERS_SID;
	if (!nativeBin || !sid)
		throw new Error(
			"SUSPENDERS_CLAUDE_NATIVE_BIN and SUSPENDERS_SID are required",
		);
	const stream = claudeStreamArguments(args);
	const restart = process.env.SUSPENDERS_CLAUDE_RESTART_JOURNAL
		? restartBootstrap(process.env.SUSPENDERS_CLAUDE_RESTART_JOURNAL, sid, args)
		: null;
	if (
		restart &&
		(await claudePauseProof(sid))?.checkpoint !== restart.checkpoint
	)
		throw new Error("Restart pause checkpoint is no longer verified");
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
	let pauseMode: "running" | "checkpointing" | "paused" | "resuming" = restart
		? "paused"
		: "running";
	let pauseCheckpoint: string | null = restart?.checkpoint ?? null;
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
			if (
				restart &&
				frame.type === "system" &&
				frame.subtype === "init" &&
				frame.session_id !== restart.nativeSession
			) {
				emit({ type: "fleet.claude.restart", state: "identity-refused", sid });
				child.kill("SIGTERM");
				return;
			}
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
			const claim = await waitForManagedClaudeWakeClaim(sid, {
				abort: abort.signal,
				onRetry: (reason, attempt) =>
					emit({
						type: "fleet.claude.watcher",
						sid,
						state: "rearming",
						reason,
						attempt,
					}),
			});
			if (!claim || closing) break;
			const { text } = claim;
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
			let state = wasActive ? "interrupted-and-injected" : "injected";
			// W1035.1.1: a native interrupt aborts in-flight tool calls — only an
			// explicitly urgent event (or a pause/resume control) may do that.
			// Routine direct notes coalesce: they wait for the current turn's
			// boundary, then inject into the same conversation.
			if (wasActive && !claim.urgent && !kind) {
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
			const previousPauseMode = pauseMode;
			let refusedResume = false;
			try {
				if (kind === "resume_ready") {
					await verifyingPause;
					const proof = await claudePauseProof(sid, "RESUME_READY");
					// W1173 checkpoint fence: a resume is valid only against the
					// EXACT checkpoint this runtime proved when the canonical PAUSED
					// landed.
					if (
						pauseMode !== "paused" ||
						!proof ||
						proof.checkpoint !== pauseCheckpoint
					) {
						refusedResume = true;
						throw new Error(
							"resume unsupported until canonical PAUSED checkpoint proof and matching RESUME_READY exist",
						);
					}
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
				// W1035.1.1: a direct note's proof waits for the injected turn's
				// RESULT frame — a native exit before it leaves the claim
				// requeueable (replay). Pause/resume controls prove on injection.
				if (kind) proveClaudeWake(sid, undefined, "managed", claim.id);
				else
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
				pauseMode = previousPauseMode;
				if (refusedResume) {
					// W1209: a fence refusal is terminal for THIS control only, not
					// for the delivery loop. Keep the claim: consumeClaudeWake
					// blocks re-consumption of the same id while this process
					// lives, so rearming never busy-retries the refused control.
					// The next control (a canonical pause, then a fresh resume)
					// overwrites the pending slot with a higher id and is consumed
					// normally. No watermark movement — it advances only after a
					// proven injection (W1035.1); runtime exit releases the claim
					// so a fresh runtime re-evaluates the refused control against
					// its own pause state.
					emit({
						type: "fleet.claude.delivery",
						sid,
						state: "refused",
						event: text.match(/^Fleet direct event #(\d+)/)?.[1] ?? null,
						reason: String(error),
					});
					continue;
				}
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
	if (!restart) control.start(stream.prompt);
	else
		emit({
			type: "fleet.claude.restart",
			state: "waiting-paused",
			id: restart.id,
			sid,
			checkpoint: restart.checkpoint,
		});
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
				name: "restart-verify",
				usage:
					"usage: claude-runtime restart-verify --sid <sid> --fleet <root> — verify native continuation and accepted interrupt",
				flags: ["--sid", "--fleet"],
				reqFlags: ["--sid", "--fleet"],
				run: async (parsed) => {
					const { verifyManagedClaudeRestart } = await import(
						"../../scripts/lib/claude-restart-operation.ts"
					);
					console.log(
						JSON.stringify(
							verifyManagedClaudeRestart(
								parsed.flag("--fleet") ?? "",
								parsed.flag("--sid") ?? "",
							),
						),
					);
				},
			}),
			defineVerb({
				name: "restart",
				usage:
					"usage: claude-runtime restart --sid <sid> --fleet <root> [--apply] — checkpointed managed restart; default previews",
				flags: ["--sid", "--fleet"],
				reqFlags: ["--sid", "--fleet"],
				switches: ["--apply"],
				run: async (parsed) => {
					const { restartManagedClaude } = await import(
						"../../scripts/lib/claude-restart-operation.ts"
					);
					const result = await restartManagedClaude(
						parsed.flag("--fleet") ?? "",
						parsed.flag("--sid") ?? "",
						parsed.rest.includes("--apply"),
					);
					console.log(
						JSON.stringify({
							phase: result.phase,
							sid: result.snapshot.sid,
							nativeSession: result.snapshot.nativeSession,
							checkpoint: result.snapshot.checkpoint,
							newWrapper: result.newWrapper ?? null,
						}),
					);
				},
			}),
			defineVerb({
				name: "run",
				usage:
					"usage: claude-runtime run <native Claude -p prompt and options>",
				lax: true,
				run: (parsed) => run(parsed.rest),
			}),
		],
	});
