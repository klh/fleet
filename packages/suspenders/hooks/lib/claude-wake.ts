// Native Claude asyncRewake bridge. A subscriber signal is only a queued
// wake request; exit 2 from a Claude-owned hook is what reaches the harness.
// Neither path acknowledges the durable Fleet event. Ordinary broadcasts
// never signal this bridge, regardless of words in their payload.
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CoordDirectEvent } from "./codex-steer.ts";
import { readSessionState, writeSessionState } from "./session-state.ts";

const DIRECT_KINDS = new Set(["NOTE", "consult", "consult.answer"]);
const MAX_TEXT = 16_384;
const WAIT_MS = 86_400_000;
type Consumer = "native" | "boundary" | "managed";

function paths(sid: string, home: string) {
	const dir = join(home, ".claude-insights", "coord-claude-wake");
	const key = createHash("sha256").update(sid).digest("hex");
	return {
		dir,
		pending: join(dir, `${key}.json`),
		emitted: (consumer: string) => join(dir, `${key}.${consumer}.json`),
		lock: (consumer: string) => join(dir, `${key}.${consumer}.watcher.json`),
	};
}

/** Queue a native wake request. true means written, never model delivery. */
export function signalClaudeDirectEvent(
	event: CoordDirectEvent,
	sid: string,
	home = process.env.HOME ?? "",
): boolean {
	if (!home || !sid || event.target !== sid || !DIRECT_KINDS.has(event.kind))
		return false;
	try {
		const files = paths(sid, home);
		const prev = readSessionState<{ id?: number }>(files.pending)?.id ?? 0;
		if (event.id <= prev) return false;
		mkdirSync(files.dir, { recursive: true, mode: 0o700 });
		return writeSessionState(files.pending, {
			id: event.id,
			sid,
			text: `Fleet direct event #${event.id} (${event.kind}) from ${event.source}:\n${(event.payload ?? "null").slice(0, MAX_TEXT)}\nProcess this coordination now. Read all queued events with coord inbox --as ${sid}; acknowledge each only after acting.`,
		});
	} catch {
		return false;
	}
}

/** A hook may emit once per signal. This watermark is unrelated to inbox
 * acceptance: the full queue still has to be read and acted on by Claude. */
export function consumeClaudeWake(
	sid: string,
	home = process.env.HOME ?? "",
	consumer: Consumer = "native",
): string | null {
	if (!sid || !home) return null;
	const files = paths(sid, home);
	const pending = readSessionState<{
		id?: number;
		sid?: string;
		text?: string;
	}>(files.pending);
	const watermark = files.emitted(consumer);
	const emitted = readSessionState<{ id?: number }>(watermark)?.id ?? 0;
	if (
		pending?.sid !== sid ||
		typeof pending.id !== "number" ||
		typeof pending.text !== "string" ||
		pending.id <= emitted
	)
		return null;
	if (!writeSessionState(watermark, { id: pending.id })) return null;
	return pending.text;
}

function release(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
}

function lockWatcher(path: string): boolean {
	const previous = readSessionState<{ pid?: number }>(path);
	if (typeof previous?.pid === "number") {
		try {
			process.kill(previous.pid, 0);
			return false;
		} catch {
			release(path); // a timed-out or killed native hook left a stale lock
		}
	}
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify({ pid: process.pid }));
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

/** Filesystem notifications, not a poll loop. Every later hook invocation
 * re-arms after an emission; simultaneous invocations exit quietly. */
export async function waitForClaudeWake(
	sid: string,
	opts: {
		home?: string;
		timeoutMs?: number;
		consumer?: Consumer;
		abort?: AbortSignal;
	} = {},
): Promise<string | null> {
	const home = opts.home ?? process.env.HOME ?? "";
	const consumer = opts.consumer ?? "native";
	if (
		!home ||
		!sid ||
		opts.abort?.aborted ||
		(consumer !== "managed" && process.env.SUSPENDERS_CLAUDE_WAKE === "0")
	)
		return null;
	const files = paths(sid, home);
	const lock = files.lock(consumer);
	let owned = false;
	try {
		mkdirSync(files.dir, { recursive: true, mode: 0o700 });
		owned = lockWatcher(lock);
		if (!owned) return null;
		return await new Promise<string | null>((resolve) => {
			let settled = false;
			const finish = (text: string | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				watcher.close();
				opts.abort?.removeEventListener("abort", onAbort);
				resolve(text);
			};
			const check = () => {
				const text = consumeClaudeWake(sid, home, consumer);
				if (text) finish(text);
			};
			const onAbort = () => finish(null);
			const watcher = watch(files.dir, check);
			watcher.on("error", () => finish(null));
			const timer = setTimeout(() => finish(null), opts.timeoutMs ?? WAIT_MS);
			opts.abort?.addEventListener("abort", onAbort, { once: true });
			check(); // covers events queued before this watcher was armed
		});
	} catch {
		return null;
	} finally {
		// Only the process that owns the lock can remove it.
		if (owned && readSessionState<{ pid?: number }>(lock)?.pid === process.pid)
			release(lock);
	}
}
