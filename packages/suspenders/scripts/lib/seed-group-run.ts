// scripts/lib/seed-group-run.ts — W1124.12.2 bounded seed execution with
// process-group cancellation. Replaces the W1124.12.1 spawnSync + native
// `timeout` shape, whose narrow contract (SIGTERM the DIRECT child only,
// descendants unproven, killTree absent from the installed API) left a
// captured sleep descendant alive. Bun.spawn({ detached: true }) puts the
// child in its own POSIX process group; the deadline cancels the WHOLE group
// (SIGTERM → bounded grace → SIGKILL) and verifies the verdict — kill(-pgid,
// 0) answering ESRCH — before anyone may claim the tree terminated. A normal
// exit makes no termination claim at all (verifiedDown: null).
import type { Subprocess } from "bun";

/** Stdout/stderr are captured but capped: a wedged, chatty seed must not
 *  grow unbounded memory. Past the cap the reader keeps DRAINING (a blocked
 *  writer must never wedge cleanup) and discards. */
const STREAM_CAP_BYTES = 256 * 1024;

const decodeCapped = async (
	stream: ReadableStream<Uint8Array>,
): Promise<string> => {
	const dec = new TextDecoder();
	let text = "";
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (text.length < STREAM_CAP_BYTES)
			text += dec.decode(value, { stream: true });
		// drain always, retain only the cap
	}
	text += dec.decode();
	return text.length <= STREAM_CAP_BYTES
		? text
		: text.slice(0, STREAM_CAP_BYTES);
};

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** W1124.12.2: every deadline/grace/reap timer is cancellable AND unref'd —
 *  a pending setTimeout keeps the Bun event loop alive, so a seed that exits
 *  before its deadline wedged the caller (dispatch-next hung minutes past
 *  "dispatched" on the still-pending 180s starter timer). unref lets the
 *  process die; cancel retires the loser's callback entirely. */
const bounded = (ms: number): { p: Promise<void>; cancel: () => void } => {
	let t: ReturnType<typeof setTimeout> | undefined;
	const p = new Promise<void>((r) => {
		t = setTimeout(r, ms);
		if (typeof t.unref === "function") t.unref();
	});
	return { p, cancel: () => clearTimeout(t) };
};

/** No live member of the child's process group (POSIX kill(-pgid, 0)). On
 *  win32 there is no group grammar — fall back to the direct pid probe and
 *  say so at the call site; the group verdict is POSIX-only truth. */
const isGroupAlive = (pgid: number): boolean => {
	try {
		if (process.platform === "win32") {
			process.kill(pgid, 0);
		} else {
			process.kill(-pgid, 0);
		}
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
};

export type SeedGroupResult = {
	/** Exit code; null when the child died to a signal and never exited. */
	code: number | null;
	/** The signal this runner delivered to cancel (SIGTERM/SIGKILL), else null. */
	cancelSignal: string | null;
	out: string;
	err: string;
	/** The deadline fired and bounded cancellation ran. */
	timedOut: boolean;
	/** Verified AFTER cancellation: kill(-pgid, 0) → ESRCH — no live group
	 *  member remained. null when nothing was cancelled: no termination claim
	 *  is made for a normal exit (the W1124.12.1 honesty gap, closed). */
	verifiedDown: boolean | null;
	/** Cancellation ran but bounded cleanup could NOT verify the group dead —
	 *  live descendants may remain. Surfaced, never hidden. */
	survivors: boolean;
};

export type SeedGroupOptions = {
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	/** SIGTERM → SIGKILL grace (default 2000ms). */
	termGraceMs?: number;
	/** Bounded verification budget after SIGKILL (default 3000ms). */
	reapBudgetMs?: number;
};

export const runSeedGroup = async (
	bin: string,
	args: string[],
	opts: SeedGroupOptions,
): Promise<SeedGroupResult> => {
	const termGraceMs = opts.termGraceMs ?? 2_000;
	const reapBudgetMs = opts.reapBudgetMs ?? 3_000;
	const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));
	const child: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
		[bin, ...args],
		{
			cwd: opts.cwd,
			env: opts.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// POSIX: the child LEADS its own process group — group signals reach
			// shell wrappers AND their descendants (the exact descendant gap the
			// spawnSync `timeout` shape could not prove).
			detached: true,
		},
	);
	const pgid = child.pid;
	const exitPromise: Promise<number> = child.exited;
	const pipes: Promise<[string, string]> = Promise.all([
		decodeCapped(child.stdout as ReadableStream<Uint8Array>),
		decodeCapped(child.stderr as ReadableStream<Uint8Array>),
	]);

	let timedOut = false;
	let cancelSignal: string | null = null;
	const killGroup = (sig: "SIGTERM" | "SIGKILL"): void => {
		try {
			if (process.platform === "win32") child.kill(sig);
			else process.kill(-pgid, sig);
			cancelSignal = sig;
		} catch {
			// group already gone — cancellation is then trivially done
		}
	};

	// deadline vs exit — one race, explicit winner; the loser's timer is
	// cancelled so nothing pends past the await (bounded())
	const deadline = bounded(timeoutMs);
	const winner = await Promise.race([
		exitPromise.then(() => "exit" as const),
		deadline.p.then(() => "deadline" as const),
	]);
	deadline.cancel();
	timedOut = winner === "deadline";
	if (timedOut) {
		killGroup("SIGTERM");
		const grace = bounded(termGraceMs);
		const exitedInGrace = await Promise.race([
			exitPromise.then(() => true),
			grace.p.then(() => false),
		]);
		grace.cancel();
		if (!exitedInGrace) killGroup("SIGKILL");
	}
	// bounded reap: reaped direct child + reparented/init-reaped descendants
	// (a zombie still answers kill(0) until reaped — poll until ESRCH or the
	// budget expires; only then report survivors)
	const reapDeadline = Date.now() + reapBudgetMs;
	let groupDown = !isGroupAlive(pgid);
	while (timedOut && !groupDown && Date.now() < reapDeadline) {
		await sleep(25);
		groupDown = !isGroupAlive(pgid);
	}
	const reapExit = bounded(reapBudgetMs);
	await Promise.race([exitPromise, reapExit.p]);
	reapExit.cancel();
	const reapPipes = bounded(reapBudgetMs);
	const [out, err] = await Promise.race([
		pipes,
		reapPipes.p.then(() => ["", ""] as [string, string]),
	]);
	reapPipes.cancel();

	return {
		code: timedOut ? null : child.exitCode,
		cancelSignal,
		out,
		err,
		timedOut,
		verifiedDown: timedOut ? groupDown : null,
		survivors: timedOut && !groupDown,
	};
};
