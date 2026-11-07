// W2545: transient transport-terminal classification for the managed Claude
// runtime. Evidence (W2267.3, 2026-11-02): a native result frame can carry
// subtype "success" while is_error=true and api_error_status=503 — a JSON
// subtype success does NOT mean work completed. The runtime must classify the
// frame BEFORE its normal idle finish, preserve the conversation/claim, and
// retry bounded; everything here is pure so tests pin it in-process.

export type TransientVerdict = {
	/** HTTP-ish status extracted from the frame, when any is present. */
	status?: number;
	/** Server-directed cooldown (Retry-After seconds) when the frame carries one. */
	retryAfterMs?: number;
	/** Short human-readable cause recorded in frames and the capsule. */
	detail: string;
};

/** Explicitly transient transport statuses. Absence of evidence is NOT
 * transience: an unknown is_error result is never retried (quota, auth and
 * invalid-input failures must not be blindly resubmitted). */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Substrings that make an otherwise-transient-looking result fatal. */
const FATAL_MARKERS =
	/(?:quota|usage limit|rate limit exceeded.*plan|invalid api key|unauthorized|forbidden|billing|insufficient|invalid_request|permission denied)/i;
const STATUS_IN_TEXT = /\b(40[089]|42[59]|5\d{2})\b/;

const asText = (value: unknown): string =>
	typeof value === "string" ? value : "";

/** Classify a native terminal result frame. Non-null means explicitly
 * transient (retry once, bounded); null means finish normally — including
 * every fatal shape (400/401/403, quota/auth/invalid-input) and every
 * error-free completion. */
export function classifyTransientResult(
	frame: Record<string, unknown>,
): TransientVerdict | null {
	if (frame.type !== "result" || frame.is_error !== true) return null;
	const text = `${asText(frame.result)} ${asText(frame.error_message)}`;
	if (FATAL_MARKERS.test(text)) return null;
	const candidates = [frame.api_error_status, frame.status];
	let status: number | undefined;
	for (const candidate of candidates) {
		const value = Number(candidate);
		if (Number.isInteger(value) && TRANSIENT_STATUSES.has(value)) {
			status = value;
			break;
		}
	}
	if (status === undefined) {
		// W2267.3 evidence shape: subtype "success" + is_error + a status only
		// present in the message text ("API Error (503): ...").
		const inText = STATUS_IN_TEXT.exec(text)?.[1];
		if (inText) status = Number(inText);
	}
	if (status === undefined || !TRANSIENT_STATUSES.has(status)) return null;
	const retryAfter = Number(frame.retry_after);
	return {
		status,
		retryAfterMs:
			Number.isFinite(retryAfter) && retryAfter > 0
				? Math.round(retryAfter * 1000)
				: undefined,
		detail: `api_error status ${status}${asText(frame.terminal_reason) ? ` (${asText(frame.terminal_reason)})` : ""}: ${asText(frame.result).slice(0, 200) || asText(frame.error_message).slice(0, 200)}`,
	};
}

export type TransientKnobs = {
	maxAttempts: number;
	baseMs: number;
	maxMs: number;
};

export type TransientAbandonReceipt = {
	checkpoint: string;
	capsule: "written" | "unavailable";
};

/** Persist the resumable disposition WITHOUT spending a model inference
 * call: the runtime itself banks the capsule through the coord CLI
 * (checkpoint = worktree HEAD, or "none" when git is unavailable). The
 * wrapper then exits EX_TEMPFAIL — retryable transport, never a product
 * failure, never silently RUNNING. */
export async function bankTransientAbandonment(
	sid: string,
	detail: string,
	attempt: number,
	opts: {
		cwd: string;
		env: Record<string, string | undefined>;
		/** N3: per-child bound so a hung coord capsule (or git) child can
		 * never block the runtime's SIGTERM handling. */
		timeoutMs?: number;
	},
	coordCli: string,
	execPath = process.execPath,
	spawnSync: typeof Bun.spawnSync = Bun.spawnSync,
): Promise<TransientAbandonReceipt> {
	// One bounded child pass: a refused/killed/timeout child degrades to
	// capsule "unavailable" (the truthful receipt) instead of hanging the
	// exit path.
	const run = (
		cmd: string[],
		o: {
			cwd: string;
			env?: Record<string, string | undefined>;
			stderr?: "ignore";
		},
	) =>
		spawnSync(cmd, {
			cwd: o.cwd,
			...(o.env !== undefined ? { env: o.env } : {}),
			stdout: "pipe",
			stderr: o.stderr ?? "pipe",
			...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
		});
	let checkpoint = "none";
	const git = run(["git", "rev-parse", "HEAD"], {
		cwd: opts.cwd,
		stderr: "ignore",
	});
	const head = git.stdout.toString().trim();
	if (git.exitCode === 0 && /^[a-f0-9]{40}$/.test(head)) checkpoint = head;
	const write = run(
		[
			execPath,
			coordCli,
			"capsule",
			"set",
			"--as",
			sid,
			`--checkpoint=${checkpoint}`,
			`--done=transport-blocked after ${attempt} attempt(s): ${detail}`,
			"--next=lane preserved mid-item; native conversation and worktree intact; re-dispatch or resume when the gateway recovers",
		],
		{ cwd: opts.cwd, env: opts.env },
	);
	return {
		checkpoint,
		capsule: write.exitCode === 0 ? "written" : "unavailable",
	};
}

/** Config-over-code knobs (KNOB_REGISTRY rows land in the same commit).
 * Tests pin them low; production defaults bound a whole episode to at most
 * maxAttempts × maxMs of waiting. */
export function parseTransientKnobs(env: {
	[key: string]: string | undefined;
}): TransientKnobs {
	const positive = (value: string | undefined, fallback: number): number => {
		const n = Number(value);
		return Number.isInteger(n) && n > 0 ? n : fallback;
	};
	return {
		maxAttempts: positive(env.SUSPENDERS_CLAUDE_TRANSIENT_MAX_ATTEMPTS, 6),
		baseMs: positive(env.SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS, 2000),
		maxMs: Math.max(
			positive(env.SUSPENDERS_CLAUDE_TRANSIENT_BASE_MS, 2000),
			positive(env.SUSPENDERS_CLAUDE_TRANSIENT_MAX_MS, 300_000),
		),
	};
}

/** Bounded jittered backoff for attempt n (1-based): exponential cap with
 * ±25% jitter, never above maxMs. A server-directed retryAfter replaces the
 * computed delay (still capped) without jitter. */
export function transientBackoffMs(
	attempt: number,
	knobs: TransientKnobs,
	retryAfterMs?: number,
	random: () => number = Math.random,
): number {
	if (retryAfterMs !== undefined) return Math.min(retryAfterMs, knobs.maxMs);
	const cap = Math.min(knobs.maxMs, knobs.baseMs * 2 ** (attempt - 1));
	return Math.max(1, Math.round(cap * (0.75 + 0.5 * random())));
}

/** The one continuation turn injected after a backoff window. It rides the
 * ordinary control channel (no second state machine): the native session's
 * transcript already holds the completed tool calls, so this explicitly
 * forbids redoing them. */
export function transientContinuationPrompt(
	attempt: number,
	knobs: TransientKnobs,
	verdict: TransientVerdict,
): string {
	return (
		`FLEET_TRANSPORT_RETRY (attempt ${attempt}/${knobs.maxAttempts}): your previous turn ended with a transient gateway error (${verdict.detail}). ` +
		"The transport block was not a product failure and no work was lost. Continue the task from where the previous turn stopped. " +
		"Do not redo already-completed steps, re-run succeeded tool calls, or restart the work from scratch."
	);
}
