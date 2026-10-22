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

const DIRECT_KINDS = new Set([
	"NOTE",
	"consult",
	"consult.answer",
	"pause_requested",
	"resume_ready",
]);
const CONTROL_KINDS = new Set(["pause_requested", "resume_ready"]);
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
		claim: (consumer: string) => join(dir, `${key}.${consumer}.claim.json`),
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
		const pending = readSessionState<{ id?: number; kind?: string }>(
			files.pending,
		);
		const prev = pending?.id ?? 0;
		if (event.id <= prev) return false;
		// A generic notification cannot overwrite an unconsumed pause/resume.
		// Its durable inbox row remains queued and the control prompt reads it.
		const proved =
			readSessionState<{ id?: number }>(files.emitted("managed"))?.id ?? 0;
		if (
			pending?.kind &&
			CONTROL_KINDS.has(pending.kind) &&
			prev > proved &&
			!CONTROL_KINDS.has(event.kind)
		)
			return false;
		mkdirSync(files.dir, { recursive: true, mode: 0o700 });
		return writeSessionState(files.pending, {
			id: event.id,
			kind: event.kind,
			sid,
			text: `Fleet direct event #${event.id} (${event.kind}) from ${event.source}:\n${(event.payload ?? "null").slice(0, MAX_TEXT)}\nProcess this coordination now. Read all queued events with coord inbox --as ${sid}; acknowledge each only after acting.`,
		});
	} catch {
		return false;
	}
}

/** A hook may emit once per signal. This watermark is unrelated to inbox
 * acceptance: the full queue still has to be read and acted on by Claude.
 * W1035.1: an emission is claimed-then-proved — consumeClaudeWake moves the
 * event to a per-consumer claim file WITHOUT advancing the watermark; the
 * caller proves delivery via proveClaudeWake (the injected user frame was
 * accepted by a live conversation). releaseClaudeWake requeues an unproven
 * claim after a native exit/error, so the next consumer replays it instead
 * of the event being lost behind an advanced watermark. */
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
	const claimed = readSessionState<{ id?: number; pid?: number }>(
		files.claim(consumer),
	);
	// claimed and not yet proved (or released): wake-once semantics hold —
	// except a MANAGED claim whose owning process died (SIGKILL never runs the
	// release path): the next consumer replays the event.
	const claimedLive =
		typeof claimed?.id === "number" &&
		(consumer !== "managed" ||
			(typeof claimed.pid === "number" && pidAlive(claimed.pid)));
	if (claimedLive && claimed.id >= pending.id) return null;
	if (
		!writeSessionState(files.claim(consumer), {
			id: pending.id,
			pid: process.pid,
		})
	)
		return null;
	return pending.text;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Delivery proof: the watermark advances only here. */
export function proveClaudeWake(
	sid: string,
	home = process.env.HOME ?? "",
	consumer: Consumer = "native",
): boolean {
	if (!sid || !home) return false;
	const files = paths(sid, home);
	const claimed = readSessionState<{ id?: number }>(files.claim(consumer));
	const watermark = files.emitted(consumer);
	const emitted = readSessionState<{ id?: number }>(watermark)?.id ?? 0;
	if (typeof claimed?.id !== "number" || claimed.id <= emitted) return false;
	if (!writeSessionState(watermark, { id: claimed.id })) return false;
	releaseClaimFile(files.claim(consumer));
	return true;
}

/** Requeue an unproven claim: the pending id never moved, so the next
 * consumer replays the event instead of it being lost. */
export function releaseClaudeWake(
	sid: string,
	home = process.env.HOME ?? "",
	consumer: Consumer = "native",
): boolean {
	if (!sid || !home) return false;
	const files = paths(sid, home);
	const claimed = readSessionState<{ id?: number }>(files.claim(consumer));
	if (typeof claimed?.id !== "number") return false;
	releaseClaimFile(files.claim(consumer));
	return true;
}

function releaseClaimFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
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
