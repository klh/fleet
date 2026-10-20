#!/usr/bin/env bun
// Fleet owns this native stdin for the whole lane. Existing interactive
// Claude processes have no such channel and cannot be adopted by this file.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ClaudeControl, claudeStreamArguments } from "../lib/claude-control.ts";
import { consumeClaudeWake, waitForClaudeWake } from "../lib/claude-wake.ts";
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
	const control = new ClaudeControl((frame) => {
		if (!child.stdin.write(`${JSON.stringify(frame)}\n`)) child.stdout.pause();
	});
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
			if (frame.type === "result" && !control.busy) {
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
			const text = await waitForClaudeWake(sid, {
				consumer: "managed",
				abort: abort.signal,
			});
			if (!text || closing) break;
			const wasActive = control.active;
			try {
				await control.steer(text);
				consumeClaudeWake(sid, undefined, "boundary");
				emit({
					type: "fleet.claude.delivery",
					sid,
					state: wasActive ? "interrupted-and-injected" : "injected",
					event: text.match(/^Fleet direct event #(\d+)/)?.[1] ?? null,
				});
			} catch (error) {
				emit({
					type: "fleet.claude.delivery",
					sid,
					state: "queued",
					reason: String(error),
				});
			}
		}
	})();
	control.start(stream.prompt);
	const code = await exited;
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
